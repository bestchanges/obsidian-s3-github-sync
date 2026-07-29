import { describe, expect, it } from "vitest";
import { contentHash, decodeText, encodeText, FileEntry, SnapshotEntry } from "@vault-sync/core";
import { reconcileFile, ReconcileIO, UploadAction } from "../src/reconcile";

/** In-memory IO seam: seed local/remote bytes + merge bases, record writes/removes. */
function makeIO(seed: {
  local?: Record<string, Uint8Array>;
  remote?: Record<string, Uint8Array>;
  base?: Record<string, string>;
}) {
  const local = new Map(Object.entries(seed.local ?? {}));
  const remote = new Map(Object.entries(seed.remote ?? {}));
  const base = new Map(Object.entries(seed.base ?? {}));
  const writes = new Map<string, Uint8Array>();
  const removes: string[] = [];
  const io: ReconcileIO = {
    readLocal: async (p) => local.get(p) ?? null,
    existsLocal: async (p) => local.has(p),
    fetchRemote: async (p) => remote.get(p) ?? null,
    writeLocal: async (p, bytes) => void writes.set(p, bytes),
    removeLocal: async (p) => void removes.push(p),
    mergeBase: async (p) => base.get(p) ?? "",
    authorDate: async () => "2026-07-13T00:00:00.000Z",
  };
  return { io, writes, removes };
}

function remoteEntry(bytes: Uint8Array): SnapshotEntry {
  return {
    hash: contentHash(bytes),
    size: bytes.byteLength,
    mtime: "2026-07-13T00:00:00.000Z",
    s3VersionId: "v1",
    rev: 2,
    by: "obsidian",
  } as SnapshotEntry;
}

// Bytes with JPEG-ish magic and many values invalid as standalone UTF-8 (0x80-0xFF) — decoding these
// as text and re-encoding is lossy AND inflating, which was the exact corruption bug.
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x80, 0x81, 0xc0, 0xfe, 0xff, 0x00,
]);
const asUpload = (a: UploadAction | null) => a as { content: Uint8Array; entry: FileEntry };

