import { describe, expect, it } from "vitest";
import { remoteIsFresher } from "../src/util";

/** Freshest-wins comparator: must order mtimes chronologically, not by raw string, because the two
 * sync legs emit them in different ISO shapes/timezones (git %aI offset form vs the plugin's
 * toISOString Z form). A stale copy winning here reverted a plugin bump 0.2.1 → 0.2.0 in the field. */
describe("remoteIsFresher", () => {
  it("returns true when remote is strictly newer", () => {
    expect(remoteIsFresher("2026-07-20T12:00:00.000Z", "2026-07-20T11:00:00.000Z")).toBe(true);
  });

  it("returns false when local is newer", () => {
    expect(remoteIsFresher("2026-07-20T11:00:00.000Z", "2026-07-20T12:00:00.000Z")).toBe(false);
  });

  it("keeps local on a tie (equal instants)", () => {
    expect(remoteIsFresher("2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z")).toBe(false);
  });

  // Defect #2 (format): the SAME instant in the two legs' shapes must compare equal → keep local.
  it("treats identical instants in git-form and plugin-form as a tie", () => {
    const gitForm = "2026-07-20T11:30:35+00:00"; // git %aI (offset, no millis)
    const pluginForm = "2026-07-20T11:30:35.000Z"; // toISOString (Z, millis)
    expect(remoteIsFresher(gitForm, pluginForm)).toBe(false);
    expect(remoteIsFresher(pluginForm, gitForm)).toBe(false);
  });

  // Defect #3 (timezone): a later instant in Z form must beat an earlier instant in +07:00 form,
  // even though the +07:00 string sorts lexicographically higher.
  it("orders across timezone offsets by real instant, not string", () => {
    const earlierInPlusSeven = "2026-07-20T18:00:00+07:00"; // = 11:00Z
    const laterInZ = "2026-07-20T12:00:00.000Z"; // = 12:00Z, genuinely later
    expect(earlierInPlusSeven > laterInZ).toBe(true); // raw string order is WRONG…
    expect(remoteIsFresher(laterInZ, earlierInPlusSeven)).toBe(true); // …parsed order is right
    expect(remoteIsFresher(earlierInPlusSeven, laterInZ)).toBe(false);
  });

  // Regression for the incident: git holds the new 0.2.1 (author date), S3 holds a device's stale
  // 0.2.0 written 2 min later. Freshest-wins is still write-time based, so 0.2.0 wins here BY DESIGN
  // — but the point is the comparison itself is now sound, so it's decided by real time, not by a
  // string-format accident. (The remaining write-time-vs-version semantics is tracked separately.)
  it("decides the manifest case by real time order, not string shape", () => {
    const gitAuthor021 = "2026-07-20T11:30:35+00:00";
    const deviceFile020 = "2026-07-20T11:32:00.000Z"; // written 90s later
    // remote(git 0.2.1) is older than local(device 0.2.0) → not fresher → local wins, by real time
    expect(remoteIsFresher(gitAuthor021, deviceFile020)).toBe(false);
    // and the reverse instant relationship holds
    expect(remoteIsFresher(deviceFile020, gitAuthor021)).toBe(true);
  });

  // Fallback: an unparseable side (e.g. empty local mtime when a stat is missing) stays deterministic.
  it("falls back to string compare when a side is unparseable", () => {
    expect(remoteIsFresher("2026-07-20T12:00:00.000Z", "")).toBe(true); // non-empty > "" → remote wins
    expect(remoteIsFresher("", "")).toBe(false); // equal strings → tie → keep local
  });
});
