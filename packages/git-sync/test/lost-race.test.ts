import { describe, expect, it } from "vitest";
import type { Delta, DeltaEntry } from "@vault-sync/core";
import { onLostRace } from "../src/reconcile";

/**
 * git-sync's half of the lockstep rule the plugin enforces in its own onLostRace (§6): a delta that
 * lost the CAS race must never be republished over a winner that touched the same path. Everything
 * in a run's payload was reconciled against the revision the run STARTED from, so on a collision
 * those bytes are stale by definition.
 */

const entry = (hash: string): DeltaEntry => ({
  hash,
  s3VersionId: `v-${hash}`,
  size: 10,
  mtime: "2026-08-19T19:56:36.223Z",
});

const winnerDelta = (files: Record<string, DeltaEntry>): Delta => ({
  rev: 5959,
  by: "linux-5791",
  at: "2026-08-19T19:56:42.787Z",
  files,
});

describe("git-sync lost CAS race", () => {
  it("retries past a winner that touched only paths this run is not publishing", () => {
    const warnings: string[] = [];
    const payload: Record<string, DeltaEntry> = { "notes/a.md": entry("md5:aaa") };

    expect(() =>
      onLostRace(winnerDelta({ "notes/b.md": entry("md5:bbb") }), payload, 5958, (m) =>
        warnings.push(m),
      ),
    ).not.toThrow();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("linux-5791@5959");
    // The payload is untouched — this run still publishes its own uncontested work.
    expect(Object.keys(payload)).toEqual(["notes/a.md"]);
  });

  it("refuses to publish over a winner that touched a path this run is also carrying", () => {
    const warnings: string[] = [];
    const payload: Record<string, DeltaEntry> = {
      "diary/2026/2026-08-19.md": entry("md5:stale"),
      "notes/a.md": entry("md5:aaa"),
    };

    expect(() =>
      onLostRace(
        winnerDelta({ "diary/2026/2026-08-19.md": entry("md5:theirs") }),
        payload,
        5958,
        (m) => warnings.push(m),
      ),
    ).toThrow(/diary\/2026\/2026-08-19\.md/);
    // A refusal, not a warning — the run fails loudly instead of reverting someone's note.
    expect(warnings).toHaveLength(0);
  });

  it("names the baseline the stale payload was reconciled against", () => {
    expect(() =>
      onLostRace(winnerDelta({ "notes/a.md": entry("md5:theirs") }), { "notes/a.md": entry("md5:ours") }, 5958, () => {}),
    ).toThrow(/rev 5958/);
  });

  it("collides on tombstones too — a delete racing our edit is still a collision", () => {
    expect(() =>
      onLostRace(
        winnerDelta({ "notes/a.md": { deleted: true } }),
        { "notes/a.md": entry("md5:ours") },
        5958,
        () => {},
      ),
    ).toThrow(/notes\/a\.md/);
  });

  it("truncates a long collision list rather than dumping every path", () => {
    const payload: Record<string, DeltaEntry> = {};
    const winnerFiles: Record<string, DeltaEntry> = {};
    for (let i = 0; i < 9; i++) {
      payload[`n${i}.md`] = entry(`md5:ours${i}`);
      winnerFiles[`n${i}.md`] = entry(`md5:theirs${i}`);
    }
    expect(() => onLostRace(winnerDelta(winnerFiles), payload, 42, () => {})).toThrow(
      /9 path\(s\).*, …/s,
    );
  });
});
