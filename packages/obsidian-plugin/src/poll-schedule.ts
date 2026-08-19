/** Adaptive poll tiers (§4.9a).
 *
 * A fixed interval is wrong in both directions: too slow when you are moving between devices, and
 * wasteful on a vault nobody is looking at. The configured `pollIntervalSec` is therefore a
 * BASELINE — an idle, foreground device — and two tiers move off it:
 *
 *  - **ACTIVE** — something moved recently (a local edit, or a cycle that transferred / advanced the
 *    cursor). Changes cluster: a device that just saw one is likely to see another, and that is
 *    exactly when a stale view is noticed. Tightens the poll for `ACTIVE_WINDOW_MS` after the last
 *    movement.
 *  - **BACKGROUND** — the window is hidden. Nothing here is being read, and mobile is about to be
 *    suspended anyway, so back off hard rather than spend requests (and radio wake-ups) on it.
 *
 * Kept pure and separate from `main.ts` so the tier choice is unit-testable without a DOM or an
 * Obsidian `Plugin` instance. Every tier is a hint: a tick that never fires costs latency, never
 * correctness — the cycle it would have started is the same one the next tick, a focus, or an edit
 * will start.
 */

/** Poll cadence while changes are actively landing. */
export const ACTIVE_POLL_MS = 5_000;
/** How long after the last observed movement the ACTIVE tier stays in force. */
export const ACTIVE_WINDOW_MS = 120_000;
/** Baseline multiplier once the window is hidden… */
export const BACKGROUND_POLL_FACTOR = 4;
/** …with this floor, so a short baseline can't keep a backgrounded device chatty. */
export const BACKGROUND_POLL_MIN_MS = 60_000;

export interface PollTierInput {
  /** The configured baseline in ms (already clamped to the 5 s settings floor). */
  baseMs: number;
  /** `document.visibilityState === "hidden"`. */
  hidden: boolean;
  /** Time since the last observed movement; `Infinity` when nothing has moved this session. */
  msSinceActivity: number;
}

/** The delay the next poll tick should use. */
export function pollDelayMs({ baseMs, hidden, msSinceActivity }: PollTierInput): number {
  if (hidden) return Math.max(baseMs * BACKGROUND_POLL_FACTOR, BACKGROUND_POLL_MIN_MS);
  // Math.min against the baseline: a user who already polls faster than ACTIVE_POLL_MS keeps their
  // cadence — the "fast" tier must never slow a device down.
  if (msSinceActivity < ACTIVE_WINDOW_MS) return Math.min(baseMs, ACTIVE_POLL_MS);
  return baseMs;
}
