# @vault-sync/mcp-server

A remote **MCP server** that exposes one synced vault to MCP clients (Claude Code, Claude Desktop,
Gemini CLI) over the internet: search / list / read / write / delete notes and files. Runs as a
single AWS **Lambda** behind a **Function URL**; auth is a static bearer token (phase 0).

- **Why it's shaped this way:** [MCP Server Design.md](../../MCP%20Server%20Design.md) (infra choice,
  auth phasing, cost, out-of-scope list).
- **The sync protocol it speaks:** [IMPLEMENTATION.md](../../IMPLEMENTATION.md) §2.
- **Install:** `scripts/install/05-create-mcp-server.sh` (see `scripts/install/README.md`).
- **Connect a client (user-facing howto):** [MCP.md](../../MCP.md).

## Design

### A third protocol client, stateless

The vault's truth in S3 is the **delta journal ⊕ snapshot**, not the `files/` prefix — a naive S3
reader would see deleted files (tombstones live only in the journal) and a naive writer would be
invisible to the other legs (no delta). So this server is a **third client** of the shared protocol
in `packages/core`, next to git-sync and the Obsidian plugin:

- **Read** — fold `snapshot.json.gz ⊕ listDeltasSince(snapshotRev)` per request (core
  `loadRemoteState`). Content is fetched **pinned to the journal-recorded `s3VersionId`**: files
  are PUT before their delta, so the latest object version may belong to a write whose delta
  hasn't landed yet.
- **Write** — PUT `files/<path>` first (the journal never references a missing object), then
  CAS-append one delta with `by: "mcp"` (`If-None-Match: *`, 412-retry). A constant writer id is
  enough: the other legs echo-suppress only their *own* id.
- **Delete** — journal-only tombstone; the `files/` object stays (matches both sync legs; S3
  versioning keeps history).
- **Conflicts** — none resolved here. A write is a fresh authoritative edit; if a device edited the
  same note concurrently, *that device's* next pull three-way-union-merges against the versioned
  base, exactly as between the existing legs.

Unlike the plugin (cursor + per-file state) and git-sync (`.sync/state.json`), this client keeps
**nothing** between requests — no cursor, no resync concept — which is what makes a stateless
Lambda the right runtime.

### Search without an index

There is none — `search` folds remote state and **reads** candidate notes, newest first
(`vault.ts`). That is affordable for a personal vault and honest about its limits: every scan runs
under four budgets — result count, files, bytes, and a 20 s wall clock — and a result that hit one
says `truncated: true` with the `reason`, rather than timing out with nothing. Notes only: other
files have no text to grep, and `list_files` finds them by path. Path matches cost nothing (they
need no content), so they are collected first and never spend budget.

One fold per search, not per note: content reads are pinned to the entry the fold already produced
(`readAt`), the same version-pinning `read` uses. The function runs at 60 s / 1024 MB to leave
headroom around the 20 s budget.

### Path policy (POC)

All tools reject traversal/absolute/malformed paths and **hide every dot-path** (`.obsidian/`,
`.sync/`, `.git*`, …): the MCP surface is vault *content* only. This keeps the exclusion matrix
(IMPLEMENTATION.md §6) entirely out of play — the server also never tombstones anything it didn't
explicitly delete, so it cannot fight the other legs. "Note" = path ending `.md`; everything else
is a "file".

### Transport

Streamable HTTP in **stateless JSON mode**: each POST to `/mcp` carries one JSON-RPC message and
gets a plain JSON response (202 for notifications); no SSE stream, no session, no JSON-RPC batches.
A fresh `McpServer` + `SingleShotTransport` pair is built per invocation — `transport.ts` is a
~40-line custom `Transport` that delivers the message and resolves with the reply, avoiding an
express/serverless-http stack just to satisfy the SDK's Node HTTP transport.

### Auth

**Phase 0 (current):** `Authorization: Bearer <token>` compared constant-time against the
`MCP_BEARER_TOKEN` env var (`auth.ts`). Works from any client that can set headers (Claude Code,
Claude Desktop). claude.ai web connectors cannot — they need real OAuth.

**Phase 1 (planned):** Cognito user pool as the OAuth 2.1 issuer; the handler grows
`/.well-known/oauth-protected-resource` (RFC 9728), `WWW-Authenticate` pointers on 401, a
`POST /register` DCR shim returning the pre-registered client id (Cognito lacks RFC 7591), and JWT
validation via `aws-jwt-verify`. See the design doc §4.

## Modules

