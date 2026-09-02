import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Minimal HS256 JWT, hand-rolled on node:crypto.
 *
 * Deliberately not a library: this server issues and verifies its own tokens only (single issuer,
 * single audience, one symmetric key from the Lambda env), so the whole surface is sign + verify of
 * a compact JWS. A dependency would add bundle weight and an audit surface for algorithm agility
 * this deployment must never have — `alg` is checked against the one value we issue, so `none` and
 * key-confusion attacks have nowhere to land.
 */

export type Claims = Record<string, unknown> & {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
};

const HEADER = { alg: "HS256", typ: "JWT" } as const;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function signJwt(claims: Claims, secret: string): string {
  const body = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify(claims))}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify signature and expiry. Returns null on anything unexpected — a caller can only distinguish
 * "valid" from "not valid", which is all an auth gate should act on.
 */
export function verifyJwt(token: string, secret: string, now = Date.now()): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, signature] = parts;

  const expected = Buffer.from(sign(`${rawHeader}.${rawPayload}`, secret), "base64url");
  const got = Buffer.from(signature, "base64url");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  try {
    const header = JSON.parse(Buffer.from(rawHeader, "base64url").toString()) as { alg?: string };
    if (header.alg !== HEADER.alg) return null; // never honour `none`, never a different family
    const claims = JSON.parse(Buffer.from(rawPayload, "base64url").toString()) as Claims;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
