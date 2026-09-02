import { createHash, randomBytes } from "node:crypto";
import { InMemoryStorage } from "@vault-sync/core";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyJwt } from "../src/oauth/jwt";
import { hashPassword } from "../src/oauth/password";
import { clearClientCache } from "../src/oauth/clients";
import { handleOAuth, type HttpResult, type OAuthDeps } from "../src/oauth/routes";
import { AuthStore } from "../src/oauth/store";

/**
 * The whole authorization-code flow as a client actually walks it: discover → register → consent →
 * code → token → refresh. Every step runs against the real route handler; only S3 (in-memory) and
 * the clock are substituted.
 */

const SECRET = "flow-test-signing-key";
const PASSPHRASE = "open sesame";
const ISSUER = "https://abc123.lambda-url.ap-southeast-1.on.aws";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

// Hashed once for the whole file: scrypt is deliberately expensive (~100 ms), and paying that per
// test burns seconds of CPU that other suites' real-time deadline tests are measured against.
const PASSWORD_HASH = hashPassword(PASSPHRASE);

let storage: InMemoryStorage;
let deps: OAuthDeps;
let clock: number;

beforeEach(() => {
  clearClientCache();
  storage = new InMemoryStorage();
  clock = NOW;
  deps = {
    signingKey: SECRET,
    passwordHash: PASSWORD_HASH,
    store: new AuthStore(storage),
    vaultName: "gsd2",
    now: () => clock,
  };
});

const call = (
  method: string,
  path: string,
  { query = "", body = "" }: { query?: string; body?: string } = {},
): Promise<HttpResult | null> =>
  handleOAuth({ method, path, issuer: ISSUER, query: new URLSearchParams(query), body }, deps);

const parse = (res: HttpResult | null): Record<string, unknown> => JSON.parse(res!.body!);

/** PKCE pair, as a client generates it. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(redirectUris = [REDIRECT]): Promise<string> {
  const res = await call("POST", "/register", {
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: "Claude" }),
  });
  expect(res!.statusCode).toBe(201);
  return String(parse(res).client_id);
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    ...extra,
  }).toString();
}

/** Approve the consent form and pull the authorization code out of the redirect. */
async function approve(clientId: string, challenge: string, extra: Record<string, string> = {}): Promise<string> {
  const res = await call("POST", "/authorize", {
    body: authorizeQuery(clientId, challenge, extra) + "&action=approve&password=" + encodeURIComponent(PASSPHRASE),
  });
  expect(res!.statusCode).toBe(302);
  return new URL(res!.headers!.location).searchParams.get("code")!;
}

const tokenBody = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

describe("discovery", () => {
  it("publishes protected-resource metadata pointing at this server", async () => {
    const res = await call("GET", "/.well-known/oauth-protected-resource");
    expect(parse(res)).toMatchObject({
      resource: `${ISSUER}/mcp`,
      authorization_servers: [ISSUER],
      scopes_supported: ["vault.read", "vault.write"],
    });
    // Claude also probes the path-suffixed form when the 401 header is missed.
    expect(parse(await call("GET", "/.well-known/oauth-protected-resource/mcp")).resource).toBe(`${ISSUER}/mcp`);
  });

  it("advertises S256 PKCE, CIMD, and public-client token auth", async () => {
    const meta = parse(await call("GET", "/.well-known/oauth-authorization-server"));
    expect(meta).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      code_challenge_methods_supported: ["S256"],
      // Claude picks CIMD only when BOTH of these are present.
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
    });
    // The OIDC path is the same document — some clients only look there.
    expect(parse(await call("GET", "/.well-known/openid-configuration")).issuer).toBe(ISSUER);
  });

  it("leaves non-OAuth paths to the caller", async () => {
    expect(await call("POST", "/mcp")).toBeNull();
    expect(await call("GET", "/anything")).toBeNull();
  });

  it("switches off entirely when no passphrase is configured", async () => {
    deps = { ...deps, passwordHash: undefined };
    const res = await call("GET", "/.well-known/oauth-authorization-server");
    expect(res!.statusCode).toBe(404);
  });
});

