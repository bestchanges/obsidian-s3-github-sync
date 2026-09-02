import { PreconditionFailedError, type StorageAdapter } from "@vault-sync/core";

/**
 * The only state OAuth needs, kept in the vault's own bucket under `auth/`.
 *
 * Two facts have to survive between requests, and neither fits in a signed token:
 *
 * - an authorization code must be usable **once** (the code itself is a signed, 60-second JWT, so
 *   the only thing to record is that it has been spent);
 * - a refresh token family's **current** token id, so that replaying a rotated-out refresh token is
 *   detected and kills the family (OAuth 2.1 for public clients).
 *
 * `auth/` sits beside `snapshot.json.gz` / `deltas/` / `files/` / `_logs/`, outside everything the
 * sync protocol reads — same trick as `mcp.json` (IMPLEMENTATION.md §4.15) — so no new bucket, no
 * new table, and no new IAM: the execution role already covers this prefix.
 */

const USED_PREFIX = "auth/used/";
const REFRESH_PREFIX = "auth/refresh/";
const ATTEMPTS_KEY = "auth/login-attempts.json";

/**
 * Online-guess throttling for the consent page. The passphrase is human-chosen and the page is
 * reachable by anyone who learns the endpoint URL, so scrypt — which only makes *offline* guessing
 * expensive — is not the whole answer.
 *
 * A single global counter, because there is a single passphrase; keying by IP would just invite
 * rotation. That means an attacker can lock the owner out of the consent page for the cooldown,
 * which is a deliberate trade: bearer-token clients and every already-issued OAuth session keep
 * working throughout, so the vault never becomes unreachable.
 */
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const LOCKOUT_MS = 15 * 60_000;

export interface AttemptRecord {
  fails: number;
  /** epoch ms of the first failure in the current window */
  since: number;
  /** epoch ms until which the consent page refuses to check a passphrase at all */
  lockedUntil?: number;
}

/** Refresh-token lifetime; a family untouched for this long is dead anyway. */
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;

export interface RefreshRecord {
  /** jti of the only refresh token currently valid for this family */
  jti: string;
  clientId: string;
  scope: string;
  updatedAt: string;
}

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

export class AuthStore {
  constructor(private storage: StorageAdapter) {}

  /**
   * Record that a code has been spent. Returns false when it already was — CAS on
   * `If-None-Match: *`, the same primitive the delta journal appends with, so two racing exchanges
   * of one code cannot both win.
   *
   * The expiry is encoded in the key so `sweep` can prune without reading anything.
   */
  async consumeCode(jti: string, expSeconds: number): Promise<boolean> {
    try {
      await this.storage.put(`${USED_PREFIX}${expSeconds}-${jti}`, enc({ at: new Date().toISOString() }), {
        ifNoneMatch: true,
      });
      return true;
    } catch (err) {
      if (err instanceof PreconditionFailedError) return false;
      throw err;
    }
  }

  async readRefresh(familyId: string): Promise<RefreshRecord | null> {
    const res = await this.storage.get(`${REFRESH_PREFIX}${familyId}.json`);
    if (!res) return null;
    try {
      return JSON.parse(new TextDecoder().decode(res.body)) as RefreshRecord;
    } catch {
      return null;
    }
  }

  async writeRefresh(familyId: string, record: RefreshRecord): Promise<void> {
    await this.storage.put(`${REFRESH_PREFIX}${familyId}.json`, enc(record));
  }

  /** Refresh-token reuse means the family is compromised: drop it, so both copies stop working. */
  async revokeRefresh(familyId: string): Promise<void> {
    await this.storage.delete(`${REFRESH_PREFIX}${familyId}.json`);
  }

  /** Milliseconds left on a lockout, or 0 when the consent page is free to check a passphrase. */
  async lockoutRemaining(now = Date.now()): Promise<number> {
    const record = await this.readAttempts();
    return record?.lockedUntil && record.lockedUntil > now ? record.lockedUntil - now : 0;
  }

  /** Count one wrong passphrase; locks the page once the window fills up. */
  async recordFailure(now = Date.now()): Promise<void> {
    const prev = await this.readAttempts();
    const fresh = !prev || now - prev.since > FAILURE_WINDOW_MS;
    const fails = fresh ? 1 : prev.fails + 1;
    const record: AttemptRecord = {
      fails,
      since: fresh ? now : prev.since,
      ...(fails >= MAX_FAILURES ? { lockedUntil: now + LOCKOUT_MS } : {}),
    };
    await this.storage.put(ATTEMPTS_KEY, enc(record));
  }

  /** A correct passphrase clears the slate. */
  async clearFailures(): Promise<void> {
    try {
      await this.storage.delete(ATTEMPTS_KEY);
    } catch {
      // a stale counter costs at most one cooldown; never fail a successful login over it
    }
  }

  private async readAttempts(): Promise<AttemptRecord | null> {
    try {
      const res = await this.storage.get(ATTEMPTS_KEY);
      if (!res) return null;
      const record = JSON.parse(new TextDecoder().decode(res.body)) as AttemptRecord;
      return typeof record.fails === "number" && typeof record.since === "number" ? record : null;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort pruning of spent-code markers whose codes have expired anyway. Runs on the token
   * endpoint, where one extra LIST is already dwarfed by the exchange itself, and keeps the prefix
   * from growing without a bucket lifecycle rule. Failures are ignored: this is housekeeping, never
   * a reason to fail a login.
   */
  async sweep(now = Date.now()): Promise<void> {
    try {
      const cutoff = Math.floor(now / 1000);
      const stale = (await this.storage.list(USED_PREFIX))
        .filter((o) => {
          const exp = Number(o.key.slice(USED_PREFIX.length).split("-")[0]);
          return Number.isFinite(exp) && exp < cutoff;
        })
        .slice(0, 100);
      for (const obj of stale) await this.storage.delete(obj.key);
    } catch {
      // ignored on purpose
    }
  }
}
