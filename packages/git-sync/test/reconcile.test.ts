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
    fetchRemote: async (p) => remote.get(p) ?? null,
    writeLocal: async (p, bytes) => void writes.set(p, bytes),
    removeLocal: async (p) => void removes.push(p),
    mergeBase: async (p) => base.get(p) ?? "",
    authorDate: async () => "2026-07-13T00:00:00.000Z",
    log: () => {},
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
    const action = await reconcileFile("inbox/img.jpg", "upsert", undefined, { files: {} }, io);

    const up = asUpload(action);
    expect([...up.content]).toEqual([...JPEG]); // identical bytes
    expect(up.entry.size).toBe(JPEG.byteLength); // 16, not inflated
    expect(up.entry.hash).toBe(contentHash(JPEG));
  });

  it("S3 → git: writes a downloaded binary byte-for-byte", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xc0, 0x80]);
    const entry = remoteEntry(png);
    const { io, writes } = makeIO({ remote: { "a.png": png } });

    const action = await reconcileFile("a.png", undefined, entry, { files: { "a.png": entry } }, io);
    expect(action).toBeNull();
    expect([...writes.get("a.png")!]).toEqual([...png]);
  });

  it("git → S3: skips upload when the binary already hash-matches S3 (idempotence)", async () => {
    const entry = remoteEntry(JPEG);
    const { io } = makeIO({ local: { "img.jpg": JPEG } });
    // git-only change, but remote already holds identical bytes → nothing to push
    const action = await reconcileFile("img.jpg", "upsert", undefined, { files: { "img.jpg": entry } }, io);
    expect(action).toBeNull();
  });

  it("binary conflict (both changed): last-writer-wins keeps git's bytes and re-pushes", async () => {
    const gitBytes = new Uint8Array([0xff, 0x01, 0x80, 0x02]);
    const s3Bytes = new Uint8Array([0xff, 0x09, 0x80, 0x0a]);
    const entry = remoteEntry(s3Bytes);
    const { io, writes } = makeIO({ local: { "x.bin": gitBytes }, remote: { "x.bin": s3Bytes } });

    const action = await reconcileFile("x.bin", "upsert", entry, { files: { "x.bin": entry } }, io);
    expect([...asUpload(action).content]).toEqual([...gitBytes]); // git wins, byte-clean
    expect(writes.has("x.bin")).toBe(false); // working tree already has git's bytes
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

    const action = await reconcileFile("n.md", "upsert", entry, { files: { "n.md": entry } }, io);
    const mergedUp = decodeText(asUpload(action).content);
    expect(mergedUp).toContain("local-add");
    expect(mergedUp).toContain("remote-add");
    expect(decodeText(writes.get("n.md")!)).toBe(mergedUp); // working tree updated to the merge
  });
});
