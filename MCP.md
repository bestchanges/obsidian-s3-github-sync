---
title: Connect an AI assistant to your vault (MCP)
tags: [howto, mcp, setup]
---

# Connect an AI assistant to your vault (MCP)

Your vault can expose itself to AI assistants as a **remote MCP server**: one AWS Lambda, one HTTPS
URL, list/read/write/delete over the same delta-journal protocol the Obsidian plugin and git-sync
speak. An assistant that connects to it sees the live vault — not a copy — and every edit it makes
lands on your devices the same way an edit from another device does.

This is the **setup guide**. Why it is built this way: [MCP Server Design.md](MCP%20Server%20Design.md).
What each module does: [packages/mcp-server/README.md](packages/mcp-server/README.md).

---

## 1. Which clients work today

| Client | How it authenticates | Status |
|---|---|---|
| **Claude Code** | `Authorization` header | ✅ works |
| **Claude Desktop** | `Authorization` header in the config file | ✅ works |
| **Gemini CLI** | `Authorization` header in `settings.json` | ✅ works |
| **claude.ai** (web, mobile) | OAuth 2.1 — cannot send a static header | ⏳ needs the OAuth mode |
| **ChatGPT** (developer mode) | OAuth 2.1 — no header or API-key option | ⏳ needs the OAuth mode |
| **Gemini app** (Spark custom apps) | OAuth 2.1 / DCR | ⏳ needs the OAuth mode |

The split is not about the vault — it is about the clients. Anything that runs on your machine can
attach a bearer token to each request; the hosted chat surfaces paste a *URL* into a connector
dialog and then run an OAuth flow against it. The server currently speaks bearer only, so the
bottom three are pending the OAuth work (design: [MCP Server Design.md](MCP%20Server%20Design.md) §4).

---

## 2. Install the server for a vault

Once per vault, from a machine with AWS credentials:

```bash
cd scripts/install
./05-create-mcp-server.sh --vault <name>       # e.g. --vault gsd2
```

Idempotent — re-run it any time to redeploy the current build and reconcile config. It provisions an
execution role, a Lambda, a public Function URL (auth is enforced *inside* the handler, not by the
URL), and a bearer token, then:

- **publishes `mcp.json`** to the vault's S3 prefix — endpoint, region, function name, tool list.
  No secret in it. This is what makes the server discoverable from every device;
- **writes `.secrets/mcp-<user>-<vault>-connect.md`** — the same per-client snippets as below, with
  your real token filled in (mode 600, gitignored);
- **verifies** the deployment with a real MCP handshake before it declares success.

`--rotate-token` mints a new token and invalidates the old one. `--dry-run` shows what it would do.

---

## 3. Where the connection details live

| Place | What it holds | Secret? |
|---|---|---|
| **Obsidian → Settings → S3 Vault Sync → "AI assistants (MCP)"** | endpoint, region, tools, live status, copy-ready config for each client | token only if you paste it there |
| `s3://<bucket>/<user>/vaults/<vault>/mcp.json` | the published connection document every device reads | no |
| `scripts/install/.secrets/mcp-<user>-<vault>.json` | the bearer token, as minted | **yes** |
| `scripts/install/.secrets/mcp-<user>-<vault>-connect.md` | per-client snippets with the token inlined | **yes** |

