# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. Keep it short; it points at the
canonical docs rather than repeating them.

## What this project is

Two-way sync **GitHub repo ⇄ S3 ⇄ Obsidian vault** over one delta-journal protocol. S3 is the hub;
two clients — a GitHub Actions **git-sync** job and an **Obsidian plugin** — share `packages/core`.

- **Architecture & behavior (as built):** [IMPLEMENTATION.md](IMPLEMENTATION.md) — the authoritative
  reference (repo layout §1, protocol §2, adapters §3, plugin §4, git-sync §5, exclusion matrix §6,
  config §7, deployment/infra §8, failure/recovery §9, security §10, constants §11).
- **Design rationale ("why"):** [System Design.md](System%20Design.md).
- **MCP server (optional third client):** [MCP.md](MCP.md) — setup + per-client howto (the
  user-facing guide); [MCP Server Design.md](MCP%20Server%20Design.md) — design;
  [packages/mcp-server/README.md](packages/mcp-server/README.md) — component details;
  installed via `scripts/install/05-create-mcp-server.sh`.
- **Infra bootstrap (bucket, CORS, OIDC/IAM, workflow install):** [SETUP.md](SETUP.md).
- **Change delivery (adaptive polling as built; MQTT push proposed):**
  [Change Notification Design.md](Change%20Notification%20Design.md) — IMPLEMENTATION.md §4.9a is the
  shipped half.
- **Backups (external drive + B2 + Google Drive, restic, restore/DR):** [BACKUP.md](BACKUP.md) —
  design + runbook; tooling in `scripts/backup/` and `templates/s3-backup.yml`.
- **Top-level tour:** [README.md](README.md).

Do not duplicate those here — link to the relevant section instead.

## Layout & commands

npm-workspaces monorepo: `packages/core` (pure protocol, no platform APIs), `packages/git-sync`
(Actions CLI), `packages/obsidian-plugin` (desktop + mobile). Full table: IMPLEMENTATION.md §1.

```bash
npm test              # Vitest: core protocol/merge + plugin sync-serialization tests
npm run typecheck     # tsc --noEmit across all three packages
npm run build:plugin  # esbuild → packages/obsidian-plugin/dist/ (+ deployment zip)
npm run build:mcp     # esbuild → packages/mcp-server/dist/ (Lambda bundle + zip)
npm run bump:plugin -- <x.y.z>   # version bump across manifest/package/versions.json
```

## Conventions when changing code

- **`core` stays pure** — no `obsidian`, no AWS SDK, no `fs`. Storage/filesystem are injected via
  `StorageAdapter`. This is what lets both legs merge byte-identically (IMPLEMENTATION.md §1, §2.6).
- **Both legs move in lockstep.** The exclusion rules and the union merge are duplicated by design
  across the plugin and git-sync; if you touch one, mirror the other, or the legs will fight (a file
  one syncs and the other tombstones). See the exclusion matrix, IMPLEMENTATION.md §6.
- **Tests:** protocol/merge fixtures in `packages/core/test`; the plugin's `SyncEngine` is tested in
  `packages/obsidian-plugin/test` against a fake `Vault` + a gated `StorageAdapter`. The real
  `obsidian` package is types-only, so `vitest.config.ts` aliases it to `test/obsidian-stub.ts`.

## Obsidian plugin deployment

### Can this use Obsidian's Community Plugins?

- **Official directory (in-app browse + auto-update): no.** It requires a *public* repo submitted to
  `obsidianmd/obsidian-releases` and passing review. Not appropriate for a personal/private plugin.
- **BRAT (`obsidian42-brat`) — yes, if you want tagged auto-update.** BRAT installs and auto-updates a
  plugin from a **public** GitHub repo's Releases (it reads `manifest.json` + `main.js` from the
  release assets via the unauthenticated GitHub API). The bundle carries **no secrets** — credentials
  live only in per-device `data.json`, which is never bundled or synced — so the code *can* be
  published publicly even though the content vault is private. Point BRAT at a public repo whose
  Releases contain the built assets (the `dist/` zip contents).
