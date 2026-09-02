import { appendDelta, contentHash, InMemoryStorage, type Delta } from "@vault-sync/core";
import { describe, expect, it } from "vitest";
import { FILES_PREFIX, PathError, SearchError, VaultClient } from "../src/vault";

const enc = (s: string) => new TextEncoder().encode(s);

function setup(concurrency = 16) {
  const storage = new InMemoryStorage();
  return { storage, vault: new VaultClient(storage, concurrency) };
}

/** Seed notes in order; each write is its own rev, so later writes have later mtimes. */
async function seed(vault: VaultClient, notes: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(notes)) await vault.write(path, enc(text));
}

/** Seed one note with an explicit mtime — `write()` stamps `now`, so ordering needs this. */
async function seedAt(storage: InMemoryStorage, rev: number, path: string, text: string, mtime: string) {
  const bytes = enc(text);
  const put = await storage.put(FILES_PREFIX + path, bytes);
  await appendDelta(storage, rev, (r): Delta => ({
    rev: r,
    by: "laptop-1",
    at: mtime,
    files: { [path]: { hash: contentHash(bytes), size: bytes.byteLength, mtime, s3VersionId: put.versionId } },
  }));
}

const paths = (r: { hits: { path: string }[] }): string[] => r.hits.map((h) => h.path);

