# Setup Instructions

Order matters: **bucket → tool repo → GitHub Actions (seeds S3 from the repo) → plugin**.

## 1. S3 bucket

```bash
aws s3api create-bucket --bucket YOUR-VAULT-BUCKET --region YOUR-REGION \
  --create-bucket-configuration LocationConstraint=YOUR-REGION   # omit config for us-east-1

# Versioning is REQUIRED (merge bases come from old object versions)
aws s3api put-bucket-versioning --bucket YOUR-VAULT-BUCKET \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block --bucket YOUR-VAULT-BUCKET \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Optional: a lifecycle rule expiring *noncurrent* versions after ~90 days keeps versioning storage bounded.

## 2. Publish this tool repo

Push this `sync/` monorepo to GitHub (e.g. `your-user/vault-sync`). The workflow in your content repo checks it out at run time.

## 3. AWS auth for GitHub Actions (OIDC, no stored keys)

Create the GitHub OIDC provider (once per AWS account), then a role:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

Trust policy (`trust.json`) — restrict to your **content** repo:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:your-user/your-vault-repo:*" }
    }
  }]
}
```

Permissions policy (`perms.json`) — bucket-scoped:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR-VAULT-BUCKET/*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::YOUR-VAULT-BUCKET" }
  ]
}
```

```bash
aws iam create-role --role-name vault-s3-sync --assume-role-policy-document file://trust.json
aws iam put-role-policy --role-name vault-s3-sync --policy-name s3 --policy-document file://perms.json
```

## 4. Content repo (your vault's git repo)

1. Copy `templates/s3-sync.yml` → `.github/workflows/s3-sync.yml`.
2. Repo **Settings → Secrets and variables → Actions → Variables**:
   - `S3_SYNC_BUCKET` = YOUR-VAULT-BUCKET
   - `S3_SYNC_REGION` = YOUR-REGION
   - `S3_SYNC_ROLE_ARN` = arn:aws:iam::ACCOUNT_ID:role/vault-s3-sync
   - `S3_SYNC_TOOL_REPO` = your-user/vault-sync
3. Add to `.gitignore`:

   ```
   .sync-tool/
   ```

4. Optional `.s3syncignore` at repo root (gitignore syntax) — folders that stay **GitHub-only**, never pushed to S3.
5. **Settings → Actions → General → Workflow permissions**: "Read and write permissions" (the bot pushes sync commits). If `main` is branch-protected, allow the token to bypass or use a GitHub App.

Run the workflow once manually (**Actions → S3 sync → Run workflow**). First run pushes every tracked file to S3 and writes `snapshot.json.gz` + `.sync/state.json`. Check the run log for `appended delta rev=…`.

## 5. Obsidian plugin

Build and install:

```bash
npm install
npm run build:plugin
# → packages/obsidian-plugin/dist/main.js

mkdir -p YOUR_VAULT/.obsidian/plugins/vault-s3-sync
cp packages/obsidian-plugin/dist/main.js packages/obsidian-plugin/manifest.json \
   YOUR_VAULT/.obsidian/plugins/vault-s3-sync/
```

Enable it in **Settings → Community plugins**, then configure: bucket, region, access key ID / secret (see §6), optional key prefix, poll interval (default 15 s), excluded folders (one per line — local-only until removed from the list), device ID (make it distinct per device, e.g. `device:phone`).

First sync pulls the whole S3 state (seeded by step 4). If the vault already has local content, overlapping files with different content get union-merged — nothing is lost.

## 6. Plugin AWS credentials

Create a dedicated IAM user with the same S3 permissions JSON as above (bucket-scoped only) and one access key per device. The plugin stores the key in the plugin's `data.json` on that device.

## 7. Remote MCP server (optional)

Expose the vault to MCP clients (Claude Code / Desktop) over the internet — a single Lambda +
Function URL, bearer-token auth, ~$0/month:

```bash
scripts/install/05-create-mcp-server.sh --vault <name>
```

It provisions role + function + URL + token idempotently and prints a ready-to-paste
`claude mcp add …` command. Design: [MCP Server Design.md](MCP%20Server%20Design.md); component
details: [packages/mcp-server/README.md](packages/mcp-server/README.md); script details:
[scripts/install/README.md](scripts/install/README.md).

## Smoke test

1. Edit a note in Obsidian → within ~20 s: delta appears in S3 (`deltas/`), and on the next Actions run (≤4 h on the cron — trigger manually to see it now) a `s3-sync: rev N [skip ci]` commit lands in the repo.
2. Edit a file on GitHub (web UI) → workflow runs on push → plugin picks it up within one poll interval.
3. Edit the **same line** of the same note in both places between syncs → after both legs run, the file contains both versions of the line (union), no conflict markers, everywhere.

## Troubleshooting

- **412 loops in Actions log** — normal under concurrent writes (CAS retries); a problem only if it never converges.
- **`git push failed`** — branch protection; see step 4.5.
- **Plugin: "S3 LIST: 403"** — IAM user missing `s3:ListBucket` on the bucket resource (not `/*`).
- **A file keeps ping-ponging** — two devices sharing one device ID; make them unique.
- **Behind >30 days offline** — expected: one-time snapshot download (~600 KB at 20k files), then normal delta sync.
