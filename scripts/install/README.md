# Install scripts

Provision a vault-sync setup from the command line. Four small, idempotent scripts, split so each
concern runs on its own — and so the **GitHub leg is optional** (an S3-only vault needs just 01, 02, 04).

```
01-create-bucket.sh      shared S3 bucket (versioning, block-public, SSE-S3, CORS)   ── once per bucket
02-create-user.sh        per-user IAM plugin user + access key (S3 leg)              ── once per user
03-create-vault-repo.sh  per-vault GitHub repo + OIDC Actions role (git leg)         ── per vault, OPTIONAL
04-init-vault-zip.sh      per-vault <vault>.zip for a device                          ── per vault
```

Layout on S3: `s3://<bucket>/<user>/vaults/<vault>/…` where **`user` is your AWS IAM username**
(auto-derived, or set `VAULT_USER`). Per-user IAM resources are scoped to `s3://<bucket>/<user>/*`.

## Prerequisites

- CLI tools: `aws`, `gh`, `jq`, `zip`, `node` (git-sync/plugin build needs Node ≥ 20).
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
      "Resource": "*" }
  ]
}
```

> The `Sid: Bucket` statement also needs `arn:aws:s3:::YOUR-BUCKET/*` if you extend it, but the
> configuration calls here act on the bucket itself. `iam:CreateOpenIDConnectProvider` is only
> exercised the first time (provider is account-wide); you can drop it afterwards.

**Resources the scripts create** (least-privilege, so you can audit them):

| Resource | Scope |
|---|---|
| plugin IAM user `vault-plugin-<user>` | objects under `s3://<bucket>/<user>/*` + scoped `ListBucket` |
| Actions role `vault-sync-<user>` | same S3 scope; trusts `repo:<org>/<vault-repo>:*` via GitHub OIDC |
| GitHub OIDC provider | account-wide, created once |

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
