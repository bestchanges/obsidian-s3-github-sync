/** Cycle cadence: adaptive poll tiers (§4.9a) and the edit-push debounce (§4.4).
 *
 * ── Poll tiers ──
 *
 * A fixed interval is wrong in both directions: too slow when you are moving between devices, and
 * wasteful on a vault nobody is looking at. The configured `pollIntervalSec` is therefore a
 * BASELINE — an idle, foreground device — and two tiers move off it:
 *
 *  - **ACTIVE** — a **remote** change arrived recently (a cycle that pulled/merged, or a change
 *    notification). Changes cluster: a device that just saw one is likely to see another, and that
 *    is exactly when a stale view is noticed. Tightens the poll for `ACTIVE_WINDOW_MS`.
 *
 *    Deliberately **not** armed by local edits. Every cycle pulls *and* pushes, so arming the fast
 *    tier from our own writes made each poll re-push the file being typed — one delta and one S3
 *    version per ACTIVE interval for the whole session (observed 2026-08-23: 14 pushes of one note
 *    in 70 s of typing). Flushing local edits is the debounce's job, not the poll's.
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
/** Idle baseline while a change-notification socket is live (§4.14): push carries the latency, so
 * the poll drops to a safety net. Deliberately keyed on the socket being connected *right now*,
 * not on the setting being enabled — the moment the socket drops, the next tick re-tightens on its
 * own with nothing to remember and nothing to reset. */
export const PUSH_CONNECTED_POLL_MS = 60_000;

export interface PollTierInput {
  /** The configured baseline in ms (already clamped to the 5 s settings floor). */
  baseMs: number;
  /** `document.visibilityState === "hidden"`. */
  hidden: boolean;
  /** Time since the last **remote** change landed; `Infinity` when none has this session. Local
   * edits must not feed this — see the ACTIVE tier note above. */
  msSinceActivity: number;
  /** A change-notification socket is connected *at this moment* (§4.14). */
  pushConnected?: boolean;
}

/** The delay the next poll tick should use. */
export function pollDelayMs({
  baseMs,
  hidden,
  msSinceActivity,
  pushConnected = false,
}: PollTierInput): number {
  if (hidden) return Math.max(baseMs * BACKGROUND_POLL_FACTOR, BACKGROUND_POLL_MIN_MS);
  // Math.min against the baseline: a user who already polls faster than ACTIVE_POLL_MS keeps their
  // cadence — the "fast" tier must never slow a device down.
  if (msSinceActivity < ACTIVE_WINDOW_MS) return Math.min(baseMs, ACTIVE_POLL_MS);
  // Push is live: the poll is now a safety net for dropped notifications, not the delivery path.
  // The ACTIVE tier above still wins, because a burst of local edits is about pushing, not
  // listening — and `max` means a user who deliberately set a *longer* baseline keeps it.
  if (pushConnected) return Math.max(baseMs, PUSH_CONNECTED_POLL_MS);
  return baseMs;
}

// ── Busy guard ──────────────────────────────────────────────────────────────
/** Should this poll tick skip its cycle because one is already running?
 *
 * Only when that cycle began AFTER the tick was armed. Then its pull is strictly newer than
 * anything the tick could have observed, so a second cycle now would be duplicate work — which on
 * a device where a cycle outlasts the interval is not merely wasteful but self-sustaining: each
 * tick queues behind the running cycle and starts the instant it ends, so the device never idles
 * (observed 2026-09-01 on linux-stkv: 18 back-to-back no-op cycles in 90 s).
 *
 * A cycle that started BEFORE the tick was armed is NOT grounds to skip. It may have pulled before
 * a revision that has since landed, so skipping would defer that change by a whole extra interval
 * for no gain; the tick requests a cycle and coalesces into the engine's queue as it always has.
 *
 * Skipping never drops work in either direction: local edits stay in the dirty set until push()
 * drains it, and a remote change the skipped tick would have fetched is picked up by the next tick
 * one interval later — the same bound polling has always given.
 */
export function shouldSkipPoll(busySince: number | null, armedAt: number): boolean {
  return busySince !== null && busySince >= armedAt;
}

// ── Edit-push debounce (§4.4) ───────────────────────────────────────────────
/** How long after the last save an edit waits before it is pushed. Every save restarts the wait,
 * so a burst of edits becomes one delta instead of one per save.
 *
 * Raised from 5 s once instant sync landed (§4.14): the debounce is now the *dominant* term in
 * cross-device latency (delivery after the push is ~1 s), so it is the knob that trades deltas
 * against how soon the other device sees the change. 10 s keeps end-to-end well inside what the
 * old 15 s poll delivered, while halving the deltas for edits spaced a few seconds apart. */
export const PUSH_DEBOUNCE_MS = 10_000;
/** …but a debounce alone can be **starved**: continuous typing saves faster than the window, so the
 * timer resets forever and nothing reaches S3 during a long writing session — precisely when the
 * unsynced work is most valuable. This caps the wait from the FIRST unpushed edit, so a session
 * flushes at least this often no matter how continuously it is typed. */
export const PUSH_MAX_WAIT_MS = 45_000;

/** Delay before the pending edit-push should fire, given how long ago the first unpushed edit
 * happened (0 when this is the first). Pure so the starvation bound is testable. */
export function pushDelayMs(sinceFirstEditMs: number): number {
  const remaining = PUSH_MAX_WAIT_MS - sinceFirstEditMs;
  // Never negative: past the cap the push is already overdue, so fire on the next tick.
  return Math.max(0, Math.min(PUSH_DEBOUNCE_MS, remaining));
}