describe("reconcileFile binary safety", () => {
  it("sanity: UTF-8 round-trip WOULD corrupt and inflate this binary (the old bug)", () => {
    const roundTripped = encodeText(decodeText(JPEG));
    expect([...roundTripped]).not.toEqual([...JPEG]); // lossy
    expect(roundTripped.byteLength).toBeGreaterThan(JPEG.byteLength); // inflated
  });

  it("git → S3: uploads a binary byte-for-byte, no corruption or inflation", async () => {
    const { io } = makeIO({ local: { "inbox/img.jpg": JPEG } });
    const { action } = await reconcileFile("inbox/img.jpg", "upsert", undefined, { files: {} }, io);

    const up = asUpload(action);
    expect([...up.content]).toEqual([...JPEG]); // identical bytes
    expect(up.entry.size).toBe(JPEG.byteLength); // 16, not inflated
    expect(up.entry.hash).toBe(contentHash(JPEG));
  });

  it("S3 → git: writes a downloaded binary byte-for-byte", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xc0, 0x80]);
    const entry = remoteEntry(png);
    const { io, writes } = makeIO({ remote: { "a.png": png } });

    const { action } = await reconcileFile("a.png", undefined, entry, { files: { "a.png": entry } }, io);
    expect(action).toBeNull();
    expect([...writes.get("a.png")!]).toEqual([...png]);
  });

  it("git → S3: skips upload when the binary already hash-matches S3 (idempotence)", async () => {
    const entry = remoteEntry(JPEG);
    const { io } = makeIO({ local: { "img.jpg": JPEG } });
    // git-only change, but remote already holds identical bytes → nothing to push
    const { action } = await reconcileFile("img.jpg", "upsert", undefined, { files: { "img.jpg": entry } }, io);
    expect(action).toBeNull();
  });

  it("binary conflict (both changed): freshest-wins keeps git's bytes on an mtime tie and re-pushes", async () => {
    const gitBytes = new Uint8Array([0xff, 0x01, 0x80, 0x02]);
    const s3Bytes = new Uint8Array([0xff, 0x09, 0x80, 0x0a]);
    const entry = remoteEntry(s3Bytes); // mtime == the IO's authorDate → tie → git side keeps
    const { io, writes } = makeIO({ local: { "x.bin": gitBytes }, remote: { "x.bin": s3Bytes } });

    const { action } = await reconcileFile("x.bin", "upsert", entry, { files: { "x.bin": entry } }, io);
    expect([...asUpload(action).content]).toEqual([...gitBytes]); // git wins the tie, byte-clean
    expect(writes.has("x.bin")).toBe(false); // working tree already has git's bytes
  });

  it("binary conflict: a strictly-newer S3 mtime wins freshest-wins → take remote, no push", async () => {
    const gitBytes = new Uint8Array([0xff, 0x01, 0x80, 0x02]);
    const s3Bytes = new Uint8Array([0xff, 0x09, 0x80, 0x0a]);
    const entry = { ...remoteEntry(s3Bytes), mtime: "2027-01-01T00:00:00.000Z" } as SnapshotEntry;
    const { io, writes } = makeIO({ local: { "x.bin": gitBytes }, remote: { "x.bin": s3Bytes } });

    const { action } = await reconcileFile("x.bin", "upsert", entry, { files: { "x.bin": entry } }, io);
    expect(action).toBeNull(); // remote newer → nothing pushed up
    expect([...writes.get("x.bin")!]).toEqual([...s3Bytes]); // working tree updated to S3's bytes
  });

  it("config JSON conflict resolves by freshest-wins, NOT union-merge (no line duplication)", async () => {
    // A line-based union merge of divergent JSON stacks both sides → duplicated keys. Freshest-wins
    // takes the whole newer side instead. Here S3 is newer, so its content wins verbatim.
    const gitJson = encodeText('{"theme":"light"}\n');
    const s3Json = encodeText('{"theme":"dark"}\n');
    const entry = { ...remoteEntry(s3Json), mtime: "2027-01-01T00:00:00.000Z" } as SnapshotEntry;
    const { io, writes } = makeIO({
      local: { ".obsidian/appearance.json": gitJson },
      remote: { ".obsidian/appearance.json": s3Json },
      base: { ".obsidian/appearance.json": '{"theme":"system"}\n' },
    });

    const { action } = await reconcileFile(
      ".obsidian/appearance.json",
      "upsert",
      entry,
      { files: { ".obsidian/appearance.json": entry } },
      io,
    );
    expect(action).toBeNull(); // remote newer → take it, nothing pushed
    expect(decodeText(writes.get(".obsidian/appearance.json")!)).toBe(decodeText(s3Json)); // verbatim, not merged
  });

  // Base-aware fast-forward: a side whose content equals the last-agreed base didn't really change,
  // so the other side wins outright — no mtime race. This is the direct fix for the manifest revert.
  const MANIFEST = ".obsidian/plugins/calendar-tracker/manifest.json";
  const v020 = encodeText('{"id":"calendar-tracker","version":"0.2.0"}\n');
  const v021 = encodeText('{"id":"calendar-tracker","version":"0.2.1"}\n');

  it("REGRESSION: a stale re-push of the OLD content (== base) does NOT revert git's newer edit", async () => {
    // git has the new 0.2.1; S3 holds a re-uploaded OLD 0.2.0 (== base) with a STRICTLY NEWER mtime.
    // Old freshest-wins took S3's 0.2.0 (the revert); base-ff keeps git's 0.2.1 regardless of mtime.
    const entry = { ...remoteEntry(v020), mtime: "2099-01-01T00:00:00.000Z" } as SnapshotEntry;
    const { io, writes } = makeIO({
      local: { [MANIFEST]: v021 },
      remote: { [MANIFEST]: v020 },
      base: { [MANIFEST]: decodeText(v020) },
    });

    const { action } = await reconcileFile(MANIFEST, "upsert", entry, { files: { [MANIFEST]: entry } }, io);
    expect(decodeText(asUpload(action).content)).toBe(decodeText(v021)); // git's 0.2.1 re-pushed
    expect(writes.has(MANIFEST)).toBe(false); // working tree NOT reverted to 0.2.0
  });

  it("base-ff mirror: git side unchanged from base → take remote's genuine edit, no push", async () => {
    const entry = { ...remoteEntry(v021), mtime: "2020-01-01T00:00:00.000Z" } as SnapshotEntry; // even with OLDER mtime
    const { io, writes } = makeIO({
      local: { [MANIFEST]: v020 }, // == base, git didn't really change it
      remote: { [MANIFEST]: v021 },
      base: { [MANIFEST]: decodeText(v020) },
    });

    const { action } = await reconcileFile(MANIFEST, "upsert", entry, { files: { [MANIFEST]: entry } }, io);
    expect(action).toBeNull(); // nothing to push
    expect(decodeText(writes.get(MANIFEST)!)).toBe(decodeText(v021)); // took remote's 0.2.1
  });

  it("genuine divergence (both differ from base) still resolves by freshest-wins", async () => {
    // base 0.1.0, git 0.2.1, S3 0.2.0 with a newer mtime — a real concurrent conflict, NOT a no-op
    // re-push, so base-ff doesn't apply and the mtime tiebreak governs (the residual semver case).
    const v010 = encodeText('{"id":"calendar-tracker","version":"0.1.0"}\n');
    const entry = { ...remoteEntry(v020), mtime: "2099-01-01T00:00:00.000Z" } as SnapshotEntry;
    const { io, writes } = makeIO({
      local: { [MANIFEST]: v021 },
      remote: { [MANIFEST]: v020 },
      base: { [MANIFEST]: decodeText(v010) },
    });

    const { action } = await reconcileFile(MANIFEST, "upsert", entry, { files: { [MANIFEST]: entry } }, io);
    expect(action).toBeNull(); // remote's newer mtime wins the true conflict
    expect(decodeText(writes.get(MANIFEST)!)).toBe(decodeText(v020));
  });

  it("text conflict (both changed): still three-way union-merges", async () => {
    const base = "line1\nline2\n";
    const local = "line1\nline2\nlocal-add\n";
    const remoteText = "remote-add\nline1\nline2\n";
    const entry = remoteEntry(encodeText(remoteText));
    const { io, writes } = makeIO({
      local: { "n.md": encodeText(local) },
      remote: { "n.md": encodeText(remoteText) },
      base: { "n.md": base },
    });

    const { action } = await reconcileFile("n.md", "upsert", entry, { files: { "n.md": entry } }, io);
    const mergedUp = decodeText(asUpload(action).content);
    expect(mergedUp).toContain("local-add");
    expect(mergedUp).toContain("remote-add");
    expect(decodeText(writes.get("n.md")!)).toBe(mergedUp); // working tree updated to the merge
  });
});

