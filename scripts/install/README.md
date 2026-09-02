# Install scripts

Provision a vault-sync setup from the command line. Five small, idempotent scripts, split so each
concern runs on its own — and so the **GitHub leg is optional** (an S3-only vault needs just 01, 02, 04)
and the **MCP leg** (05) and **instant sync** (06) are optional.

```
01-create-bucket.sh      shared S3 bucket (versioning, block-public, SSE-S3, CORS)   ── once per bucket
02-create-user.sh        per-user IAM plugin user + access key (S3 leg)              ── once per user
                         (re-run after upgrading: version history needs ListBucketVersions)
03-create-vault-repo.sh  per-vault GitHub repo + OIDC Actions role (git leg)         ── per vault, OPTIONAL
04-init-vault-zip.sh      per-vault <vault>.zip for a device (run AFTER 05 to embed
                         its MCP token; otherwise the device adopts it later)       ── per vault
05-create-mcp-server.sh  per-vault remote MCP server (Lambda + Function URL)         ── per vault, OPTIONAL
06-enable-push-notifications.sh  instant sync via IoT Core (IAM grants only)         ── per vault, OPTIONAL
```

Layout on S3: `s3://<bucket>/<user>/vaults/<vault>/…` where **`user` is your AWS IAM username**
(auto-derived, or set `VAULT_USER`). Per-user IAM resources are scoped to `s3://<bucket>/<user>/*`.

## Prerequisites

- CLI tools: `aws`, `gh`, `jq`, `zip`, `node` (git-sync/plugin build needs Node ≥ 20), `openssl` (05).
- `aws` authenticated (`aws configure` / `aws sso login`) as a user/role with the permissions below.
- `gh` authenticated (`gh auth login`) — only for the GitHub leg (03).

## Configure shared settings once

```bash
cd scripts/install
cp .env.shadow .env      # then edit .env
```

`.env` (gitignored) holds `VAULT_BUCKET`, `VAULT_REGION`, and — for the git leg — `VAULT_ORG`,
`VAULT_TOOL_REPO`. Every script sources it; CLI flags override. `.env.shadow` is the committed template.

## Typical runs

**S3-only vault (no GitHub):**
```bash
./01-create-bucket.sh                 # once per bucket
./02-create-user.sh                   # once per user (mints + saves the plugin key)
./04-init-vault-zip.sh --vault work   # → work.zip
```

**Full vault (adds the GitHub git-sync leg):**
```bash
./03-create-vault-repo.sh --vault work --run   # repo + OIDC role + vars, trigger first sync
./04-init-vault-zip.sh --vault work
```

**Remote MCP server for a vault (optional — lets an AI assistant read/write the vault over the internet):**
```bash
./05-create-mcp-server.sh --vault work   # role + Lambda + Function URL + bearer token
```
It asks for a **vault passphrase** (or takes `--passphrase`, or mints one with
`--generate-passphrase`), which enables the in-Lambda OAuth server that browser clients — claude.ai,
ChatGPT, the Gemini app — need; `--no-oauth` skips it and leaves bearer-token clients working. It
then publishes `<prefix>mcp.json` — connection facts **and the bearer token**, so every device
adopts it without anyone typing a secret (`--no-publish-token` opts out) — writes
`.secrets/mcp-<user>-<vault>-connect.md` with per-client copy-paste config, verifies the deployment
(MCP handshake + the OAuth discovery documents + the 401 challenge), and prints the endpoint.
Re-running reconciles config and redeploys the current build; `--rotate-token` replaces the bearer
token and `--rotate-oauth-key` signs every connected app out. Per-client setup:
[`MCP.md`](../../MCP.md). Component details:
[`packages/mcp-server/README.md`](../../packages/mcp-server/README.md).

**Instant sync for a vault (optional — sub-second cross-device delivery instead of polling):**
```bash
./06-enable-push-notifications.sh --vault work --role vault-sync-work   # IAM grants + endpoint
```
Creates nothing: IoT Core needs no resources for a plain MQTT topic. It attaches an `iot` policy to
the plugin user and an `iot:Publish` grant to the git-sync role — both scoped to
`vaultsync/<user>-vaults-*/rev`, i.e. every vault of that user, because these attach by name to
per-user identities and a per-vault document would overwrite the previous vault's. Then prints the
ATS endpoint for each device's settings and `S3_SYNC_IOT_ENDPOINT`. `02-create-user.sh` already
writes the same plugin-user policy for new users, so this is mainly for existing deployments.
Add `--endpoint <host>` if the operator lacks `iot:DescribeEndpoint`. Safe to skip — sync falls back
to polling. Details: IMPLEMENTATION.md §4.14.