- **Self-distribution via the vault sync itself — the primary path here.** Because `.obsidian/**`
  syncs (IMPLEMENTATION.md §4.6, §8), the plugin's own `main.js` + `manifest.json` propagate to every
  device as ordinary vault content. Install/upgrade on **one** device and sync ships it everywhere.
  > ⚠️ Don't rely on this as the *only* channel: a broken sync build can't distribute its own fix.
  > Always keep a manual or BRAT path available for recovery (see below).

### The deployment package

`npm run build:plugin` produces a drop-in plugin folder and a transferable zip in
`packages/obsidian-plugin/dist/`:

| Artifact | Purpose |
|---|---|
| `main.js` | the bundle |
| `manifest.json` | copied from source; carries the **version** Obsidian shows and compares |
| `styles.css` | plugin stylesheet — Obsidian auto-loads it; **must travel with `main.js`** on every channel or the version-history modal renders unstyled |
| `versions.json` | plugin version → `minAppVersion` map (used by Obsidian/BRAT) |
| `<id>-<version>.zip` | the three files above, flat — same layout as a GitHub Release's assets |

`manifest.json` is the version **source of truth**; `bump:plugin` keeps `package.json` and
`versions.json` in step with it. Set `PLUGIN_SOURCEMAP=false npm run build:plugin` for a leaner
bundle without the inline sourcemap.

### Release process

**Automated (default):** every **merge to `main`** cuts the next release. `.github/workflows/deploy-plugin.yml`
tests/typechecks/builds, computes the next version (highest existing release tag / manifest version
with the **minor** bumped, patch → 0, e.g. `0.5.2 → 0.6.0`), bumps `manifest.json` / `package.json` /
`versions.json` and commits that back to `main`, publishes a GitHub Release tagged `<version>` (tag =
`manifest.version`, no `v` prefix) with `main.js` / `manifest.json` / `styles.css` / `versions.json`
attached, then
fires a `repository_dispatch` at the vault repo to install it. So: **just merge — no manual bump.**
Only merges that touch what ships (`packages/obsidian-plugin/**`, `packages/core/**`, or the
workflow itself) cut a release — docs/git-sync/infra-only merges don't. A red build (tests/typecheck)
blocks the release. To re-deploy an existing tag to the vault without bumping, run the workflow via
**workflow_dispatch** with that `tag`. Requires repo var `VAULT_REPO` + secret `VAULT_DEPLOY_TOKEN`
(SETUP.md).

The workflow only ever bumps the **minor**. To change **`minAppVersion`**, edit it in
`packages/obsidian-plugin/manifest.json` and merge — the auto-bump carries it into the new
`versions.json` entry. For a **major** release (or any non-minor jump), cut it by hand: create the
GitHub Release + tag (`<version>`, no `v` prefix) with the built `main.js` / `manifest.json` /
`versions.json` attached, which the vault deploy picks up; later merges resume minor-bumping from
that tag.

Distribution channels the release feeds:
   - **Self-sync (default):** copy `dist/main.js` + `dist/manifest.json` + `dist/styles.css` into **one** synced vault's
     `.obsidian/plugins/vault-s3-sync/`, let a sync cycle run; other devices pick it up. Reload
     Obsidian (or toggle the plugin off/on) on each device so the new `main.js` is loaded — a running
     plugin does not hot-swap its own code.
   - **Manual (recovery / first install):** copy the same files into that folder on each device
     directly. This is the fallback when sync itself is broken.
   - **BRAT (public repo):** create a GitHub Release tagged `<version>` (tag = `manifest.version`, no
     `v` prefix) with `manifest.json`, `main.js`, `versions.json` attached — i.e. the zip contents.
     BRAT-subscribed devices auto-update on next launch.

New, empty devices are provisioned separately by the in-plugin **Export setup vault** (starter zip),
which bundles the current `main.js` + `manifest.json` with connection settings — IMPLEMENTATION.md
§4.10.
