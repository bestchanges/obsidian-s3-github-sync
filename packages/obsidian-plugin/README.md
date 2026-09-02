# S3 Vault Sync — Obsidian plugin

Two-way sync between an Obsidian vault and S3 (desktop **and** mobile), one leg of the
`GitHub ⇄ S3 ⇄ Obsidian` system. It speaks the shared delta-journal protocol in
[`packages/core`](../core); the other leg is the GitHub Actions [`git-sync`](../git-sync) job.

- **Plugin internals (as built):** [IMPLEMENTATION.md §4](../../IMPLEMENTATION.md) — sync cycle,
  persistence model, device identity, exclusions, download cap, conflict handling, starter export.
- **Shared protocol:** [IMPLEMENTATION.md §2](../../IMPLEMENTATION.md).
- **Infra bootstrap (bucket, CORS, IAM, workflow):** [SETUP.md](../../SETUP.md).
- **Repo-wide dev/deploy guidance:** [CLAUDE.md](../../CLAUDE.md).

## What it does

- **Delta-journal sync** — traffic proportional to *changed* files, not vault size. 15 s LIST poll,
  5 s push debounce, offline catch-up on startup.
- **Union-merge conflicts** — three-way merge (the same implementation git-sync uses); nothing lost,
  no conflict markers. Binary/oversized files fall back to last-writer-wins.
- **Full `.obsidian` sync** — app settings, themes, snippets, and every plugin's code + settings
  distribute across devices, minus a small per-device denylist (this plugin's own creds, workspace
  UI state, OS cruft).
- **Per-device tuning** — download-size cap (default 10 MB, keeps mobile lean), poll interval,
  transfer concurrency, excluded folders.
- **Device identity & copy detection** — auto-minted writer id + machine fingerprint; a `data.json`
  copied to a new machine triggers a clean full resync instead of two devices sharing an id.
- **One-click new-device setup** — *Export setup vault* bundles the plugin + connection settings into
  a zip (share sheet on mobile, download on desktop).
- **Version history per note** — every revision in the delta journal, with the **device** that wrote
  it, a diff against the previous revision, and one-click restore. Follows renames. Obsidian's own
  "Open version history" is Obsidian Sync–only with no plugin API, so this is our own panel over a
  richer source ([IMPLEMENTATION.md §2.9, §4.12](../../IMPLEMENTATION.md)). A **File recovery**
  snapshot is also taken before sync overwrites any local file, covering bytes that never reached S3.

Commands: **Sync now**, **Export setup vault**, **Version history of this note**; file-menu entry
*Version history (S3 sync)*; CLI `vault-s3-sync:history --path <path>`. A full resync lives only
behind the warning-styled **Resync** button in settings — deliberately not a command (§4.5).
Full settings and behavior: [IMPLEMENTATION.md §4.9](../../IMPLEMENTATION.md).

> **Requires Obsidian ≥ 1.12.2** (`minAppVersion`), the release that introduced `registerCliHandler`.
> Obsidian will not load the plugin on an older app — and since the plugin distributes through the
> vault sync itself, a device below that floor stops syncing until it's updated. See
> [IMPLEMENTATION.md §4.13](../../IMPLEMENTATION.md).

> ⚠️ **Requires bucket CORS.** The plugin makes cross-origin requests from `app://obsidian.md`
> (desktop) and `capacitor://localhost` / `http://localhost` (mobile); without CORS exposing `ETag`
> and `x-amz-version-id`, every request fails. See [IMPLEMENTATION.md §3](../../IMPLEMENTATION.md) and
> [SETUP.md](../../SETUP.md).

## Build

From the repo root:

```bash
npm run build:plugin             # esbuild → packages/obsidian-plugin/dist/ (+ deployment zip)
PLUGIN_SOURCEMAP=false npm run build:plugin   # leaner build, no inline sourcemap
```

`dist/` becomes a drop-in plugin folder — `main.js`, `manifest.json`, `versions.json` — plus
`vault-s3-sync-<version>.zip` (those files, flat: the same layout as a GitHub Release's assets).
`dist/` is gitignored.

## Versioning

`manifest.json` is the version **source of truth**. Bump everything in one step:

```bash
npm run bump:plugin -- 0.2.0     # updates manifest.json, package.json, versions.json
```

`versions.json` maps each plugin version → the minimum Obsidian `minAppVersion`. If the minimum
changes, edit `manifest.json` first, then bump so the new `versions.json` entry records it.

## Install

Manual install into a vault's plugin folder:

```
<vault>/.obsidian/plugins/vault-s3-sync/
  main.js
  manifest.json
```

Then enable community plugins and turn on **S3 Vault Sync**, and fill in bucket / region / access
key / secret / prefix (must match git-sync's `PREFIX`). For a brand-new empty device, prefer the
in-plugin **Export setup vault** — it ships the plugin preconfigured.

## Deployment / release

`manifest.json` is Obsidian's version source of truth; `versions.json` (bump keeps it in step) is the
`version → minAppVersion` map that Obsidian and BRAT read.

1. `npm run bump:plugin -- <x.y.z>`
2. `npm test && npm run typecheck`
3. `npm run build:plugin` — confirm the printed version and `dist/` contents
4. Commit the bumped `manifest.json` / `package.json` / `versions.json` (`dist/` is gitignored)
5. Ship by one of the channels below

### Channels

- **Self-distribution via the sync itself (primary today).** Because `.obsidian/**` syncs, the
  plugin's own `main.js` + `manifest.json` propagate to every device as vault content. Copy the two
  files into **one** synced vault's `.obsidian/plugins/vault-s3-sync/`, let a cycle run, then reload
  Obsidian (or toggle the plugin off/on) on each device — a running plugin does not hot-swap its own
  code.
  > Don't make this the *only* channel: a broken sync build can't distribute its own fix. Keep the
  > manual path as recovery.
- **Manual (recovery / first install).** Copy `main.js` + `manifest.json` into that folder on each
  device directly. The fallback when sync itself is broken.

### BRAT (not used yet — a future option)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewer's Auto-update Tool) installs and
auto-updates a plugin from a GitHub repo's Releases, without the official Community Plugins directory.
**We do not use it yet**, but it's viable because:

- The bundle carries **no secrets** — AWS credentials live only in per-device `data.json`, which is
  never bundled or synced — so the plugin **code can be published in a public repo** even though the
  content vault stays private.
- BRAT reads `manifest.json` + `main.js` (+ `versions.json`) from a **public** repo's Releases via the
  unauthenticated GitHub API. It cannot read a private repo.

To enable it later:

1. Publish this plugin's build to a **public** GitHub repo (a dedicated release repo is fine).
2. For each version, create a Release **tagged exactly `<version>`** (no `v` prefix; the tag must
   equal `manifest.version`) and attach `manifest.json`, `main.js`, `versions.json` — i.e. the
   contents of the `dist/` zip.
3. In Obsidian, install BRAT and *Add beta plugin* pointing at that repo. BRAT-subscribed devices
   auto-update on next launch.

The **official Obsidian Community Plugins directory** is intentionally **not** an option: it requires
a public repo submitted to `obsidianmd/obsidian-releases` and review approval, which doesn't fit a
personal plugin.
