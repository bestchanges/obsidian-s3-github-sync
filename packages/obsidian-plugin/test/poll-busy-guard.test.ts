import { describe, expect, it } from "vitest";
import { shouldSkipPoll } from "../src/poll-schedule";

/** The busy guard's whole job is to break the treadmill WITHOUT ever dropping a change, so both
 * halves of the rule are asserted: skip a cycle that is provably newer than this tick, never skip
 * one that isn't. */
describe("shouldSkipPoll", () => {
  it("runs the cycle when the engine is idle", () => {
    expect(shouldSkipPoll(null, 1_000)).toBe(false);
  });

  it("skips when a cycle started after this tick was armed — its pull already covers us", () => {
    expect(shouldSkipPoll(1_500, 1_000)).toBe(true);
  });

  it("skips a cycle that started in the same millisecond the tick was armed", () => {
    expect(shouldSkipPoll(1_000, 1_000)).toBe(true);
  });

  it("does NOT skip a cycle older than this tick — its pull may predate a newer revision", () => {
    // The 2026-09-01 linux-stkv shape: a long cycle (17 s startup pull) still running when the next
    // tick fires. Skipping here would defer whatever landed mid-cycle by a whole extra interval.
    expect(shouldSkipPoll(1_000, 1_500)).toBe(false);
  });
});