describe("reconcileFile outcome classification (for logging)", () => {
  it("git → S3 of a brand-new key reports pushed{created:true}", async () => {
    const { io } = makeIO({ local: { "notes/idea.md": encodeText("hi\n") } });
    const { outcome } = await reconcileFile("notes/idea.md", "upsert", undefined, { files: {} }, io);
    expect(outcome).toEqual({ kind: "pushed", created: true });
  });

  it("git → S3 of an existing key reports pushed{created:false}", async () => {
    const oldBytes = encodeText("old\n");
    const newBytes = encodeText("new\n");
    const entry = remoteEntry(oldBytes);
    const { io } = makeIO({ local: { "n.md": newBytes } });
    // remote entry present & non-tombstone → update, not create
    const { outcome } = await reconcileFile("n.md", "upsert", undefined, { files: { "n.md": entry } }, io);
    expect(outcome).toEqual({ kind: "pushed", created: false });
  });

  it("S3 → git of a file absent locally reports pulled{created:true}", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const entry = remoteEntry(png);
    const { io } = makeIO({ remote: { "a.png": png } }); // not in local → existsLocal false
    const { outcome } = await reconcileFile("a.png", undefined, entry, { files: { "a.png": entry } }, io);
    expect(outcome).toEqual({ kind: "pulled", created: true });
  });

  it("S3 → git overwriting a present file reports pulled{created:false}", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const entry = remoteEntry(png);
    const { io } = makeIO({ local: { "a.png": new Uint8Array([1]) }, remote: { "a.png": png } });
    const { outcome } = await reconcileFile("a.png", undefined, entry, { files: { "a.png": entry } }, io);
    expect(outcome).toEqual({ kind: "pulled", created: false });
  });

  it("git delete → S3 tombstone reports tombstoned", async () => {
    const entry = remoteEntry(encodeText("x\n"));
    const { io } = makeIO({});
    const { action, outcome } = await reconcileFile("gone.md", "delete", undefined, { files: { "gone.md": entry } }, io);
    expect(action).toEqual({ tombstone: true });
    expect(outcome).toEqual({ kind: "tombstoned" });
  });

  it("S3 tombstone → local delete reports deletedLocal", async () => {
    const tomb = { deleted: true, mtime: "2026-07-13T00:00:00.000Z", rev: 2, by: "obsidian" } as unknown as SnapshotEntry;
    const { io, removes } = makeIO({ local: { "gone.md": encodeText("x\n") } });
    const { outcome } = await reconcileFile("gone.md", undefined, tomb, { files: { "gone.md": tomb } }, io);
    expect(removes).toContain("gone.md");
    expect(outcome).toEqual({ kind: "deletedLocal" });
  });

  it("union merge with a real conflict reports merged{conflicts:true}", async () => {
    // divergent edits to the SAME line → union merge hits a conflict
    const base = "line1\n";
    const entry = remoteEntry(encodeText("remote-line\n"));
    const { io } = makeIO({
      local: { "n.md": encodeText("local-line\n") },
      remote: { "n.md": encodeText("remote-line\n") },
      base: { "n.md": base },
    });
    const { outcome } = await reconcileFile("n.md", "upsert", entry, { files: { "n.md": entry } }, io);
    expect(outcome).toEqual({ kind: "merged", conflicts: true });
  });

  it("an idempotent git-only re-push reports noop", async () => {
    const bytes = encodeText("same\n");
    const entry = remoteEntry(bytes);
    const { io } = makeIO({ local: { "n.md": bytes } });
    const { action, outcome } = await reconcileFile("n.md", "upsert", undefined, { files: { "n.md": entry } }, io);
    expect(action).toBeNull();
    expect(outcome).toEqual({ kind: "noop" });
  });
});

