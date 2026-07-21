# Backup scripts

Real, decoupled backups of the vault's S3 hub into **restic** repositories — an external drive
(air-gapped), **Backblaze B2**, and **Google Drive**. Full design, threat model, and 3-2-1-1-0
rationale: [`../../BACKUP.md`](../../BACKUP.md).

```
backup.sh    fetch S3 (read-only) → restic backup → forget/prune/check   (local + CI)
restore.sh   list snapshots, restore a point in time to a plain files/ tree
lib.sh       shared helpers (sourced, not run)
.env.shadow  committed template → copy to .env (gitignored) and fill in
```

## Prerequisites

- CLI tools: `aws`, `restic` (and `rclone` for the Google Drive destination).
- A **read-only** AWS identity for the source (Get/List only — never the plugin key; BACKUP.md §6.2).
- A restic password (the master secret; BACKUP.md §6.1) and the destination(s) you want (§6.3–§6.5).

## Configure once

```bash
cd scripts/backup
cp .env.shadow .env      # then edit .env
```

## Local runs (external drive — the air-gapped leg)

```bash
./backup.sh --dests drive                 # nightly-ish; skips cleanly if the drive isn't mounted
./backup.sh --dests drive --prune         # trusted machine also prunes (full-access key)
./backup.sh --dests drive --check full    # monthly deep verify (reads pack bytes)
./backup.sh --dry-run                     # show what would run, mutate nothing
```

Schedule it with cron (Linux) or launchd (macOS), e.g. `0 2 * * * .../scripts/backup/backup.sh --dests drive --prune >> ~/vault-backup.log 2>&1`.

## Cloud runs (B2 + Google Drive — unattended)

Handled by [`../../templates/s3-backup.yml`](../../templates/s3-backup.yml) on a GitHub Actions
schedule (OIDC → read-only role). That leg uses an **append-only** B2 key, so it never prunes; run
`--prune` only from the trusted local machine.

## Restore

```bash
./restore.sh --repo drive --list                                  # pick a point in time
./restore.sh --repo drive --snapshot <id> --target ./restored     # → ./restored/…/files/** = the vault
./restore.sh --repo b2 --snapshot latest --include /files/Journal --target ./one-folder
```

`files/**` is the vault as plain files — no tooling needed. To rebuild the live S3 hub and resume
sync afterward, follow **BACKUP.md §8.2** (pause devices, `aws s3 sync ./restored s3://…/<prefix>
--delete` with a **write** identity, let sync reconcile).
