import { describe, expect, it } from "vitest";
import {
  ACTIVE_POLL_MS,
  ACTIVE_WINDOW_MS,
  BACKGROUND_POLL_MIN_MS,
  pollDelayMs,
} from "../src/poll-schedule";

const BASE = 15_000; // the shipped default: pollIntervalSec = 15

describe("adaptive poll tiers (§4.9a)", () => {
  it("uses the configured baseline when foreground and idle", () => {
    expect(pollDelayMs({ baseMs: BASE, hidden: false, msSinceActivity: Infinity })).toBe(BASE);
  });

  it("tightens to the ACTIVE tier right after movement", () => {
    expect(pollDelayMs({ baseMs: BASE, hidden: false, msSinceActivity: 1_000 })).toBe(ACTIVE_POLL_MS);
  });

  it("falls back to the baseline once the activity window lapses", () => {
    const justInside = ACTIVE_WINDOW_MS - 1;
    expect(pollDelayMs({ baseMs: BASE, hidden: false, msSinceActivity: justInside })).toBe(ACTIVE_POLL_MS);
    expect(pollDelayMs({ baseMs: BASE, hidden: false, msSinceActivity: ACTIVE_WINDOW_MS })).toBe(BASE);
  });

  it("never slows down a device already polling faster than the ACTIVE tier", () => {
    // A user who set 5 s keeps 5 s while active — the fast tier is a floor, not an override.
    expect(pollDelayMs({ baseMs: 5_000, hidden: false, msSinceActivity: 0 })).toBe(5_000);
    // …and a 2 s baseline (below the settings floor, but the helper must not raise it) stays 2 s.
    expect(pollDelayMs({ baseMs: 2_000, hidden: false, msSinceActivity: 0 })).toBe(2_000);
  });

  it("backs off hard while hidden, even in the middle of a burst of activity", () => {
    expect(pollDelayMs({ baseMs: BASE, hidden: true, msSinceActivity: 0 })).toBe(BASE * 4);
    // hidden always wins over the ACTIVE tier: nothing on this device is being read.
    expect(pollDelayMs({ baseMs: BASE, hidden: true, msSinceActivity: 0 })).toBeGreaterThan(
      pollDelayMs({ baseMs: BASE, hidden: false, msSinceActivity: 0 }),
    );
  });

  it("holds the background floor when the baseline is short", () => {
    expect(pollDelayMs({ baseMs: 5_000, hidden: true, msSinceActivity: Infinity })).toBe(
      BACKGROUND_POLL_MIN_MS,
    );
  });

  it("scales the background tier with a long baseline rather than capping it", () => {
    expect(pollDelayMs({ baseMs: 60_000, hidden: true, msSinceActivity: Infinity })).toBe(240_000);
  });
});
