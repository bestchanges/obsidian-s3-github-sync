import { describe, expect, it } from "vitest";
import {
  ACTIVE_POLL_MS,
  ACTIVE_WINDOW_MS,
  BACKGROUND_POLL_MIN_MS,
  PUSH_CONNECTED_POLL_MS,
  PUSH_DEBOUNCE_MS,
  PUSH_MAX_WAIT_MS,
  pollDelayMs,
  pushDelayMs,
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

describe("edit-push debounce (§4.4)", () => {
  it("waits the full debounce for the first edit of a burst", () => {
    expect(pushDelayMs(0)).toBe(PUSH_DEBOUNCE_MS);
  });

  it("keeps debouncing while the burst is young", () => {
    expect(pushDelayMs(5_000)).toBe(PUSH_DEBOUNCE_MS);
    expect(pushDelayMs(PUSH_MAX_WAIT_MS - PUSH_DEBOUNCE_MS)).toBe(PUSH_DEBOUNCE_MS);
  });

  it("shortens the wait as the max-wait cap approaches, so the burst can't be starved", () => {
    // The whole point: continuous typing restarts the debounce forever, and without this bound a
    // long writing session would never reach S3 — exactly when unsynced work is most valuable.
    expect(pushDelayMs(PUSH_MAX_WAIT_MS - 3_000)).toBe(3_000);
    expect(pushDelayMs(PUSH_MAX_WAIT_MS - 1)).toBe(1);
  });

  it("fires immediately once the cap is reached or passed", () => {
    expect(pushDelayMs(PUSH_MAX_WAIT_MS)).toBe(0);
    expect(pushDelayMs(PUSH_MAX_WAIT_MS + 60_000)).toBe(0); // never negative
  });

  it("never exceeds the cap, however the burst is timed", () => {
    for (let since = 0; since <= PUSH_MAX_WAIT_MS; since += 500) {
      expect(since + pushDelayMs(since)).toBeLessThanOrEqual(PUSH_MAX_WAIT_MS);
    }
  });
});

describe("push-connected tier (§4.14)", () => {
  it("relaxes the idle baseline while a notification socket is live", () => {
    expect(
      pollDelayMs({ baseMs: BASE, hidden: false, msSinceActivity: Infinity, pushConnected: true }),
    ).toBe(PUSH_CONNECTED_POLL_MS);
  });

  it("re-tightens the moment the socket drops — no state to reset", () => {
    const args = { baseMs: BASE, hidden: false, msSinceActivity: Infinity };
    expect(pollDelayMs({ ...args, pushConnected: true })).toBe(PUSH_CONNECTED_POLL_MS);
    expect(pollDelayMs({ ...args, pushConnected: false })).toBe(BASE);
  });

  it("still honours the ACTIVE tier — a local burst is about pushing, not listening", () => {
    expect(
      pollDelayMs({ baseMs: BASE, hidden: false, msSinceActivity: 1_000, pushConnected: true }),
    ).toBe(ACTIVE_POLL_MS);
  });

  it("never shortens a deliberately longer baseline", () => {
    expect(
      pollDelayMs({ baseMs: 300_000, hidden: false, msSinceActivity: Infinity, pushConnected: true }),
    ).toBe(300_000);
  });

  it("keeps backing off while hidden, connected or not", () => {
    expect(
      pollDelayMs({ baseMs: BASE, hidden: true, msSinceActivity: 0, pushConnected: true }),
    ).toBe(BASE * 4);
  });
});
