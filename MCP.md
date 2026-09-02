---
title: Connect an AI assistant to your vault (MCP)
tags: [howto, mcp, setup]
---

# Connect an AI assistant to your vault (MCP)

Your vault can expose itself to AI assistants as a **remote MCP server**: one AWS Lambda, one HTTPS
URL, search/list/read/write/delete over the same delta-journal protocol the Obsidian plugin and
git-sync speak. An assistant that connects to it sees the live vault — not a copy — and every edit it makes
lands on your devices the same way an edit from another device does.

This is the **setup guide**. Why it is built this way: [MCP Server Design.md](MCP%20Server%20Design.md).
What each module does: [packages/mcp-server/README.md](packages/mcp-server/README.md).

---

## 1. Which clients work today

| Client | How it authenticates | What you paste |
|---|---|---|
| **Claude Code** | `Authorization` header | endpoint + token |
| **Claude Desktop** | `Authorization` header in the config file | endpoint + token |
| **Gemini CLI** | `Authorization` header in `settings.json` | endpoint + token |
| **claude.ai** (web, mobile) | OAuth 2.1 | endpoint only |
| **ChatGPT** (developer mode) | OAuth 2.1 | endpoint only |
| **Gemini app** (custom Connected App) | OAuth 2.1 | endpoint only |

Two ways in, because clients differ. Anything running on your machine can attach a bearer token to
every request. The hosted chat surfaces can't — they paste a *URL* into a connector dialog and run
an OAuth flow against it, so the server is also its own **authorization server**: it shows you a
consent page, you enter the vault passphrase, and the client gets a short-lived token. Both paths
are live at the same time; use whichever the client supports.

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

During install it asks for a **vault passphrase**. That passphrase is the login for the OAuth
consent page — the only thing standing between a stranger with your endpoint URL and your notes, so
make it a real one, or let the installer do it: `--generate-passphrase` mints a 24-character one,
stores it in `.secrets/` (read it back with `jq -r .loginPassphrase …`) and never prints it. Pass
your own with `--passphrase '<passphrase>'`, or skip OAuth entirely with `--no-oauth` (bearer
clients keep working). For a passphrase you choose, only its scrypt hash is stored.

Five wrong passphrases in fifteen minutes lock the consent page for fifteen — the page is on the
public internet, and a slow hash only makes *offline* guessing expensive. Bearer clients and
already-connected apps keep working through a lockout.

`--rotate-token` mints a new bearer token; `--rotate-oauth-key` mints a new signing key, which signs
every connected app out at once. `--dry-run` shows what it would do.

---

## 3. Where the connection details live

| Place | What it holds | Secret? |
|---|---|---|
| **Obsidian → Settings → S3 Vault Sync → "AI assistants (MCP)"** | endpoint, region, tools, live status, copy-ready config for each client | holds the token, adopted automatically |
| `s3://<bucket>/<user>/vaults/<vault>/mcp.json` | the published connection document every device reads — including the bearer token | **yes** |
| `scripts/install/.secrets/mcp-<user>-<vault>.json` | token, OAuth signing key, passphrase hash | **yes** |
| `scripts/install/.secrets/mcp-<user>-<vault>-connect.md` | per-client snippets with the token inlined | **yes** |

**You should never have to type a token.** The installer publishes it, and each device copies it
into its own settings the first time you open that section — including devices that were set up long
before the MCP server existed. A device provisioned from a `<vault>.zip` built after the server
already gets it in `data.json`.

The settings section is the everyday answer to "how do I connect this vault?" — it works on mobile,
on a device that never ran the installer, and after you've forgotten the URL. It shows a live status
line (`Connected — vault-mcp 0.2.0`, or a reason it isn't), a **Copy** button per client, and the
token itself tucked under *Advanced* for the rare case you need to see or override it.

### Why the token travels through S3

`data.json` is where the token belongs on a device, and it is **excluded from sync by full path on
both legs** — the same reason it can safely hold your AWS secret key. But that also means it can
never carry anything *to* another device: it is the destination, not the pipe.

So the pipe is `mcp.json`, which sits beside `snapshot.json.gz`, `deltas/`, `files/` and `_logs/` at
the vault prefix. Neither sync leg looks outside those four, so it is invisible to the protocol: not
vault content, not in git, never merged. The alternative — a synced file inside the plugin's own
folder — would reach every device *and* land in the GitHub content repo's history.

Publishing the token there is a smaller step than it sounds: anyone who can read that object already
holds the vault's S3 keys, and the token grants a strict **subset** of what those keys do (content
only, no `.obsidian/`, no other vaults, no version history). The one real difference is that an S3
key leak would then also expose an internet-reachable credential which outlives S3 key rotation — so
rotate both together, or install with `--no-publish-token` and enter the token by hand.

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

