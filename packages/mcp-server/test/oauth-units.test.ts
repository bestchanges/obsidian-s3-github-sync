import { InMemoryStorage } from "@vault-sync/core";
import { describe, expect, it, beforeEach } from "vitest";
import {
  ClientError,
  clearClientCache,
  redirectAllowed,
  registerClient,
  resolveClient,
} from "../src/oauth/clients";
import { randomId, signJwt, verifyJwt } from "../src/oauth/jwt";
import { hashPassword, verifyPassword } from "../src/oauth/password";
import { AuthStore, LOCKOUT_MS, MAX_FAILURES } from "../src/oauth/store";

const SECRET = "unit-test-signing-key";
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

describe("jwt", () => {
  const claims = { iss: "https://vault.example", aud: "aud", iat: sec(NOW), exp: sec(NOW) + 60, jti: "j1" };

  it("round-trips claims", () => {
    expect(verifyJwt(signJwt(claims, SECRET), SECRET, NOW)).toMatchObject(claims);
  });

  it("rejects a wrong key, a tampered payload, and an expired token", () => {
    const token = signJwt(claims, SECRET);
    expect(verifyJwt(token, "other-key", NOW)).toBeNull();

    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, jti: "j2" })).toString("base64url");
    expect(verifyJwt(`${h}.${forged}.${s}`, SECRET, NOW)).toBeNull();

    expect(verifyJwt(token, SECRET, NOW + 61_000)).toBeNull();
  });

  // The classic JWT attack: swap the algorithm to `none` and drop the signature.
  it("refuses alg: none even with an empty signature", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expect(verifyJwt(`${header}.${payload}.`, SECRET, NOW)).toBeNull();
    expect(verifyJwt("garbage", SECRET, NOW)).toBeNull();
  });

  it("mints distinct ids", () => {
    expect(randomId()).not.toBe(randomId());
  });
});