describe("authorization code flow", () => {
  it("walks register → consent → code → token", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();

    const consent = await call("GET", "/authorize", { query: authorizeQuery(clientId, challenge) });
    expect(consent!.statusCode).toBe(200);
    expect(consent!.headers!["content-type"]).toContain("text/html");
    expect(consent!.body).toContain("gsd2");
    expect(consent!.body).toContain("claude.ai"); // the destination is shown to the owner
    expect(consent!.body).not.toContain(PASSPHRASE);

    const redirected = await call("POST", "/authorize", {
      body: authorizeQuery(clientId, challenge) + "&action=approve&password=" + encodeURIComponent(PASSPHRASE),
    });
    const location = new URL(redirected!.headers!.location);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("xyz");

    const token = await call("POST", "/token", {
      body: tokenBody({
        grant_type: "authorization_code",
        code: location.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    const body = parse(token) as Record<string, string>;
    expect(body).toMatchObject({ token_type: "Bearer", scope: "vault.read vault.write" });

    const claims = verifyJwt(body.access_token, SECRET, clock);
    expect(claims).toMatchObject({ iss: ISSUER, aud: `${ISSUER}/mcp`, sub: "vault-owner" });
    expect(body.refresh_token).toBeTruthy();
  });

  it("honours a narrowed scope request", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge, { scope: "vault.read" });

    const body = parse(
      await call("POST", "/token", {
        body: tokenBody({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      }),
    ) as Record<string, string>;
    expect(body.scope).toBe("vault.read");
    expect(verifyJwt(body.access_token, SECRET, clock)!.scope).toBe("vault.read");
  });

  it("refuses the wrong passphrase without issuing anything", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await call("POST", "/authorize", {
      body: authorizeQuery(clientId, challenge) + "&action=approve&password=wrong",
    });
    expect(res!.statusCode).toBe(401);
    expect(res!.body).toContain("didn&#39;t match");
    expect(res!.headers!["content-type"]).toContain("text/html");
  });

  it("sends the user back with access_denied when they cancel", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await call("POST", "/authorize", {
      body: authorizeQuery(clientId, challenge) + "&action=deny&password=",
    });
    expect(new URL(res!.headers!.location).searchParams.get("error")).toBe("access_denied");
  });
});

describe("authorization request validation", () => {
  it("renders a page — never a redirect — for an unknown client or an unregistered redirect", async () => {
    const { challenge } = pkce();
    const unknown = await call("GET", "/authorize", { query: authorizeQuery("dcr_forged", challenge) });
    expect(unknown!.statusCode).toBe(400);
    expect(unknown!.headers!["content-type"]).toContain("text/html");
    expect(unknown!.headers!.location).toBeUndefined();

    const clientId = await register(["https://claude.ai/api/mcp/auth_callback"]);
    const elsewhere = await call("GET", "/authorize", {
      query: authorizeQuery(clientId, challenge).replace(encodeURIComponent(REDIRECT), encodeURIComponent("https://evil.example/cb")),
    });
    expect(elsewhere!.statusCode).toBe(400);
    expect(elsewhere!.headers!.location).toBeUndefined();
  });

  it("requires S256 PKCE and response_type=code, reporting both through the redirect", async () => {
    const clientId = await register();
    const { challenge } = pkce();

    const noPkce = await call("GET", "/authorize", {
      query: new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        state: "xyz",
      }).toString(),
    });
    expect(new URL(noPkce!.headers!.location).searchParams.get("error")).toBe("invalid_request");

    const plain = await call("GET", "/authorize", {
      query: authorizeQuery(clientId, challenge, { code_challenge_method: "plain" }),
    });
    expect(new URL(plain!.headers!.location).searchParams.get("error")).toBe("invalid_request");

    const implicit = await call("GET", "/authorize", {
      query: authorizeQuery(clientId, challenge, { response_type: "token" }),
    });
    expect(new URL(implicit!.headers!.location).searchParams.get("error")).toBe("unsupported_response_type");
  });
});