### claude.ai, ChatGPT, Gemini app

These take the **endpoint alone** — no token, no header:

1. **claude.ai** — Settings → Connectors → *Add custom connector*, paste the endpoint.
   **ChatGPT** — Settings → Apps → *Advanced* → enable Developer mode, then *Create* a connector and
   paste the endpoint. **Gemini app** — Settings → Connected apps → *Add custom app*, paste it there.
2. The client discovers the server's OAuth metadata and opens a consent page.
3. Enter your **vault passphrase**, review what's being connected, approve.
4. The client stores a token and refreshes it on its own. Sessions last until you rotate the signing
   key.

What the consent page shows you is worth reading: the app's name and the address it will send you
back to. If either looks wrong, cancel — a consent screen you didn't start is the one thing an
attacker with your endpoint URL could get you to see.

> **ChatGPT note:** custom-connector *write* actions are reported to be limited to Business /
> Enterprise / Edu workspaces; Plus and Pro get read-only. That is OpenAI's restriction, not this
> server's. Requesting `vault.read` gives a matching read-only surface deliberately.

---

## 5. What an assistant can do with the vault

| Tool | Effect |
|---|---|
| `search_notes` | full-text search across notes — paths and content, newest first, with line numbers |
| `search` / `fetch` | the same search in the shape ChatGPT's connectors expect, for citations |
| `list_notes` / `list_files` | list `.md` notes / everything else, optionally under a directory |
| `get_note` | read a note's text |
| `save_note` | create or overwrite a note |
| `remove_note` / `remove_file` | delete (a journal tombstone — the object stays, S3 versioning keeps history) |
| `get_file` | a 5-minute presigned URL for binary content |
| `save_file` | upload up to 4 MB inline |

Limits worth knowing before you ask an assistant to do something:

- **Search reads, it doesn't index.** There is no search index: a query folds the vault's state and
  reads candidate notes, newest first, under budgets (20 results, 1500 notes, 32 MB, 20 seconds).
  If a budget cuts the scan short the result says `truncated` and why — narrow it with `dir`, or ask
  for `pathOnly`, which matches names without reading anything. Notes only; find attachments by path
  with `list_files`.
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
access to `.obsidian/`, to other vaults, or to AWS itself. The same is true of an OAuth token,
except that it expires in an hour and can be narrowed to `vault.read`.

Three secrets exist, and they do different jobs:

| Secret | Held by | Rotate with |
|---|---|---|
| bearer token | each header-capable client | `--rotate-token` |
| OAuth signing key | the Lambda only | `--rotate-oauth-key` (signs every app out) |
| vault passphrase | you; only its scrypt hash is stored | `--passphrase '<new one>'` |

- **Rotate a token:** `./05-create-mcp-server.sh --vault <name> --rotate-token`. The new one is
  republished, so devices adopt it by themselves — but only where the field is empty, so clear it
  under *Advanced* on any device still holding the old token, and update your CLI clients.
- **Revoke everything:** `--rotate-oauth-key` (OAuth sessions) plus `--rotate-token` (header
  clients), or delete the Function URL
  (`aws lambda delete-function-url-config --function-name vault-mcp-<user>-<vault>`).
- **How the OAuth side is held together:** PKCE (S256) is required on every authorization request,
  codes are single-use and live 60 seconds, access tokens are bound to this exact endpoint, and
  refresh tokens rotate — replaying an old one revokes the whole session.
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
| A web client says it can't reach the server | OAuth is probably off for this deployment — re-run the installer with `--passphrase`; check `https://<endpoint-host>/.well-known/oauth-protected-resource` returns JSON |
| Consent page rejects your passphrase | it is the one you set at install; if it's lost, re-run with a new `--passphrase` |
| Consent page says *too many failed attempts* | the lockout above — wait it out, or connect a bearer client meanwhile |
| Settings shows no token and offers no copy configs | that deployment was installed with `--no-publish-token`; paste the token from `.secrets/` under *Advanced* |
| A web client only offers read-only tools | it asked for (or was granted) `vault.read` — reconnect, or check the plan limits above for ChatGPT |
| An assistant "can't find" a note that exists | it is under a dot-path (hidden by design), or the search was truncated — check `truncated` in the result and scope it with `dir` |
| Search misses a note you know matches | the budget stopped the scan before reaching it (older notes are read last), or the match is in an attachment rather than a note |
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
