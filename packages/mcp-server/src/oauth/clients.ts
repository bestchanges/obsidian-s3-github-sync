import { signJwt, verifyJwt, type Claims } from "./jwt";

/**
 * Client identity without a client database.
 *
 * MCP clients register themselves two ways and this server accepts both:
 *
 * - **DCR (RFC 7591)** — the client POSTs its metadata to `/register` and gets a `client_id`. Rather
 *   than storing that registration, the id *is* the registration: a signed JWT carrying the redirect
 *   URIs. Nothing to persist, nothing to garbage-collect, and a forged id can't be minted without
 *   the signing key. (Claude registers a fresh client on every new connection, so a stored table
 *   would grow forever for no benefit.)
 * - **CIMD** — the `client_id` is an https URL serving the client's metadata document; we fetch and
 *   validate it. Claude Code and ChatGPT both prefer this, and it needs no registration call at all.
 */

export interface ClientInfo {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

const DCR_PREFIX = "dcr_";
/** Registered ids don't expire; the far-future exp keeps one verifier path for every token type. */
const DCR_EXP_SECONDS = 10 * 365 * 24 * 3600;
const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;

/** Warm-container cache: Claude re-fetches its own metadata on every connection attempt. */
const cimdCache = new Map<string, ClientInfo>();

export class ClientError extends Error {}

function validRedirects(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ClientError("redirect_uris is required");
  const uris = value.filter((u): u is string => typeof u === "string" && u.length > 0);
  if (uris.length === 0) throw new ClientError("redirect_uris must be strings");
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new ClientError(`redirect_uri is not a URL: ${uri}`);
    }
    // https anywhere, or plain http only on the loopback interface (RFC 8252) — a native client
    // like Claude Code has nowhere else to listen.
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new ClientError(`redirect_uri must be https (or http on loopback): ${uri}`);
    }
  }
  return uris;
}

/** RFC 7591 response body for a registration we never store. */
export function registerClient(body: unknown, secret: string, now = Date.now()): Record<string, unknown> {
  const doc = (body ?? {}) as Record<string, unknown>;
  const redirectUris = validRedirects(doc.redirect_uris);
  const clientName = typeof doc.client_name === "string" ? doc.client_name.slice(0, 120) : "MCP client";
  const issuedAt = Math.floor(now / 1000);
  const clientId =
    DCR_PREFIX +
    signJwt(
      {
        iss: "vault-mcp",
        aud: "client",
        iat: issuedAt,
        exp: issuedAt + DCR_EXP_SECONDS,
        jti: "reg",
        redirect_uris: redirectUris,
        client_name: clientName,
      },
      secret,
    );
  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // Public client: no secret is issued, so none can leak from a native client's config file.
    token_endpoint_auth_method: "none",
  };
}

function fromDcrId(clientId: string, secret: string, now: number): ClientInfo {
  const claims = verifyJwt(clientId.slice(DCR_PREFIX.length), secret, now);
  if (!claims) throw new ClientError("unknown or expired client_id");
  const info = claims as Claims & { redirect_uris?: unknown; client_name?: unknown };
  return {
    clientId,
    clientName: typeof info.client_name === "string" ? info.client_name : "MCP client",
    redirectUris: validRedirects(info.redirect_uris),
  };
}

async function fromCimd(clientId: string, fetchImpl: typeof fetch): Promise<ClientInfo> {
  const cached = cimdCache.get(clientId);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS);
  let doc: Record<string, unknown>;
  try {
    // `redirect: "error"`: the client_id is an attacker-supplied URL, so this fetch is already a
    // request to a host of their choosing. Following redirects would extend that to any host and
    // any protocol the runtime supports — including the loopback addresses only the function can
    // reach. One hop to the https URL that was actually named, and no further.
    const res = await fetchImpl(clientId, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new ClientError(`client metadata document returned HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > CIMD_MAX_BYTES) throw new ClientError("client metadata document is too large");
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ClientError) throw err;
    throw new ClientError(`could not read client metadata document: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  // The document must claim the very URL it was served from, or anyone could point a client_id at
  // someone else's document and inherit its redirect URIs.
  if (doc.client_id !== clientId) throw new ClientError("client metadata document does not match its URL");
  const info: ClientInfo = {
    clientId,
    clientName: typeof doc.client_name === "string" ? doc.client_name.slice(0, 120) : clientId,
    redirectUris: validRedirects(doc.redirect_uris),
  };
  cimdCache.set(clientId, info);
  return info;
}

/** Resolve whichever registration style the client used. Throws ClientError for anything else. */
export async function resolveClient(
  clientId: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<ClientInfo> {
  if (!clientId) throw new ClientError("client_id is required");
  if (clientId.startsWith(DCR_PREFIX)) return fromDcrId(clientId, secret, now);
  if (clientId.startsWith("https://")) return fromCimd(clientId, fetchImpl);
  throw new ClientError("unknown client_id");
}

/**
 * Redirect URIs must match exactly — except on loopback, where the port is assigned at runtime and
 * RFC 8252 §7.3 requires it to be ignored. Claude Code declares `http://localhost/callback` and
 * listens on an ephemeral port, so an exact-match-only rule would reject every one of its logins.
 */
export function redirectAllowed(requested: string, allowed: string[]): boolean {
  if (allowed.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:") return false;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(want.hostname)) return false;
  return allowed.some((candidate) => {
    try {
      const known = new URL(candidate);
      return (
        known.protocol === "http:" &&
        known.hostname === want.hostname &&
        known.pathname === want.pathname &&
        known.search === want.search
      );
    } catch {
      return false;
    }
  });
}

/** Test seam: warm-container CIMD cache is process-global by design. */
export function clearClientCache(): void {
  cimdCache.clear();
}