| File | Role |
|---|---|
| `src/vault.ts` | The protocol client: fold-read, version-pinned `read`, `write` (PUT → CAS delta), tombstone `remove`, budgeted `search`, path policy. Pure against `StorageAdapter`. |
| `src/mcp.ts` | `McpServer` construction + the tools, including the ChatGPT-shaped `search`/`fetch` pair. |
| `src/transport.ts` | `SingleShotTransport` — one message per invocation. |
| `src/auth.ts` | Phase-0 bearer check (sha256 + `timingSafeEqual`). |
| `src/presign.ts` | Presigned S3 GET for `get_file`, pinned to the recorded object version. |
| `src/handler.ts` | Lambda Function URL entry: routing, auth gate, message validation, lazy env init (cached for warm containers). |
| `esbuild.config.mjs` | Bundle → `dist/index.mjs` (node22 ESM) + `dist/mcp-server.zip` (Lambda package, handler `index.handler`). |

The S3 `StorageAdapter` is imported from `@vault-sync/git-sync` (AWS SDK v3); `core` stays pure.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_notes` | `query`, `dir?`, `regex?`, `caseSensitive?`, `maxResults?`, `maxMatchesPerFile?`, `pathOnly?` | `{hits:[{path, size, mtime, pathMatch, matches:[{line,text}]}], scanned, candidates, truncated, reason?}` |
| `search` / `fetch` | `query` / `id` | ChatGPT-connector shape: `{results:[{id,title,url,snippet}]}` and `{id,title,text,url,metadata}` — same engine as `search_notes` / `get_note` |
| `list_notes` / `list_files` | `dir?`, `recursive?` (default true) | `[{path, size, mtime}]` — `.md` vs non-`.md` |
| `get_note` | `path` | `{path, text, hash, size, mtime}` |
| `save_note` | `path`, `text` | `{rev, hash}` — create or overwrite (LWW; device merges handle races) |
| `remove_note` | `path` | `{rev}` |
| `get_file` | `path` | `{url, expiresInSeconds: 300, size, mtime}` — presigned GET; bytes never transit Lambda |
| `save_file` | `path`, `base64` | `{rev, hash}` — max 4 MB (Lambda's 6 MB request cap ÷ base64 inflation) |
| `remove_file` | `path` | `{rev}` |

Errors (not found, excluded path, too large, bad base64) come back as MCP tool errors.

## Configuration (Lambda env)

| Var | Meaning |
|---|---|
| `BUCKET` | S3 bucket (required) |
| `PREFIX` | vault key prefix, must equal the other legs' prefix (e.g. `<user>/vaults/<vault>/`) |
| `MCP_BEARER_TOKEN` | phase-0 shared secret (required) |

`AWS_REGION` is provided by the Lambda runtime itself. IAM: the execution role needs
get/put/delete/list scoped to the prefix — `scripts/install/05` provisions exactly that.

## Build · test · deploy

```bash
npm test                                       # includes this package's suites
npm run typecheck
npm run build:mcp                              # → dist/index.mjs + dist/mcp-server.zip
scripts/install/05-create-mcp-server.sh --vault <name>       # full provision / reconcile
AWS_REGION=<r> MCP_FUNCTION=<fn> npm run deploy -w @vault-sync/mcp-server   # code-only redeploy
```

Tests follow the house pattern — no cloud in the loop: `vault.ts` and `search` run against core's
`InMemoryStorage` (budgets included — `timeBudgetMs` is injectable so the truncation path is
exercised in real time), the tools end-to-end through the SDK `Client` + `InMemoryTransport`, the
handler (HTTP/auth/transport) invoked directly.

## Connecting a client

Per-client instructions (Claude Code, Claude Desktop, Gemini CLI, and the state of the OAuth-only
web surfaces) live in **[MCP.md](../../MCP.md)**. The short form:

```bash
claude mcp add --transport http vault-<name> "https://<function-url>/mcp" \
  --header "Authorization: Bearer <token>"
```

The install script prints this command with the real URL, reading the token from
`scripts/install/.secrets/mcp-<user>-<vault>.json` so it never lands in your shell history.

It also publishes `<prefix>mcp.json` — endpoint, region, function name, tool list, **no secret** —
at the vault prefix root, outside everything the sync protocol reads. The Obsidian plugin's
"AI assistants (MCP)" settings section reads it, so any device can show the endpoint, probe it, and
emit a ready-to-paste config without having run the installer (IMPLEMENTATION.md §4.15).
