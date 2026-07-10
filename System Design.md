---
title: Vault Sync System — Design Doc
tags: [design, sync, s3, obsidian, github-actions]
status: draft
created: 2026-07-11
---

# Vault Sync System — Design Doc

Two-way sync between a **GitHub repo**, **S3**, and an **Obsidian vault**, for thousands of small text files.

**S3 is the hub.** The git syncer and the Obsidian plugin are both *clients* of one shared sync protocol. Neither talks to the other directly.

```mermaid
flowchart LR
    GH[GitHub repo] <-->|git sync module\nGitHub Actions| S3[(S3 bucket\n+ manifest.json)]
    S3 <-->|sync module| OB[Obsidian plugin]
```

## Design goals

- Fast for thousands of small files: sync cost proportional to *changed* files, never total files
- Two-way on both legs, with offline support for the plugin
- Conflicts resolved by **union merge** — all changes from both sides kept, no data loss
- No servers: S3 + GitHub Actions + client-side plugin only
- Files ignored by `.gitignore` never enter the repo

---

# 1. Sync Protocol (shared by both clients)

## 1.1 Bucket layout

```
s3://<bucket>/
  snapshot.json.gz           ← full manifest snapshot (rebuilt by git-sync)
  deltas/<rev10>.json.gz     ← append-only journal, one object per write
  files/<vault-path>         ← file contents, mirrors vault structure
```

