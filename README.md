# vault-sync

Two-way sync: **GitHub repo ⇄ S3 ⇄ Obsidian vault**, built for ~20k small text files, bad mobile connections, and union-merge conflict resolution (all changes kept, no markers, nothing lost).

S3 is the hub; both legs speak one protocol: an append-only **delta journal** (`deltas/<rev>.json.gz`, CAS via `If-None-Match`) plus a periodic **snapshot** compacted by the GitHub Actions job. Sync traffic is proportional to changes, never vault size.

| Package | What |
|---|---|
| `packages/core` | Shared protocol client: schemas, delta journal, CAS, **the** union merge (node-diff3), hashing. Pure logic, no platform APIs. Conformance tests live here. |
| `packages/git-sync` | CLI run by GitHub Actions (`templates/s3-sync.yml`): repo ⇄ S3, `.gitignore`-aware, `.s3syncignore` for GitHub-only folders, snapshot compaction + 30-day delta pruning. |
| `packages/obsidian-plugin` | Vault ⇄ S3: 15 s LIST polling, offline catch-up, mtime alignment, excluded (local-only) folders, versioned merge bases. Desktop + mobile. |

```bash
npm install
npm test              # protocol + merge-fixture tests
npm run typecheck
npm run build:plugin  # → packages/obsidian-plugin/dist/main.js
```

Deployment: see **SETUP.md**. Design rationale (the "why"): **System Design.md**. Implementation reference as built (the "what"): **IMPLEMENTATION.md**.