describe("token endpoint", () => {
  it("rejects a mismatched PKCE verifier", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const code = await approve(clientId, challenge);

    const res = await call("POST", "/token", {
      body: tokenBody({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: pkce().verifier, // a different verifier entirely
      }),
    });
    expect(res!.statusCode).toBe(400);
    expect(parse(res)).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a code replayed a second time", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    const body = tokenBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });

    expect((await call("POST", "/token", { body }))!.statusCode).toBe(200);
    const replay = await call("POST", "/token", { body });
    expect(replay!.statusCode).toBe(400);
    expect(parse(replay).error_description).toContain("already been used");
  });

  it("rejects an expired code and a code bound to a different client or redirect", async () => {
    const clientId = await register();
    const other = await register(["https://other.example/cb"]);
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);

    expect(
      parse(
        await call("POST", "/token", {
          body: tokenBody({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT,
            client_id: other,
            code_verifier: verifier,
          }),
        }),
      ).error_description,
    ).toContain("different client");

    expect(
      parse(
        await call("POST", "/token", {
          body: tokenBody({
            grant_type: "authorization_code",
            code,
            redirect_uri: "https://claude.ai/other",
            client_id: clientId,
            code_verifier: verifier,
          }),
        }),
      ).error_description,
    ).toContain("redirect_uri does not match");

    clock = NOW + 61_000; // codes live 60 s
    expect(
      parse(
        await call("POST", "/token", {
          body: tokenBody({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT,
            client_id: clientId,
            code_verifier: verifier,
          }),
        }),
      ).error_description,
    ).toContain("invalid or expired");
  });

  it("rotates the refresh token, and revokes the family if an old one comes back", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    const first = parse(
      await call("POST", "/token", {
        body: tokenBody({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      }),
    ) as Record<string, string>;

    const refreshed = parse(
      await call("POST", "/token", {
        body: tokenBody({ grant_type: "refresh_token", refresh_token: first.refresh_token }),
      }),
    ) as Record<string, string>;
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(first.refresh_token);

    // Replaying the rotated-out token means it leaked: the whole family dies, new one included.
    const reuse = await call("POST", "/token", {
      body: tokenBody({ grant_type: "refresh_token", refresh_token: first.refresh_token }),
    });
    expect(parse(reuse).error_description).toContain("was already used");

    const afterRevoke = await call("POST", "/token", {
      body: tokenBody({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token }),
    });
    expect(parse(afterRevoke)).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects unknown grants and junk tokens with RFC-shaped errors", async () => {
    expect(parse(await call("POST", "/token", { body: tokenBody({ grant_type: "password" }) }))).toMatchObject({
      error: "unsupported_grant_type",
    });
    expect(
      parse(await call("POST", "/token", { body: tokenBody({ grant_type: "refresh_token", refresh_token: "junk" }) })),
    ).toMatchObject({ error: "invalid_grant" });
    // An access token is not a refresh token, even though both are ours.
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    const issued = parse(
      await call("POST", "/token", {
        body: tokenBody({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      }),
    ) as Record<string, string>;
    expect(
      parse(
        await call("POST", "/token", {
          body: tokenBody({ grant_type: "refresh_token", refresh_token: issued.access_token }),
        }),
      ),
    ).toMatchObject({ error: "invalid_grant" });
  });

  it("only answers POST on the endpoints that change state", async () => {
    expect((await call("GET", "/token"))!.statusCode).toBe(405);
    expect((await call("GET", "/register"))!.statusCode).toBe(405);
  });
});

describe("consent-page throttling", () => {
  const wrong = async (clientId: string, challenge: string) =>
    call("POST", "/authorize", {
      body: authorizeQuery(clientId, challenge) + "&action=approve&password=nope",
    });

  it("stops answering after a run of wrong passphrases, then recovers", async () => {
    const clientId = await register();
    const { challenge } = pkce();

    for (let i = 0; i < 5; i++) expect((await wrong(clientId, challenge))!.statusCode).toBe(401);

    const locked = await wrong(clientId, challenge);
    expect(locked!.statusCode).toBe(429);
    expect(locked!.body).toContain("Too many failed attempts");

    // Even the right passphrase is refused while the cooldown runs — that is the point.
    const duringLockout = await call("POST", "/authorize", {
      body: authorizeQuery(clientId, challenge) + "&action=approve&password=" + encodeURIComponent(PASSPHRASE),
    });
    expect(duringLockout!.statusCode).toBe(429);

    clock = NOW + 16 * 60_000;
    const after = await call("POST", "/authorize", {
      body: authorizeQuery(clientId, challenge) + "&action=approve&password=" + encodeURIComponent(PASSPHRASE),
    });
    expect(after!.statusCode).toBe(302);
  });

  it("a correct passphrase resets the count", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    for (let i = 0; i < 4; i++) await wrong(clientId, challenge);
    await approve(clientId, challenge); // succeeds, clearing the slate

    for (let i = 0; i < 4; i++) expect((await wrong(clientId, challenge))!.statusCode).toBe(401);
  });
});