The sync state is **log-structured**: an append-only *delta journal* is the source of truth; the *snapshot* is a periodic compaction of it. This keeps per-sync traffic proportional to changes — critical at 20k files on mobile (see [[#1.8 Scale & mobile budget]]).

Bucket has **S3 Versioning enabled** — old versions serve as merge bases (see [[#1.5 Conflict resolution — union merge]]). All JSON objects are stored **gzipped**; at-rest encryption is server-side (**SSE-S3**, bucket default). Client-side encryption was considered and rejected: the git repo holds a plaintext copy anyway, so it adds complexity without a real confidentiality gain.

## 1.2 Schemas

**Delta** — `deltas/0000004173.json.gz`, written by any client, contains only the files changed in that write:

```json
{
  "rev": 4173,
  "by": "device:egor-iphone",
  "at": "2026-07-11T14:05:01Z",
  "files": {
    "notes/inbox/idea.md": {
      "hash": "md5:9f86d081...",
      "s3VersionId": "3sL4kqtJlcpXro...",
      "size": 1832,
      "mtime": "2026-07-11T14:03:20Z"
    }
  }
}
```

Key is the zero-padded revision (`0000004173`) so lexicographic S3 listing = revision order. Typical size **0.3–1 KB gzipped**.

**Snapshot** — `snapshot.json.gz`, the folded state of all deltas up to `revision`:

```json
{
  "schemaVersion": 1,
  "revision": 4172,
  "updatedAt": "2026-07-11T14:03:22Z",
  "updatedBy": "device:egor-macbook",
  "files": {
    "notes/inbox/idea.md": {
      "hash": "md5:9f86d081...",
      "s3VersionId": "3sL4kqtJlcpXro...",
      "size": 1832,
      "mtime": "2026-07-11T14:03:20Z",
      "rev": 4172,
      "by": "device:egor-macbook"
    },
    "notes/old.md": {
      "deleted": true,
      "rev": 4101,
      "by": "git-sync"
    }
  }
}
```

Field notes:

- `rev` / `revision` — global monotonic counter; every delta append claims the next value. Clients store the last revision they synced; "what changed while I was offline" = deltas after it.
- `hash` — MD5 of content. Matches the S3 ETag for plain (non-multipart) PUTs, so drift can be detected without downloads. **The hash is the only change signal** — see [[#1.6 mtime policy]].
- `mtime` — informational metadata: the edit time on the *source* device. Never compared for change detection, never bumps `rev` on its own.
- `deleted: true` — tombstone. Listing a bucket can't express deletions; tombstones can. Prune tombstones older than 90 days.
- `by` — writer ID, used for echo suppression.

> [!note] Size check at 20k files
> Snapshot: 20k × ~200 B ≈ **4 MB raw / ~600 KB gzipped**. Too big to move per sync event — which is exactly why clients normally touch only deltas. The snapshot is fetched on first run or when a client falls behind the delta retention window; it is *written* only by the git-sync job on Actions bandwidth, never from mobile.

## 1.3 Write algorithm (atomic, race-free)

Clients never rewrite the snapshot — they **append a delta**, serialized by S3 conditional creation (`If-None-Match: *` succeeds only if the key doesn't exist yet):

```
1. myRev = lastKnownRev + 1
2. PUT changed files to files/*        (parallel; see 1.8 for concurrency)
3. PUT deltas/<pad10(myRev)>.json.gz with If-None-Match: *
4. On 412 Precondition Failed:        → another writer took that rev;
   fetch+apply their delta (may re-merge), myRev += 1, retry from 3
```

The 412 loop gives total ordering of writes with no locks and ~300 B retry cost. Files are written *before* the delta, so the journal never references a missing object; a crash between 2 and 3 leaves orphan file versions — harmless.

**Compaction** (git-sync job only, every run): fold deltas into a new `snapshot.json.gz` (CAS via `If-Match` on the snapshot ETag), prune deltas older than the retention window (default **30 days**), prune tombstones older than 90 days.

## 1.4 Read / catch-up algorithm

Identical for "poll while running" and "returning from offline":

```
1. LIST deltas/ StartAfter=<pad10(lastSyncedRev)>     (1 request, ~free)
   → no keys: in sync, done
   → keys returned ARE the changes; GET each (tiny, parallel)
   → lastSyncedRev older than earliest delta (pruned)? → cold path:
     GET snapshot.json.gz, diff whole state, continue below
2. changed = delta entries where by != myId            (echo suppression)
3. For each changed entry (last delta per path wins):
     - local file unchanged since last sync → apply remote (GET file / delete)
     - local file also changed              → CONFLICT → union merge (1.5)
4. Persist new lastSyncedRev + per-file state
```

One LIST both answers "anything new?" *and* enumerates exactly what to fetch — cheaper than the HEAD-then-GET pattern, and catch-up traffic is proportional to missed changes, not vault size.

## 1.5 Conflict resolution — union merge

A conflict = file changed locally *and* remotely since the client's last sync. Policy: **include all changes in one file.**

Three-way union merge:

- **base** = content at last sync. Fetched from S3 via the *old* `s3VersionId` the client recorded (this is why versioning is on — no local base copies needed).
- **ours** = local content, **theirs** = remote content.
- **One implementation for both sides**: diff3 union merge from the shared `core` package (`node-diff3`) — see [[#5. Implementation notes]]. Identical output on both legs is required; divergent merge results would echo back as phantom changes.
- Union merge keeps lines from both sides, no conflict markers. If diff3 can't produce a result (rare on text), fall back to concatenation with a `---` separator.
- Merged result is written **locally and to S3**, becoming the new common state.
- Delete-vs-edit conflict: **edit wins** (the edited content is kept, tombstone dropped). Never silently lose text.

## 1.6 mtime policy

`mtime` is **metadata, not a change signal**:

- A file whose content hash is unchanged is *never* pushed, pulled, or merged, regardless of mtime. Touching a file, or a filesystem restoring different timestamps, must not cause traffic.
- An mtime-only difference never increments `rev` and never writes a delta — otherwise a no-op would ripple through every client.
- Semantics: manifest `mtime` = edit time on the source device (author time), not sync time. It travels with the content so every device shows the same "last modified".
- **Clients align local mtime to the manifest** when applying remote files (see [[#2.5 mtime alignment]]). Benefits: Obsidian's sort-by-modified is consistent across devices, and mtime stays reliable as a *fast pre-filter* for offline scans (only hash files whose mtime moved).
- mtime may be used as an optimization hint (pre-filter before hashing) but the hash always decides.

## 1.7 Echo suppression

Every writer has a stable ID (`device:<name>` for plugin instances, `git-sync` for the Actions job). Clients skip delta entries where `by == myId` and `hash` matches what they last wrote. Prevents infinite ping-pong between the two legs.

## 1.8 Scale & mobile budget

Design target: **20k files, unreliable mobile connection**. Options considered for keeping sync state cheap:

| Option | Verdict |
|---|---|
| Single manifest, gzip only | ✗ still ~600 KB up *and* down per sync event — every one-note edit re-uploads full state |
| Sharded manifests (N shards + index) | ✗ works, but index-consistency complexity; still whole-shard rewrites |
| Binary encoding (msgpack/CBOR) | ✗ marginal gain once gzipped |
| **Delta journal + periodic snapshot** | ✓ traffic ∝ changes; mobile never touches the big object; CAS-on-create gives free write ordering |

Resulting traffic budget (gzipped):

| Event | Cost over the wire |
|---|---|
| Poll, nothing new | 1 LIST ≈ 0.3 KB |
| Edit one note (push) | 1 file PUT + 1 delta PUT ≈ content + 0.3 KB |
| Another device edited 10 notes | 1 LIST + ~10 delta GETs + 10 file GETs |
| Back online after a day (~200 changes) | ~50–200 KB total |
| First install / behind retention window | snapshot ~600 KB, once |

Bad-connection rules (plugin): limit file-transfer concurrency to **8** on mobile (50 on desktop), exponential backoff with jitter, dirty set persisted so an interrupted push resumes instead of restarting, deltas applied idempotently (safe to re-fetch).

**Delta retention window: 30 days** (decided). Older deltas are pruned by compaction; a device offline longer than that takes the snapshot cold path once, then resumes normal delta sync.

---

# 2. Obsidian Plugin Module Spec

## 2.1 Components

| Component | Responsibility |
|---|---|
| `S3Client` | Signed GET/PUT/HEAD/DELETE (AWS SigV4, `aws4fetch` or SDK v3) |
| `SyncState` | Local persistence: `lastSyncedRev`, per-file `{hash, s3VersionId}` — stored in plugin data (`saveData()`), *not* in the vault |
| `ChangeTracker` | Listens to Obsidian `vault.on('create'/'modify'/'delete'/'rename')`, maintains dirty set |
| `SyncEngine` | Runs the protocol: push loop, poll loop, catch-up, merge |
| `Merger` | Three-way union merge — re-exported from shared `core` package (§5) |
| `SettingsTab` | Bucket, region, credentials, prefix, excluded folders (toggleable), poll interval |

## 2.2 Push (local → S3)

- `ChangeTracker` collects dirty paths; debounce **5 s** after last edit (don't upload mid-typing).
- Before pushing, hash each dirty file and compare against `SyncState` — **hash unchanged → drop from dirty set** (mtime-only touch, no push, no manifest write, per [[#1.6 mtime policy]]).
- Batch all dirty files into one write cycle per [[#1.3 Write algorithm (atomic, race-free)]].
- Renames = tombstone old path + new entry (rename detection not needed; content hash preserves cheapness).
- Excluded from sync: `.obsidian/**` (workspace/cache noise), plugin's own state, user-configured folder/glob patterns.

**Excluded folders are local-only** — never pushed, and incoming delta entries under an excluded path are skipped (not applied, not deleted). `lastSyncedRev` still advances; the skip is per-path.

**Re-enabling a folder**: its files have no `SyncState` entries, so they're treated as the first-run case scoped to that folder — local files join the dirty set, remote entries under the path are fetched; where both exist and hashes differ → union merge with empty base (pure union, nothing lost). One warning notice before the first re-enable sync ("N local / M remote files will be merged").

## 2.3 Notifications while running (poll)

- Every **15 s** (default, configurable): `LIST deltas/ StartAfter=<pad10(lastSyncedRev)>`. Empty → done — one ~free request per interval, no WebSocket infra needed.
- Keys returned → run [[#1.4 Read / catch-up algorithm]]; the LIST result already enumerates exactly which deltas to fetch. Apply remote changes via `vault.adapter` writes; suppress `ChangeTracker` events for files being written by the sync itself (internal echo suppression).
- Cost at 15 s: ~5,800 LISTs/day ≈ $0.03/month. Back off to 60 s when the app is backgrounded/idle (mobile battery).

> [!tip] Future upgrade
> If ~15 s latency ever feels slow: S3 Events → EventBridge → AWS IoT Core (MQTT over WebSocket), plugin subscribes. Protocol unchanged — push only replaces the poll trigger.

## 2.4 Offline catch-up

On plugin load / `onload()`:

1. Run full read cycle (1.4) with stored `lastSyncedRev` → pulls everything missed, including deletions via tombstones.
2. Diff local vault against `SyncState` hashes → detects files edited *while Obsidian was closed* (vault events don't fire when app is off) → these join the dirty set. Fast path: only hash files whose local mtime differs from `SyncState` — accurate because sync aligns mtimes (2.5); files caught by the pre-filter but hash-equal are dropped silently.
3. Overlap of (1) and (2) = conflicts → union merge.
4. Push cycle for dirty set.

First-ever run (empty state): treat all remote files as new, all local files as dirty; identical hashes reconcile silently, differing ones union-merge.

## 2.5 mtime alignment

- **Applying remote files**: write via `vault.adapter.write(path, data, { mtime })` with the manifest's `mtime` — Obsidian's `DataWriteOptions` supports setting it directly. The file lands with its original author-time, not sync-time.
- **Pushing local files**: record the file's local mtime into the manifest entry, so other devices inherit it.
- **After a union merge**: mtime = now on the merging device; it authored the merged content.
- `SyncState` stores the aligned mtime per file to keep the offline pre-filter (2.4) trustworthy.

## 2.6 Edge cases

- **Clock skew** — irrelevant: ordering uses `revision`, never wall time.
- **Concurrent devices** — CAS loop (1.3) serializes manifest writes; loser re-merges and retries.
- **Large paste / binary attachment** — files > 5 MB or non-text: last-writer-wins instead of union merge (union merging binary is meaningless).
- **Partial upload crash** — manifest never references unwritten objects (write ordering in 1.3).
- **Credential failure** — surface Obsidian notice, back off exponentially, never drop the dirty set (persisted).

---

# 3. Git Sync Module Spec

Runs in **GitHub Actions**. Also just a protocol client — it treats the *repo* as its "local vault" and the last-synced git state as its `SyncState`.

## 3.1 Triggers

```yaml
on:
  push:
    branches: [main]        # repo-side changes
  schedule:
    - cron: "*/15 * * * *"  # catch S3-side changes
  workflow_dispatch:         # manual

concurrency:
  group: s3-sync
  cancel-in-progress: false  # serialize runs; CAS (1.3) guards cross-client races
```

## 3.2 Stored state

- `lastSyncedRev` + `lastSyncedCommit` kept in `.sync/state.json` **committed to the repo** — versioned with the content it describes, survives runner teardown, no extra storage.
- Per-file hashes are *not* stored: git blob hashes + manifest hashes reconstruct everything.

## 3.3 Sync algorithm

```
1.  Shallow clone (fetch-depth enough to reach lastSyncedCommit)
2.  LIST deltas/ StartAfter=<lastSyncedRev> → GET new deltas
    (fall back to snapshot if behind retention window)
3.  gitChanged = git diff --name-status lastSyncedCommit..HEAD   ← O(changes)
4.  s3Changed  = delta entries where by != "git-sync"             ← echo suppression
                 (last delta per path wins)
5.  For each path in either set:
      only gitChanged → stage PUT to S3 (or tombstone if deleted in git)
      only s3Changed  → write into working tree (or git rm if tombstone)
      both            → union merge (shared core impl, see §5):
                          base   = git show lastSyncedCommit:path
                          ours   = HEAD version
                          theirs = GET from S3
                        → write result to working tree AND stage PUT to S3
6.  Commit repo-side changes as ONE commit:
      author  "s3-sync-bot", message "s3-sync: rev <N> [skip ci]"
7.  Execute S3 write cycle per 1.3 (parallel file PUTs + delta append)
8.  COMPACTION: fold new deltas into snapshot.json.gz (If-Match CAS),
    prune deltas > 30 days old, tombstones > 90 days old
9.  Update .sync/state.json (include it in the same commit), push
```

`[skip ci]` in the commit message plus the bot author prevents the push trigger from re-firing on the sync's own commit — the git-side half of echo suppression.

> [!note] Why compaction lives here
> The Actions runner has fast, free bandwidth; mobile clients don't. git-sync is the *only* writer of `snapshot.json.gz`, so snapshot writes need no multi-writer coordination beyond the `concurrency` group. The `*/15` cron doubles as the compaction schedule.

## 3.4 `.gitignore` handling & GitHub-only folders

Two distinct exclusion mechanisms:

**`.gitignore` — keeps files out of the repo.** Ignored files must never enter git, in either direction:

- **git → S3**: automatic — `git diff` only ever reports *tracked* files; ignored files are invisible by construction.
- **S3 → git**: before writing any S3-originated file into the working tree, batch-check:

  ```bash
  git check-ignore --stdin < candidate-paths
  ```

  Paths that match are **skipped and left untouched in S3** — they stay plugin-visible (e.g. private notes, scratch dirs) but never get committed. Log skipped paths in the run summary.

**`.s3syncignore` — keeps folders out of S3 (GitHub-only).** A file at repo root, gitignore syntax, committed and therefore versioned/reviewable:

- **git → S3**: paths matching `.s3syncignore` are filtered out of `gitChanged` before step 5 — never PUT, never tombstoned. They exist only in the repo (e.g. CI config, templates, drafts not meant for the vault).
- **S3 → git**: a delta entry under a GitHub-only path shouldn't normally exist (nothing pushed it); if one appears (plugin misconfiguration), skip it and warn loudly — never let S3 overwrite a GitHub-only path.
- Editing `.s3syncignore` to *un-exclude* a folder: the next run sees its files absent from S3 state → treats them as new git-side changes → normal push. Re-excluding simply stops future syncs; existing S3 copies are left as-is (prune manually if desired).

Mirror of the plugin's local-only folders ([[#2.2 Push (local → S3)]]) — each side can hold back its own subtrees; S3 carries only the intersection both sides agreed to share.

- `.sync/state.json` and `.s3syncignore` are force-tracked; snapshot/deltas never enter the repo.

## 3.5 mtime handling

Git doesn't store mtimes — checkout stamps files with "now" — so on the git side mtime is unusable even as a hint:

- **Change detection**: hashes only (`git diff` / blob hashes), never filesystem mtime. This falls out of the algorithm in 3.3 anyway.
- **git → S3**: manifest `mtime` = the commit's author date for that path (`git log -1 --format=%aI -- <path>`) — best available author-time.
- **S3 → git**: manifest mtime is ignored (git can't persist it); content lands in the commit, mtime survives on the S3/plugin side untouched.
- git-sync never writes mtime-only manifest updates (per [[#1.6 mtime policy]]).

## 3.6 Performance profile

| Operation | Cost |
|---|---|
| Detect repo changes | 1 git command, O(changed files) |
| Detect S3 changes | 1 LIST + tiny delta GETs |
| Transfer | changed files only, 50-way parallel |
| Typical run (≤ 100 changed) | seconds; well under Actions minimums |

Auth: S3 access via **GitHub OIDC → IAM role** (no long-lived keys in secrets).

## 3.7 Edge cases

- **Force-push / history rewrite** — `lastSyncedCommit` unreachable → fall back to full-state diff: hash every tracked file vs manifest hashes; conflicts merge with S3 content as theirs, empty base (pure union). Slow-path, logged loudly.
- **Concurrent Actions runs** — prevented by `concurrency` group; cross-client races handled by CAS.
- **Merge produces invalid file** — never blocks sync; union merge is content-agnostic for text.
- **Branch protection on main** — bot commits via a PAT/GitHub App with bypass, or sync to a `sync` branch + auto-PR (config option).

---

# 4. Failure & recovery summary

| Failure | Recovery |
|---|---|
| Delta write race (same rev) | 412 on `If-None-Match` → apply winner's delta, retry at rev+1 (~300 B cost) |
| Client crash mid-push | Files-before-delta ordering → no dangling refs; dirty set persisted |
| Snapshot corrupted/lost | Rebuild by replaying deltas; worst case list bucket + hash objects (S3 Versioning keeps history) |
| Client behind delta retention | Cold path: fetch snapshot (~600 KB), full diff, resume normal deltas |
| Divergent offline edits | Three-way union merge via versioned base |
| Sync loop | Dual echo suppression: `by` field + `[skip ci]` bot commits |
| Corrupt S3 object | Manifest hash mismatch on apply → skip + alert, re-fetch |

# 5. Implementation notes

**Language: TypeScript on both sides.** The plugin is TypeScript anyway; the decisive reason is that the *protocol must behave identically* on both legs — especially the union merge. Two merge implementations (e.g. `node-diff3` in the plugin vs `git merge-file --union` in Actions) can produce subtly different output for the same conflict, and any difference becomes a phantom change that ripples back through sync. One shared implementation eliminates the bug class.

**Monorepo layout:**

```
sync/
  packages/
    core/               ← shared protocol client (no I/O assumptions)
      schemas.ts          delta/snapshot types + validation
      journal.ts          CAS append (1.3), LIST/replay (1.4)
      merge.ts            three-way union merge (node-diff3) — single source of truth
      hash.ts             MD5 content hashing
      s3.ts               storage interface (impl injected per side)
    obsidian-plugin/    ← 2.x spec; S3 via aws4fetch (small bundle, mobile-safe)
    git-sync/           ← 3.x spec; CLI run in Actions (npx tsx / bundled)
                          S3 via AWS SDK v3, git via execa → git CLI
```

Notes:

- `core` is pure logic — no Node or Obsidian APIs — so it runs unmodified in the plugin (Electron/mobile) and the Actions runner. Storage and filesystem are injected interfaces.
- Git operations in `git-sync` are plain `git` CLI calls (`diff`, `check-ignore`, `show`, `log`) via `execa`; no git library needed.
- Node is preinstalled on GitHub runners; the workflow is `npm ci && npx tsx packages/git-sync/src/main.ts` (or a prebuilt single-file bundle via esbuild for faster cold starts).
- Test strategy: protocol conformance tests live in `core` and run once for both consumers; merge fixtures (conflict → expected union output) are the critical suite.
- Rejected: Python/Go for git-sync — would mean implementing and maintaining the protocol twice plus proving merge parity; Bash — can't express the merge/CAS logic sanely.

# 6. Decided

- Delta retention window: **30 days**
- All S3 JSON objects **gzipped**
- Plugin excluded folders: **local-only until re-enabled**; re-enable = scoped first-run merge (2.2)
- Git-side `.s3syncignore`: **GitHub-only folders**, never pushed to S3 (3.4)
- Client-side encryption: **rejected** — the git repo holds a plaintext copy of the same content, so it adds key-management complexity without a real confidentiality gain; SSE-S3 (at rest) + TLS (in transit) + a private bucket suffice