describe("VaultClient.search", () => {
  it("finds a literal match and reports the line number and text", async () => {
    const { vault } = setup();
    await seed(vault, {
      "notes/a.md": "# Title\n\nthe quick brown fox\ntrailing\n",
      "notes/b.md": "nothing here\n",
    });

    const res = await vault.search({ query: "brown fox" });
    expect(paths(res)).toEqual(["notes/a.md"]);
    expect(res.hits[0].matches).toEqual([{ line: 3, text: "the quick brown fox" }]);
    expect(res.hits[0].pathMatch).toBe(false);
    expect(res).toMatchObject({ scanned: 2, candidates: 2, truncated: false });
  });

  it("is case-insensitive by default and exact when asked", async () => {
    const { vault } = setup();
    await seed(vault, { "a.md": "Roadmap for Q3\n" });

    expect(paths(await vault.search({ query: "roadmap" }))).toEqual(["a.md"]);
    expect(paths(await vault.search({ query: "roadmap", caseSensitive: true }))).toEqual([]);
    expect(paths(await vault.search({ query: "Roadmap", caseSensitive: true }))).toEqual(["a.md"]);
  });

  it("matches on the path too, without reading the note", async () => {
    const { vault } = setup();
    await seed(vault, { "projects/roadmap.md": "unrelated content\n" });

    const res = await vault.search({ query: "roadmap" });
    expect(res.hits[0]).toMatchObject({ path: "projects/roadmap.md", pathMatch: true, matches: [] });
    // The path hit is free: nothing was read to produce it.
    expect(res.scanned).toBe(0);
  });

  it("pathOnly skips content entirely", async () => {
    const { vault } = setup();
    await seed(vault, { "a.md": "mentions widgets\n", "widgets.md": "empty\n" });

    const res = await vault.search({ query: "widgets", pathOnly: true });
    expect(paths(res)).toEqual(["widgets.md"]);
    expect(res.scanned).toBe(0);
  });

  it("supports regular expressions and rejects an invalid one with a usable message", async () => {
    const { vault } = setup();
    await seed(vault, { "a.md": "TODO(2026-09-02): ship it\n", "b.md": "todo tomorrow\n" });

    const res = await vault.search({ query: "TODO\\(\\d{4}-\\d{2}-\\d{2}\\)", regex: true, caseSensitive: true });
    expect(paths(res)).toEqual(["a.md"]);

    await expect(vault.search({ query: "(unclosed", regex: true })).rejects.toThrow(SearchError);
    await expect(vault.search({ query: "" })).rejects.toThrow(SearchError);
  });

  // A /g/ regex keeps lastIndex between .test() calls, which silently skips every other match.
  it("reports consecutive matching lines (no regex lastIndex carry-over)", async () => {
    const { vault } = setup();
    await seed(vault, { "a.md": "hit one\nhit two\nhit three\n" });

    const res = await vault.search({ query: "^hit", regex: true });
    expect(res.hits[0].matches.map((m) => m.line)).toEqual([1, 2, 3]);
  });

  it("scopes to a directory and rejects an unsafe one", async () => {
    const { vault } = setup();
    await seed(vault, { "in/a.md": "target\n", "out/b.md": "target\n" });

    expect(paths(await vault.search({ query: "target", dir: "in" }))).toEqual(["in/a.md"]);
    await expect(vault.search({ query: "target", dir: "../up" })).rejects.toThrow(PathError);
  });

  it("never surfaces dot-paths or tombstoned notes", async () => {
    const { vault, storage } = setup();
    await seed(vault, { "a.md": "secret sauce\n" });
    await vault.remove("a.md");
    // A config file synced by another leg: present in the fold, invisible to the MCP scope.
    await storage.put(FILES_PREFIX + ".obsidian/app.json", enc("secret sauce"));

    expect(await vault.search({ query: "secret sauce" })).toMatchObject({ hits: [], candidates: 0 });
  });

  // Recency ordering is what makes a truncated scan useful: the notes most likely to matter are
  // the ones that survive the budget.
  it("returns the most recently modified notes first", async () => {
    const { vault, storage } = setup();
    await seedAt(storage, 1, "old.md", "shared", "2026-01-01T00:00:00.000Z");
    await seedAt(storage, 2, "new.md", "shared", "2026-09-01T00:00:00.000Z");
    await seedAt(storage, 3, "mid.md", "shared", "2026-05-01T00:00:00.000Z");
    expect(paths(await vault.search({ query: "shared" }))).toEqual(["new.md", "mid.md", "old.md"]);
  });

  it("caps results and matches per note, and says it truncated", async () => {
    const { vault } = setup();
    await seed(vault, { "a.md": "x\nx\nx\nx\n", "b.md": "x\n", "c.md": "x\n" });

    const capped = await vault.search({ query: "x", maxResults: 2 });
    expect(capped.hits).toHaveLength(2);
    expect(capped).toMatchObject({ truncated: true, reason: "result limit reached" });

    const perFile = await vault.search({ query: "x", maxMatchesPerFile: 2 });
    expect(perFile.hits.find((h) => h.path === "a.md")!.matches).toHaveLength(2);
    expect(perFile.truncated).toBe(false);
  });

  it("stops on the time budget rather than running to the end of a big vault", async () => {
    const { vault } = setup(1);
    await seed(vault, { "a.md": "needle\n", "b.md": "needle\n", "c.md": "needle\n" });

    // Budget already spent: the scan gives up before reading anything and reports why.
    const res = await vault.search({ query: "needle", timeBudgetMs: -1 });
    expect(res).toMatchObject({ hits: [], scanned: 0, truncated: true, reason: "time budget exhausted" });
    expect(res.candidates).toBe(3);
  });

  it("truncates a very long matching line instead of returning the whole thing", async () => {
    const { vault } = setup();
    await seed(vault, { "a.md": "needle " + "x".repeat(5_000) + "\n" });

    const [match] = (await vault.search({ query: "needle" })).hits[0].matches;
    expect(match.text.length).toBeLessThan(300);
    expect(match.text.endsWith("…")).toBe(true);
  });

  it("searches notes only — an attachment with matching bytes is not a hit", async () => {
    const { vault } = setup();
    await seed(vault, { "a.md": "unrelated\n" });
    await vault.write("assets/notes.txt", enc("needle"));

    expect(await vault.search({ query: "needle" })).toMatchObject({ hits: [], candidates: 1 });
  });

  it("reads content pinned to the journal version, like every other read", async () => {
    const { vault, storage } = setup();
    await seed(vault, { "a.md": "committed needle\n" });
    // Racing writer: object PUT landed, its delta has not — the search must not see it.
    await storage.put(FILES_PREFIX + "a.md", enc("in-flight needle\n"));

    const res = await vault.search({ query: "needle" });
    expect(res.hits[0].matches[0].text).toBe("committed needle");
  });
});