The settings section is the everyday answer to "how do I connect this vault?" — it works on mobile,
on a device that never ran the installer, and after you've forgotten the URL. It shows a live status
line (`Connected — vault-mcp 0.1.0`, or a reason it isn't), a **Bearer token** field, and a **Copy**
button per client.

> The token is stored in this plugin's `data.json`, which is excluded from sync by full path on both
> legs — it stays on the device you paste it into and never reaches S3 or the GitHub repo.

`mcp.json` sits beside `snapshot.json.gz`, `deltas/`, `files/` and `_logs/` at the vault prefix.
Neither sync leg looks outside those, so it is invisible to the protocol: not vault content, not in
git, never merged.

---

## 4. Connect each client

Everything below uses two values: the **endpoint** (`https://<id>.lambda-url.<region>.on.aws/mcp`)
and the **token**. Both are in the settings section and in the connect sheet.

### Claude Code

```bash
claude mcp add --transport http vault-<name> "<endpoint>" \
  --header "Authorization: Bearer <token>"
```

Add `--scope user` to make it available in every project instead of the current one. Verify with
`claude mcp list`, then ask Claude to list your notes.

### Claude Desktop

Settings → Developer → Edit Config, then add inside `mcpServers`:

```json
{
  "mcpServers": {
    "vault-<name>": {
      "type": "http",
      "url": "<endpoint>",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Restart Claude Desktop. The vault appears under the tools icon.

### Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in a project):

```json
{
  "mcpServers": {
    "vault-<name>": {
      "httpUrl": "<endpoint>",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

`httpUrl`, not `url` — Gemini CLI reads `url` as a stdio command. Check with `/mcp list`. It also
expands environment variables in header values, so `"Bearer $VAULT_MCP_TOKEN"` keeps the secret out
of the config file.

### claude.ai, ChatGPT, Gemini app — not yet

These add a connector by URL and then negotiate OAuth; none of them can send a static bearer token
(Claude has a `static_headers` mode, but it is beta and organization-admin-scoped). When the OAuth
mode ships, the flow becomes: paste the endpoint into the connector dialog → sign in once → done.
Until then, use a client from the list above.

---

## 5. What an assistant can do with the vault

| Tool | Effect |
|---|---|
| `list_notes` / `list_files` | list `.md` notes / everything else, optionally under a directory |
| `get_note` | read a note's text |
| `save_note` | create or overwrite a note |
| `remove_note` / `remove_file` | delete (a journal tombstone — the object stays, S3 versioning keeps history) |
| `get_file` | a 5-minute presigned URL for binary content |
| `save_file` | upload up to 4 MB inline |

Limits worth knowing before you ask an assistant to do something:

- **No search yet.** An assistant has to list and read; it cannot grep the vault. Planned.
- **Content only.** Every dot-path (`.obsidian/`, `.sync/`, `.git*`) is hidden and unwritable, so an
  assistant can neither read your credentials nor fight the sync legs over config files.
- **4 MB** cap on inline uploads (Lambda's request limit).
- **Writes are authoritative, not merged.** The server has no local copy to merge from: `save_note`
  overwrites. If a device edited the same note concurrently, *that device* three-way-merges on its
  next pull, exactly as it does between your own devices — nothing is lost, but an assistant
  rewriting a whole note can still supersede an edit you made seconds earlier.
- Edits arrive on your devices at their next poll, or instantly if push notifications are on.

---

## 6. Security

The bearer token is **full read/write on that one vault** — treat it like the S3 keys. It grants no
access to `.obsidian/`, to other vaults, or to AWS itself.

- **Rotate:** `./05-create-mcp-server.sh --vault <name> --rotate-token`, then update each client and
  the token field in the plugin settings on each device.
- **Revoke everything:** rotate the token, or delete the Function URL
  (`aws lambda delete-function-url-config --function-name vault-mcp-<user>-<vault>`).
- **Undo an assistant's edit:** it is an ordinary revision — Obsidian → right-click the note →
  *Version history (S3 sync)*, or restore the object version in S3.
- The Function URL is public but unguessable, and every request is authenticated in the handler; an
  unauthenticated call gets a `401` before anything touches S3.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Settings says *No MCP server installed for this vault* | `mcp.json` isn't at the prefix — run `05-create-mcp-server.sh --vault <name>` (it publishes it), or check that the plugin's **Key prefix** matches the vault you installed |
| Settings says *Server is up and requires a token* | expected before you paste the token on that device — copy it from `.secrets/mcp-<user>-<vault>.json` |
| Settings says *rejected this token* | wrong or rotated token; re-copy it, or rotate and update everywhere |
| *Unreachable* | the Lambda or its URL is gone — re-run the installer; check `aws logs tail /aws/lambda/vault-mcp-<user>-<vault> --follow` |
| Client connects but lists no tools | the client is on SSE/stdio; this server is **Streamable HTTP** — use `--transport http` / `type: "http"` / `httpUrl` |
| An assistant "can't find" a note that exists | it is under a dot-path (hidden by design), or the assistant guessed a path — ask it to `list_notes` in the folder first |
| `413` or "too large" on upload | over the 4 MB inline cap — put the file in the vault from a device instead |

---

## 8. Cost and upkeep

Lambda + Function URL stay inside the always-free tier at personal traffic; the S3 requests are
noise next to normal sync. Effectively $0/month.

Redeploy the code after changing the server package:

```bash
AWS_REGION=<region> MCP_FUNCTION=vault-mcp-<user>-<vault> npm run deploy -w @vault-sync/mcp-server
```

or just re-run `05-create-mcp-server.sh --vault <name>`, which rebuilds, redeploys, republishes
`mcp.json`, and re-verifies.
