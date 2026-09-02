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