describe("password", () => {
  it("verifies the right passphrase and rejects everything else", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("fails closed on a malformed or empty stored hash", () => {
    for (const bad of ["", "plaintext", "scrypt$1$2$3", "scrypt$x$8$1$aa$bb", "md5$1$1$1$aa$bb"]) {
      expect(verifyPassword("anything", bad), bad).toBe(false);
    }
  });

  it("salts: the same passphrase hashes differently every time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
});

describe("clients — dynamic registration", () => {
  beforeEach(() => clearClientCache());

  it("issues a client_id that carries its own registration", async () => {
    const reg = registerClient(
      { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" },
      SECRET,
      NOW,
    );
    expect(reg.token_endpoint_auth_method).toBe("none");
    expect(reg.client_id).toMatch(/^dcr_/);

    const info = await resolveClient(String(reg.client_id), SECRET, fetch, NOW);
    expect(info).toMatchObject({
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
  });

  it("rejects a registration whose redirect URIs aren't https (or loopback http)", () => {
    expect(() => registerClient({ redirect_uris: ["http://evil.example/cb"] }, SECRET, NOW)).toThrow(ClientError);
    expect(() => registerClient({ redirect_uris: [] }, SECRET, NOW)).toThrow(ClientError);
    expect(() => registerClient({}, SECRET, NOW)).toThrow(ClientError);
    // Claude Code is a native client: loopback http is exactly what RFC 8252 expects.
    expect(registerClient({ redirect_uris: ["http://localhost/callback"] }, SECRET, NOW).client_id).toBeTruthy();
  });

  it("refuses a client_id signed with a different key or of an unknown form", async () => {
    const reg = registerClient({ redirect_uris: ["https://x.example/cb"] }, SECRET, NOW);
    await expect(resolveClient(String(reg.client_id), "other-key", fetch, NOW)).rejects.toThrow(ClientError);
    await expect(resolveClient("whatever", SECRET, fetch, NOW)).rejects.toThrow(ClientError);
    await expect(resolveClient("", SECRET, fetch, NOW)).rejects.toThrow(ClientError);
  });
});

describe("clients — CIMD", () => {
  beforeEach(() => clearClientCache());

  const doc = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("accepts a metadata document that claims its own URL", async () => {
    const url = "https://claude.ai/oauth/claude-code-client-metadata";
    const info = await resolveClient(
      url,
      SECRET,
      doc({ client_id: url, client_name: "Claude Code", redirect_uris: ["http://localhost/callback"] }),
      NOW,
    );
    expect(info).toMatchObject({ clientId: url, clientName: "Claude Code" });
  });

  // Otherwise any client_id could point at someone else's document and inherit its redirect URIs.
  it("rejects a document that names a different client_id", async () => {
    await expect(
      resolveClient(
        "https://attacker.example/meta",
        SECRET,
        doc({ client_id: "https://claude.ai/oauth/x", redirect_uris: ["https://claude.ai/cb"] }),
        NOW,
      ),
    ).rejects.toThrow(ClientError);
  });

  it("reports an unreachable or non-JSON document instead of throwing raw", async () => {
    await expect(resolveClient("https://x.example/meta", SECRET, doc({}, 404), NOW)).rejects.toThrow(ClientError);
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(resolveClient("https://x.example/meta", SECRET, boom, NOW)).rejects.toThrow(/network down/);
  });

  it("caches per warm container — a second resolve makes no request", async () => {
    const url = "https://claude.ai/oauth/meta";
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify({ client_id: url, redirect_uris: ["https://claude.ai/cb"] }));
    }) as unknown as typeof fetch;

    await resolveClient(url, SECRET, counting, NOW);
    await resolveClient(url, SECRET, counting, NOW);
    expect(calls).toBe(1);
  });
});

describe("redirectAllowed", () => {
  it("requires an exact match for https", () => {
    const allowed = ["https://claude.ai/api/mcp/auth_callback"];
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback", allowed)).toBe(true);
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback/evil", allowed)).toBe(false);
    expect(redirectAllowed("https://evil.example/cb", allowed)).toBe(false);
  });

  // RFC 8252 §7.3: the loopback port is assigned at runtime — Claude Code declares a portless URI
  // and listens on an ephemeral port, so an exact-match rule would reject all of its logins.
  it("ignores the port on loopback, but nothing else", () => {
    const allowed = ["http://localhost/callback", "http://127.0.0.1/callback"];
    expect(redirectAllowed("http://localhost:3118/callback", allowed)).toBe(true);
    expect(redirectAllowed("http://127.0.0.1:51234/callback", allowed)).toBe(true);
    expect(redirectAllowed("http://localhost:3118/other", allowed)).toBe(false);
    expect(redirectAllowed("http://evil.example:3118/callback", allowed)).toBe(false);
    expect(redirectAllowed("not a url", allowed)).toBe(false);
  });
});

describe("AuthStore", () => {
  it("lets a code be spent exactly once", async () => {
    const store = new AuthStore(new InMemoryStorage());
    expect(await store.consumeCode("code-1", sec(NOW) + 60)).toBe(true);
    expect(await store.consumeCode("code-1", sec(NOW) + 60)).toBe(false);
    expect(await store.consumeCode("code-2", sec(NOW) + 60)).toBe(true);
  });

  it("tracks and revokes a refresh family", async () => {
    const store = new AuthStore(new InMemoryStorage());
    expect(await store.readRefresh("fam")).toBeNull();

    const record = { jti: "r1", clientId: "dcr_x", scope: "vault.read", updatedAt: "now" };
    await store.writeRefresh("fam", record);
    expect(await store.readRefresh("fam")).toEqual(record);

    await store.revokeRefresh("fam");
    expect(await store.readRefresh("fam")).toBeNull();
  });

  it("sweeps spent-code markers once their codes have expired", async () => {
    const storage = new InMemoryStorage();
    const store = new AuthStore(storage);
    await store.consumeCode("old", sec(NOW) - 10);
    await store.consumeCode("fresh", sec(NOW) + 600);

    await store.sweep(NOW);
    const left = (await storage.list("auth/used/")).map((o) => o.key);
    expect(left).toHaveLength(1);
    expect(left[0]).toContain("fresh");
  });
});

describe("AuthStore — consent-page throttling", () => {
  it("locks the page after a run of wrong passphrases, and frees it when the cooldown passes", async () => {
    const store = new AuthStore(new InMemoryStorage());
    expect(await store.lockoutRemaining(NOW)).toBe(0);

    for (let i = 0; i < MAX_FAILURES - 1; i++) await store.recordFailure(NOW);
    expect(await store.lockoutRemaining(NOW)).toBe(0); // still under the limit

    await store.recordFailure(NOW);
    expect(await store.lockoutRemaining(NOW)).toBe(LOCKOUT_MS);
    expect(await store.lockoutRemaining(NOW + LOCKOUT_MS + 1)).toBe(0);
  });

  it("forgets failures that are older than the window", async () => {
    const store = new AuthStore(new InMemoryStorage());
    for (let i = 0; i < MAX_FAILURES - 1; i++) await store.recordFailure(NOW);
    // A day later the counter starts over rather than tipping into a lockout on one more miss.
    await store.recordFailure(NOW + 24 * 3600_000);
    expect(await store.lockoutRemaining(NOW + 24 * 3600_000)).toBe(0);
  });

  it("clears the counter once the right passphrase arrives", async () => {
    const store = new AuthStore(new InMemoryStorage());
    for (let i = 0; i < MAX_FAILURES; i++) await store.recordFailure(NOW);
    await store.clearFailures();
    expect(await store.lockoutRemaining(NOW)).toBe(0);
  });
});