// Mirror of the plugin's delete-vs-edit freshness tiebreak (engine.ts editWinsOverDelete). git still
// holds a path (gitChanged=upsert) that S3 has tombstoned — the cross-device rename case. authorDate
// is fixed at 2026-07-13 by makeIO, so the tombstone's `at` controls who wins.
describe("reconcileFile delete-vs-edit freshness (rename resurrection)", () => {
  const OLD = "projects/renamed-away.md";
  const tombstone = (at: string): SnapshotEntry =>
    ({ deleted: true, rev: 3, by: "obsidian", at } as unknown as SnapshotEntry);

  it("tombstone NEWER than the git edit → delete wins, remove locally, nothing re-pushed", async () => {
    const local = encodeText("stale pre-rename body\n");
    const ts = tombstone("2026-07-14T00:00:00.000Z"); // newer than authorDate (2026-07-13)
    const { io, removes } = makeIO({ local: { [OLD]: local } });

    const { action, outcome } = await reconcileFile(OLD, "upsert", ts, { files: { [OLD]: ts } }, io);

    expect(action).toBeNull(); // NOT re-published to S3 (no resurrection)
    expect(removes).toContain(OLD); // removed from the git tree
    expect(outcome).toEqual({ kind: "deletedLocal" });
  });

  it("tombstone OLDER than the git edit → edit wins, re-pushed (genuine post-delete edit)", async () => {
    const local = encodeText("edited AFTER the delete\n");
    const ts = tombstone("2026-07-12T00:00:00.000Z"); // older than authorDate (2026-07-13)
    const { io, removes } = makeIO({ local: { [OLD]: local } });

    const { action, outcome } = await reconcileFile(OLD, "upsert", ts, { files: { [OLD]: ts } }, io);

    expect([...asUpload(action).content]).toEqual([...local]); // re-published (un-tombstoned)
    expect(removes).not.toContain(OLD);
    expect(outcome).toEqual({ kind: "pushed", created: true });
  });
});
