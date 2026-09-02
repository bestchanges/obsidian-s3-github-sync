import { createHash, timingSafeEqual } from "node:crypto";
import { verifyJwt } from "./oauth/jwt";
import { DEFAULT_SCOPE, SCOPE_WRITE } from "./oauth/metadata";

/**
 * Two ways in, one gate.
 *
 * - **Static bearer token** (`MCP_BEARER_TOKEN`) — for clients that can set a header: Claude Code,
 *   Claude Desktop, Gemini CLI. Full access, no expiry, rotated by the installer.
 * - **OAuth access token** — a JWT this server issued (`oauth/routes.ts`), for the hosted chat
 *   surfaces that can only paste a URL. Short-lived and scoped.
 *
 * A deployment can run either or both; whichever is configured is accepted.
 */

export interface AuthResult {
  ok: boolean;
  /** granted scopes, space-separated — a static token carries them all */
  scope: string;
}

const DENIED: AuthResult = { ok: false, scope: "" };

function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Kept as its own export: the token check is worth testing on its own terms. */
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return constantTimeEquals(header.slice("Bearer ".length), expected);
}

export interface AuthConfig {
  /** static shared secret; empty/absent disables that path */
  staticToken?: string;
  /** HS256 key the OAuth endpoints sign with; empty/absent disables OAuth */
  signingKey?: string;
  /** expected `aud` of an access token — the MCP URL as the client called it */
  audience: string;
}

/**
 * Authenticate one request. An access token is accepted only when it was signed by this deployment
 * **and** was minted for this exact resource: `aud` is checked against the MCP URL, so a token
 * issued for another vault's server cannot be replayed here.
 */
export function authenticate(header: string | undefined, config: AuthConfig, now = Date.now()): AuthResult {
  if (!header?.startsWith("Bearer ")) return DENIED;
  const presented = header.slice("Bearer ".length);

  if (config.staticToken && constantTimeEquals(presented, config.staticToken)) {
    return { ok: true, scope: DEFAULT_SCOPE };
  }
  if (!config.signingKey) return DENIED;

  const claims = verifyJwt(presented, config.signingKey, now);
  if (!claims || claims.aud !== config.audience) return DENIED;
  return { ok: true, scope: typeof claims.scope === "string" ? claims.scope : DEFAULT_SCOPE };
}

export function canWrite(scope: string): boolean {
  return scope.split(/\s+/).includes(SCOPE_WRITE);
}
