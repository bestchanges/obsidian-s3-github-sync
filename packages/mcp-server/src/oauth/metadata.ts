/**
 * Discovery documents. A client that knows only the MCP URL follows this chain: `401` →
 * `WWW-Authenticate: resource_metadata=…` → protected-resource metadata (RFC 9728) →
 * authorization-server metadata (RFC 8414) → register/authorize/token.
 */

export const SCOPE_READ = "vault.read";
export const SCOPE_WRITE = "vault.write";
export const SCOPES = [SCOPE_READ, SCOPE_WRITE];
export const DEFAULT_SCOPE = SCOPES.join(" ");

export const MCP_PATH = "/mcp";
export const AUTHORIZE_PATH = "/authorize";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTH_SERVER_PATH = "/.well-known/oauth-authorization-server";
export const OIDC_PATH = "/.well-known/openid-configuration";

/** RFC 9728 §3. `resource` must equal the MCP URL exactly as the user typed it into the client. */
export function protectedResourceMetadata(issuer: string): Record<string, unknown> {
  return {
    resource: issuer + MCP_PATH,
    authorization_servers: [issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
  };
}

/**
 * RFC 8414 §2. Two fields decide which registration path a client takes:
 * `client_id_metadata_document_supported` opts into CIMD, and Claude only selects it when `"none"`
 * also appears in `token_endpoint_auth_methods_supported` (its CIMD client authenticates as a
 * public client). `registration_endpoint` keeps DCR available for everything else.
 */
export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: issuer + AUTHORIZE_PATH,
    token_endpoint: issuer + TOKEN_PATH,
    registration_endpoint: issuer + REGISTER_PATH,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  };
}

/**
 * The `WWW-Authenticate` challenge on an unauthenticated `/mcp` call. Clients discover the whole
 * chain from this one header, and it must ride on a **401** — a challenge on a 200 is ignored.
 */
export function challengeHeader(issuer: string): string {
  return `Bearer resource_metadata="${issuer}${PROTECTED_RESOURCE_PATH}", scope="${DEFAULT_SCOPE}"`;
}

/**
 * The public origin of this deployment, from the request's Host header — a Lambda Function URL has
 * no configured base URL, and the issuer must match what the client actually called.
 */
export function issuerFromHost(host: string | undefined): string | null {
  if (!host || !/^[A-Za-z0-9.\-:[\]]+$/.test(host)) return null;
  return `https://${host}`;
}
