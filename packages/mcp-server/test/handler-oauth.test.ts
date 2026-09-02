import { beforeAll, describe, expect, it } from "vitest";
import { signJwt } from "../src/oauth/jwt";
import { hashPassword } from "../src/oauth/password";
import type { FunctionUrlEvent } from "../src/handler";

/**
 * The handler with OAuth switched on: the 401 that starts discovery, tokens accepted on `/mcp`, and
 * a read-only token seeing a read-only tool surface. Separate file from handler.test.ts because the
 * handler resolves its environment once per container — one env per module registry.
 */

const SIGNING_KEY = "handler-oauth-signing-key";
const HOST = "fn.lambda-url.ap-southeast-1.on.aws";
const ISSUER = `https://${HOST}`;
const STATIC_TOKEN = "static-token-abc";

// One scrypt call, not one per test — see the note in oauth-flow.test.ts.
beforeAll(() => {
  process.env.BUCKET = "test-bucket";
  process.env.PREFIX = "egorka/vaults/gsd2/";
  process.env.MCP_BEARER_TOKEN = STATIC_TOKEN;
  process.env.MCP_OAUTH_SIGNING_KEY = SIGNING_KEY;
  process.env.MCP_LOGIN_PASSWORD_HASH = hashPassword("open sesame");
});

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

function request(
  path: string,
  { method = "POST", auth, body = "", query = "" }: { method?: string; auth?: string; body?: unknown; query?: string } = {},
): FunctionUrlEvent {
  return {
    requestContext: { http: { method, path } },
    headers: { host: HOST, ...(auth ? { authorization: auth } : {}) },
    rawQueryString: query,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function accessToken(scope: string, aud = `${ISSUER}/mcp`): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { iss: ISSUER, aud, sub: "vault-owner", iat: now, exp: now + 600, jti: "t1", scope },
    SIGNING_KEY,
  );
}

const toolNames = (res: { body?: string }): string[] =>
  (JSON.parse(res.body!).result.tools as { name: string }[]).map((t) => t.name).sort();

describe("handler with OAuth enabled", () => {
  it("points an unauthenticated caller at its metadata, on a 401", async () => {
    const { handler } = await import("../src/handler");
    const res = await handler(request("/mcp", { body: listTools }));
    expect(res.statusCode).toBe(401);
    // Without this exact header (and status) no client can discover where to authenticate.
    expect(res.headers?.["www-authenticate"]).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", scope="vault.read vault.write"`,
    );
  });

  it("serves discovery metadata derived from the host the client called", async () => {
    const { handler } = await import("../src/handler");
    const res = await handler(request("/.well-known/oauth-protected-resource", { method: "GET" }));
    expect(JSON.parse(res.body!)).toMatchObject({ resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER] });
  });

  it("accepts an access token it issued, and the static token too", async () => {
    const { handler } = await import("../src/handler");
    for (const auth of [`Bearer ${accessToken("vault.read vault.write")}`, `Bearer ${STATIC_TOKEN}`]) {
      const res = await handler(request("/mcp", { auth, body: listTools }));
      expect(res.statusCode).toBe(200);
      expect(toolNames(res)).toContain("save_note");
    }
  });

  it("rejects a token minted for another vault's server", async () => {
    const { handler } = await import("../src/handler");
    const foreign = accessToken("vault.read vault.write", "https://other.lambda-url.on.aws/mcp");
    expect((await handler(request("/mcp", { auth: `Bearer ${foreign}`, body: listTools }))).statusCode).toBe(401);
  });

  it("rejects a token signed with a different key", async () => {
    const { handler } = await import("../src/handler");
    const now = Math.floor(Date.now() / 1000);
    const forged = signJwt(
      { iss: ISSUER, aud: `${ISSUER}/mcp`, iat: now, exp: now + 600, jti: "x", scope: "vault.write" },
      "not-the-signing-key",
    );
    expect((await handler(request("/mcp", { auth: `Bearer ${forged}`, body: listTools }))).statusCode).toBe(401);
  });

  it("hides the writing tools from a read-only token", async () => {
    const { handler } = await import("../src/handler");
    const res = await handler(request("/mcp", { auth: `Bearer ${accessToken("vault.read")}`, body: listTools }));
    expect(res.statusCode).toBe(200);
    const names = toolNames(res);
    expect(names).toContain("search_notes");
    expect(names).toContain("get_note");
    for (const write of ["save_note", "remove_note", "save_file", "remove_file"]) {
      expect(names, write).not.toContain(write);
    }
  });

  it("routes the OAuth endpoints and still 404s everything else", async () => {
    const { handler } = await import("../src/handler");
    expect((await handler(request("/register", { body: { redirect_uris: ["https://x.example/cb"] } }))).statusCode).toBe(201);
    expect((await handler(request("/nope", { method: "GET" }))).statusCode).toBe(404);
  });
});
