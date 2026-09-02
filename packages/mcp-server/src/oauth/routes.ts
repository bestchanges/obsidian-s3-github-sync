import { createHash } from "node:crypto";
import { ClientError, redirectAllowed, registerClient, resolveClient, type ClientInfo } from "./clients";
import { pageHeaders, renderConsent, renderError } from "./consent";
import { randomId, signJwt, verifyJwt, type Claims } from "./jwt";
import {
  AUTHORIZE_PATH,
  AUTH_SERVER_PATH,
  DEFAULT_SCOPE,
  MCP_PATH,
  OIDC_PATH,
  PROTECTED_RESOURCE_PATH,
  REGISTER_PATH,
  SCOPES,
  TOKEN_PATH,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "./metadata";
import { verifyPassword } from "./password";
import { AuthStore, REFRESH_TTL_SECONDS } from "./store";

/**
 * The OAuth 2.1 authorization server, served by the same Lambda as the MCP endpoint.
 *
 * Why in-process rather than Cognito: the MCP clients that need OAuth (claude.ai, ChatGPT, the
 * Gemini app) all require DCR or CIMD, and Cognito supports neither — fronting it would mean
 * writing these same endpoints as a façade anyway, plus a user pool to operate. This deployment has
 * exactly one user, so "authorization server" collapses to: prove you hold the vault passphrase,
 * then hand out short-lived signed tokens.
 *
 * The static bearer token (`MCP_BEARER_TOKEN`) keeps working alongside this for header-capable
 * clients; see `auth.ts`.
 */

export interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface OAuthRequest {
  method: string;
  path: string;
  /** public origin, e.g. `https://abc.lambda-url.eu-central-1.on.aws` */
  issuer: string;
  query: URLSearchParams;
  body: string;
}

export interface OAuthDeps {
  signingKey: string;
  /** scrypt hash of the owner's passphrase; when absent, the OAuth endpoints are switched off */
  passwordHash?: string;
  store: AuthStore;
  vaultName: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const CODE_TTL_SECONDS = 60;
export const ACCESS_TTL_SECONDS = 3600;

const AUD_CODE = "vault-mcp/code";
const AUD_REFRESH = "vault-mcp/refresh";

function json(statusCode: number, value: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    body: JSON.stringify(value),
  };
}

function html(statusCode: number, body: string): HttpResult {
  return { statusCode, headers: pageHeaders(), body };
}

function redirect(location: string): HttpResult {
  return { statusCode: 302, headers: { location, "cache-control": "no-store" }, body: "" };
}

function oauthError(status: number, error: string, description: string): HttpResult {
  return json(status, { error, error_description: description });
}

/** Send an error back through the client's redirect URI, per RFC 6749 §4.1.2.1. */
function redirectError(redirectUri: string, error: string, description: string, state?: string): HttpResult {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return redirect(url.toString());
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Intersect what the client asked for with what this server issues; empty request ⇒ everything. */
function negotiateScope(requested: string | null): string {
  if (!requested) return DEFAULT_SCOPE;
  const granted = requested.split(/\s+/).filter((s) => SCOPES.includes(s));
  return granted.length > 0 ? granted.join(" ") : DEFAULT_SCOPE;
}

interface AuthorizeParams {
  client: ClientInfo;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
}

/**
 * Shared validation for GET and POST /authorize. Order matters: until the client and its redirect
 * URI are known-good there is nowhere safe to send an error, so those two failures render a page
 * instead of redirecting — anything else would let an attacker bounce errors (and the user) to a
 * URI of their choosing.
 */
async function validateAuthorize(
  params: URLSearchParams,
  deps: OAuthDeps,
  now: number,
): Promise<{ ok: AuthorizeParams } | { fail: HttpResult }> {
  const clientId = params.get("client_id") ?? "";
  let client: ClientInfo;
  try {
    client = await resolveClient(clientId, deps.signingKey, deps.fetchImpl ?? fetch, now);
  } catch (err) {
    const detail = err instanceof ClientError ? err.message : "client could not be identified";
    return { fail: html(400, renderError("Unknown app", detail)) };
  }

  const redirectUri = params.get("redirect_uri") ?? client.redirectUris[0];
  if (!redirectAllowed(redirectUri, client.redirectUris)) {
    return {
      fail: html(400, renderError("Redirect not allowed", `${redirectUri} is not registered for this app.`)),
    };
  }

  const state = params.get("state") ?? "";
  if (params.get("response_type") !== "code") {
    return { fail: redirectError(redirectUri, "unsupported_response_type", "only response_type=code", state) };
  }
  const challenge = params.get("code_challenge") ?? "";
  // PKCE is mandatory in OAuth 2.1, and S256 only: `plain` offers no protection for a public client.
  if (!challenge || params.get("code_challenge_method") !== "S256") {
    return { fail: redirectError(redirectUri, "invalid_request", "code_challenge with S256 is required", state) };
  }

  return { ok: { client, redirectUri, scope: negotiateScope(params.get("scope")), state, challenge } };
}

function consentView(deps: OAuthDeps, params: URLSearchParams, v: AuthorizeParams, error?: string) {
  const replay: Record<string, string> = {};
  for (const [k, value] of params) if (k !== "password" && k !== "action") replay[k] = value;
  return renderConsent({
    vaultName: deps.vaultName,
    clientName: v.client.clientName,
    redirectUri: v.redirectUri,
    scope: v.scope,
    params: replay,
    error,
  });
}

async function handleToken(req: OAuthRequest, deps: OAuthDeps, now: number): Promise<HttpResult> {
  const form = new URLSearchParams(req.body);
  const grant = form.get("grant_type");
  const nowSec = Math.floor(now / 1000);

  const issue = (clientId: string, scope: string, family: string, refreshJti: string): HttpResult =>
    json(200, {
      access_token: signJwt(
        {
          iss: req.issuer,
          aud: req.issuer + MCP_PATH,
          sub: "vault-owner",
          iat: nowSec,
          exp: nowSec + ACCESS_TTL_SECONDS,
          jti: randomId(),
          scope,
          client_id: clientId,
        },
        deps.signingKey,
      ),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      scope,
      refresh_token: signJwt(
        {
          iss: req.issuer,
          aud: AUD_REFRESH,
          iat: nowSec,
          exp: nowSec + REFRESH_TTL_SECONDS,
          jti: refreshJti,
          family,
          client_id: clientId,
          scope,
        },
        deps.signingKey,
      ),
    });

  if (grant === "authorization_code") {
    const claims = verifyJwt(form.get("code") ?? "", deps.signingKey, now) as
      | (Claims & { client_id?: string; redirect_uri?: string; scope?: string; code_challenge?: string })
      | null;
    if (!claims || claims.aud !== AUD_CODE) {
      return oauthError(400, "invalid_grant", "authorization code is invalid or expired");
    }
    if (claims.client_id !== form.get("client_id")) {
      return oauthError(400, "invalid_grant", "code was issued to a different client");
    }
    if (claims.redirect_uri !== form.get("redirect_uri")) {
      return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || s256(verifier) !== claims.code_challenge) {
      return oauthError(400, "invalid_grant", "PKCE verification failed");
    }
    // Last, and only once: a code that reaches here is spent even if the response is lost.
    if (!(await deps.store.consumeCode(claims.jti, claims.exp))) {
      return oauthError(400, "invalid_grant", "authorization code has already been used");
    }

    const family = randomId();
    const refreshJti = randomId();
    const scope = typeof claims.scope === "string" ? claims.scope : DEFAULT_SCOPE;
    await deps.store.writeRefresh(family, {
      jti: refreshJti,
      clientId: String(claims.client_id),
      scope,
      updatedAt: new Date(now).toISOString(),
    });
    void deps.store.sweep(now);
    return issue(String(claims.client_id), scope, family, refreshJti);
  }

  if (grant === "refresh_token") {
    const claims = verifyJwt(form.get("refresh_token") ?? "", deps.signingKey, now) as
      | (Claims & { family?: string; client_id?: string; scope?: string })
      | null;
    if (!claims || claims.aud !== AUD_REFRESH || typeof claims.family !== "string") {
      return oauthError(400, "invalid_grant", "refresh token is invalid or expired");
    }
    const record = await deps.store.readRefresh(claims.family);
    if (!record) return oauthError(400, "invalid_grant", "refresh token has been revoked");
    if (record.jti !== claims.jti) {
      // Replay of a rotated-out token: assume the family leaked and kill all of it.
      await deps.store.revokeRefresh(claims.family);
      return oauthError(400, "invalid_grant", "refresh token was already used; the session has been revoked");
    }

    // Rotation: the token just presented stops working the moment the new one is recorded.
    const refreshJti = randomId();
    await deps.store.writeRefresh(claims.family, { ...record, jti: refreshJti, updatedAt: new Date(now).toISOString() });
    return issue(record.clientId, record.scope, claims.family, refreshJti);
  }

  return oauthError(400, "unsupported_grant_type", "supported grants: authorization_code, refresh_token");
}

/** Route one request, or return null when the path belongs to someone else (i.e. `/mcp`). */
export async function handleOAuth(req: OAuthRequest, deps: OAuthDeps): Promise<HttpResult | null> {
  const now = deps.now?.() ?? Date.now();
  const { path, method } = req;

  // Discovery is public and safe to answer even with OAuth disabled — but if it is disabled the
  // documents would advertise endpoints that reject everything, so they are withheld too.
  const oauthPath =
    path === AUTHORIZE_PATH ||
    path === TOKEN_PATH ||
    path === REGISTER_PATH ||
    path === AUTH_SERVER_PATH ||
    path === OIDC_PATH ||
    path === PROTECTED_RESOURCE_PATH ||
    path.startsWith(PROTECTED_RESOURCE_PATH + "/") ||
    path.startsWith(AUTH_SERVER_PATH + "/");
  if (!oauthPath) return null;
  if (!deps.passwordHash) {
    return oauthError(404, "not_found", "this server is configured for bearer-token auth only");
  }

  if (path === PROTECTED_RESOURCE_PATH || path.startsWith(PROTECTED_RESOURCE_PATH + "/")) {
    return json(200, protectedResourceMetadata(req.issuer), { "cache-control": "public, max-age=3600" });
  }
  if (path === AUTH_SERVER_PATH || path === OIDC_PATH || path.startsWith(AUTH_SERVER_PATH + "/")) {
    return json(200, authorizationServerMetadata(req.issuer), { "cache-control": "public, max-age=3600" });
  }

  if (path === REGISTER_PATH) {
    if (method !== "POST") return { statusCode: 405, headers: { allow: "POST" }, body: "" };
    try {
      return json(201, registerClient(JSON.parse(req.body || "{}"), deps.signingKey, now));
    } catch (err) {
      const detail = err instanceof ClientError ? err.message : "registration body must be JSON";
      return oauthError(400, "invalid_client_metadata", detail);
    }
  }

  if (path === AUTHORIZE_PATH) {
    const params = method === "POST" ? new URLSearchParams(req.body) : req.query;
    const result = await validateAuthorize(params, deps, now);
    if ("fail" in result) return result.fail;
    const v = result.ok;

    if (method === "GET") return html(200, consentView(deps, params, v));
    if (method !== "POST") return { statusCode: 405, headers: { allow: "GET, POST" }, body: "" };

    if (params.get("action") === "deny") {
      return redirectError(v.redirectUri, "access_denied", "the vault owner declined", v.state);
    }
    // Throttle before checking: an unlimited consent page is an online password oracle.
    const cooldown = await deps.store.lockoutRemaining(now);
    if (cooldown > 0) {
      const minutes = Math.ceil(cooldown / 60_000);
      return html(
        429,
        consentView(deps, params, v, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`),
      );
    }
    if (!verifyPassword(params.get("password") ?? "", deps.passwordHash)) {
      await deps.store.recordFailure(now);
      return html(401, consentView(deps, params, v, "That passphrase didn't match. Try again."));
    }
    await deps.store.clearFailures();

    const nowSec = Math.floor(now / 1000);
    const code = signJwt(
      {
        iss: req.issuer,
        aud: AUD_CODE,
        iat: nowSec,
        exp: nowSec + CODE_TTL_SECONDS,
        jti: randomId(),
        client_id: v.client.clientId,
        redirect_uri: v.redirectUri,
        scope: v.scope,
        code_challenge: v.challenge,
      },
      deps.signingKey,
    );
    const url = new URL(v.redirectUri);
    url.searchParams.set("code", code);
    if (v.state) url.searchParams.set("state", v.state);
    return redirect(url.toString());
  }

  if (path === TOKEN_PATH) {
    if (method !== "POST") return { statusCode: 405, headers: { allow: "POST" }, body: "" };
    return handleToken(req, deps, now);
  }

  return null;
}
