import { beforeAll, describe, expect, it } from "vitest";
import { checkBearer } from "../src/auth";
import type { FunctionUrlEvent } from "../src/handler";

const TOKEN = "test-token-123";

// handler reads env lazily on first invocation — set it before importing/invoking
beforeAll(() => {
  process.env.BUCKET = "test-bucket";
  process.env.PREFIX = "unit/";
  process.env.MCP_BEARER_TOKEN = TOKEN;
});

function post(body: unknown, token: string | null = TOKEN, method = "POST", path = "/mcp"): FunctionUrlEvent {
  return {
    requestContext: { http: { method, path } },
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
};

describe("checkBearer", () => {
  it("accepts the exact token and rejects everything else", () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(checkBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(checkBearer(TOKEN, TOKEN)).toBe(false); // missing scheme
    expect(checkBearer(undefined, TOKEN)).toBe(false);
    expect(checkBearer("Bearer ", TOKEN)).toBe(false);
  });
});

describe("handler", () => {
  it("answers initialize over the single-shot transport", async () => {
    const { handler } = await import("../src/handler");
    const res = await handler(post(initialize));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe("vault-mcp");
  });

  it("returns 202 for notifications", async () => {
    const { handler } = await import("../src/handler");
    const res = await handler(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.statusCode).toBe(202);
  });

  it("rejects a missing or wrong bearer token with 401", async () => {
    const { handler } = await import("../src/handler");
    expect((await handler(post(initialize, null))).statusCode).toBe(401);
    const res = await handler(post(initialize, "wrong"));
    expect(res.statusCode).toBe(401);
    expect(res.headers?.["www-authenticate"]).toBe("Bearer");
  });

  it("rejects non-POST, unknown paths, batches, and garbage", async () => {
    const { handler } = await import("../src/handler");
    expect((await handler(post(initialize, TOKEN, "GET"))).statusCode).toBe(405);
    expect((await handler(post(initialize, TOKEN, "POST", "/other"))).statusCode).toBe(404);
    expect((await handler(post([initialize]))).statusCode).toBe(400);
    const garbage = { ...post(initialize), body: "{nope" };
    expect((await handler(garbage)).statusCode).toBe(400);
  });
});
