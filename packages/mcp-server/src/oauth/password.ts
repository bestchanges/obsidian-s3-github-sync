import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * The vault owner's login secret, as stored in `MCP_LOGIN_PASSWORD_HASH`.
 *
 * Format — one line, `$`-separated, mirrored by `scripts/install/05-create-mcp-server.sh` (which
 * mints it with the same parameters; change one and you must change the other):
 *
 *     scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 *
 * scrypt rather than a plain hash because this is a human-chosen passphrase: the whole point is to
 * make an offline guess expensive for anyone who ever reads the function's environment.
 */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEY_BYTES = 32;

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const key = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("hex"), key.toString("hex")].join("$");
}

/** Constant-time check. Any malformed stored value fails closed rather than throwing. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P)) return false;
  let want: Buffer;
  let got: Buffer;
  try {
    want = Buffer.from(hashHex, "hex");
    got = scryptSync(password, Buffer.from(saltHex, "hex"), want.length, { N, r: R, p: P });
  } catch {
    return false;
  }
  return want.length === got.length && timingSafeEqual(want, got);
}