Add a second vault for the same user: just `03` (optional) + `04` with a new `--vault`.
Every script takes `--dry-run` (print, don't mutate) and `--yes` (skip confirmations).

**On the target device:** the `<vault>.zip` contains only the vault — a single folder named after
the vault. Extract it in place, open that `<vault>/` folder as an Obsidian vault, turn on community
plugins, and it starts pulling the whole vault. (No instructions ship inside the zip.)

## Where the secret goes

- `02` writes the plugin access key to `scripts/install/.secrets/<user>.json` (gitignored, `chmod 600`).
  It is **never printed**. `04` reads it from there (off argv, so it can't leak into `ps`).
- The generated `<vault>.zip` **contains** the secret key (the device needs it to connect). Treat the
  zip as a credential: transfer it privately and delete it after the device is set up. `*.zip` is
  gitignored.
- Rotate a key with `./02-create-user.sh --rotate` (deletes old keys, mints a new one), then re-run `04`.
- `05` writes the MCP bearer token to `.secrets/mcp-<user>-<vault>.json` (gitignored, `chmod 600`),
  never printed — the printed `claude mcp add` command reads it from the file via `jq`. It also
  writes `.secrets/mcp-<user>-<vault>-connect.md`, which **does** inline the token in ready-to-paste
  client configs: same handling as the zip — keep it in `.secrets`, share privately if at all. The
  published `mcp.json` carries no secret. Rotate with `./05-create-mcp-server.sh --rotate-token`
  (old token stops working immediately).
- `05` also stores the **OAuth signing key** and a **scrypt hash** of your vault passphrase in the
  same `.secrets` file. A passphrase you chose is never written anywhere — if you lose it, re-run
  with a new `--passphrase`; one made by `--generate-passphrase` is kept there so you can read it
  back (`jq -r .loginPassphrase …`). `--rotate-oauth-key` invalidates every OAuth session at once.
- `05` **publishes the bearer token** to `<prefix>mcp.json` so devices configure themselves; `04`
  additionally embeds it in the zip's `data.json` when the vault already has an MCP server. Both are
  weaker than the S3 key those artifacts already carry. `--no-publish-token` turns the first off.

## Required permissions

### AWS — the identity running the scripts

Scripts 01–03 create/configure S3 + IAM. The operator needs an admin-ish policy; scope it to your
bucket + the `vault-*` name pattern if you want least privilege:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Bucket", "Effect": "Allow",
      "Action": ["s3:CreateBucket","s3:PutBucketVersioning","s3:PutBucketPublicAccessBlock",
                 "s3:PutEncryptionConfiguration","s3:PutBucketCORS","s3:PutLifecycleConfiguration",
                 "s3:ListBucket","s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET" },
    { "Sid": "IamUsers", "Effect": "Allow",
      "Action": ["iam:CreateUser","iam:GetUser","iam:TagUser","iam:PutUserPolicy",
                 "iam:CreateAccessKey","iam:ListAccessKeys","iam:DeleteAccessKey"],
      "Resource": "arn:aws:iam::*:user/vault-plugin-*" },
    { "Sid": "IamRoles", "Effect": "Allow",
      "Action": ["iam:CreateRole","iam:GetRole","iam:TagRole","iam:PutRolePolicy","iam:UpdateAssumeRolePolicy"],
      "Resource": "arn:aws:iam::*:role/vault-sync-*" },
    { "Sid": "Oidc", "Effect": "Allow",
      "Action": ["iam:CreateOpenIDConnectProvider","iam:ListOpenIDConnectProviders"],
      "Resource": "*" },
    { "Sid": "McpRole", "Effect": "Allow",
      "Action": ["iam:CreateRole","iam:GetRole","iam:TagRole","iam:PutRolePolicy",
                 "iam:AttachRolePolicy","iam:PassRole"],
      "Resource": "arn:aws:iam::*:role/vault-mcp-*" },
    { "Sid": "McpLambda", "Effect": "Allow",
      "Action": ["lambda:CreateFunction","lambda:GetFunction","lambda:UpdateFunctionCode",
                 "lambda:UpdateFunctionConfiguration","lambda:CreateFunctionUrlConfig",
                 "lambda:GetFunctionUrlConfig","lambda:AddPermission","lambda:GetPolicy"],
      "Resource": "arn:aws:lambda:*:*:function:vault-mcp-*" }
  ]
}
```

> `McpRole` / `McpLambda` are only needed for the optional MCP leg (05).

> The `Sid: Bucket` statement also needs `arn:aws:s3:::YOUR-BUCKET/*` if you extend it, but the
> configuration calls here act on the bucket itself. `iam:CreateOpenIDConnectProvider` is only
> exercised the first time (provider is account-wide); you can drop it afterwards.

**Resources the scripts create** (least-privilege, so you can audit them):

| Resource | Scope |
|---|---|
| plugin IAM user `vault-plugin-<user>` | objects under `s3://<bucket>/<user>/*` + scoped `ListBucket` |
| Actions role `vault-sync-<user>` | same S3 scope; trusts `repo:<org>/<vault-repo>:*` via GitHub OIDC |
| GitHub OIDC provider | account-wide, created once |
| MCP execution role `vault-mcp-<user>` | same S3 scope + CloudWatch Logs; trusts `lambda.amazonaws.com` |
| Lambda `vault-mcp-<user>-<vault>` + Function URL | one per vault; public URL, bearer auth enforced in-handler |

### GitHub — the `gh` account (leg 03 only)

- Authenticate with scopes `repo` and `workflow` (`gh auth login` → or
  `gh auth refresh -h github.com -s repo,workflow`).
- Permission to **create repositories** in `VAULT_ORG` (personal account, or an org where you can
  create repos), and **admin** on the created repo (to set Actions variables and workflow
  permissions). Org-owned repos may require an org owner/admin or a fine-grained token with
  *Administration: read/write*, *Actions: read/write*, *Variables: read/write*, *Contents: read/write*.

## Idempotency & safety

- Re-running is safe: existing bucket/user/role/repo are detected and only reconciled (policies,
  variables, trust are re-applied; access keys and repos are **not** recreated unless you ask).
- `03` extends the per-user role's trust with each new repo rather than replacing it.
- Nothing is destructive without `--rotate` (key replacement) or an explicit confirmation prompt.
