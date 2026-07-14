import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, Snapshot } from "@vault-sync/core";
import { DEFAULT_SNAPSHOT_MAX_AGE_HOURS, shouldCompact } from "../src/compaction";

const HOUR = 3_600_000;
const MAX_AGE = DEFAULT_SNAPSHOT_MAX_AGE_HOURS * HOUR;
const now = Date.parse("2026-07-14T12:00:00Z");

function snapAt(updatedAt: string): Snapshot {
  return { schemaVersion: SCHEMA_VERSION, revision: 5, updatedAt, files: {} };
}

describe("shouldCompact", () => {
  it("compacts when no snapshot exists yet (cold-path clients need one)", () => {
    expect(shouldCompact(null, MAX_AGE, now)).toBe(true);
  });

  it("skips while the snapshot is younger than the max age", () => {
    expect(shouldCompact(snapAt("2026-07-14T00:00:01Z"), MAX_AGE, now)).toBe(false);
    expect(shouldCompact(snapAt("2026-07-14T11:59:00Z"), MAX_AGE, now)).toBe(false);
  });

  it("compacts once the snapshot is at or past the max age", () => {
    expect(shouldCompact(snapAt("2026-07-13T12:00:00Z"), MAX_AGE, now)).toBe(true); // exactly 24h
    expect(shouldCompact(snapAt("2026-07-10T12:00:00Z"), MAX_AGE, now)).toBe(true);
  });

  it("max age 0 always compacts (the pre-gate every-run behavior)", () => {
    expect(shouldCompact(snapAt("2026-07-14T12:00:00Z"), 0, now)).toBe(true);
  });

  it("treats an unparseable updatedAt as stale", () => {
    expect(shouldCompact(snapAt("not-a-date"), MAX_AGE, now)).toBe(true);
  });
});
