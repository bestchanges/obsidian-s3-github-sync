import { InMemoryStorage } from "@vault-sync/core";
import { describe, expect, it } from "vitest";
import {
  clientConfigs,
  MCP_INFO_KEY,
  parseMcpConnection,
  probeMcp,
  readMcpConnection,
  TOKEN_PLACEHOLDER,
  type McpConnection,
} from "../src/mcp-info";

const CONN: McpConnection = {
  version: 1,
  endpoint: "https://abc123.lambda-url.ap-southeast-1.on.aws/mcp",
  region: "ap-southeast-1",
  vault: "gsd2",
  authModes: ["bearer"],
  tools: ["list_notes", "get_note"],
};

const put = async (storage: InMemoryStorage, text: string): Promise<void> => {
  await storage.put(MCP_INFO_KEY, new TextEncoder().encode(text));
};

describe("parseMcpConnection", () => {
  it("accepts a published document and defaults the schema version", () => {
    const doc = parseMcpConnection(JSON.stringify({ endpoint: CONN.endpoint, vault: "gsd2" }));
    expect(doc).toMatchObject({ version: 1, endpoint: CONN.endpoint, vault: "gsd2" });
  });

  it("rejects malformed JSON, non-objects, and anything that isn't an https endpoint", () => {
    expect(parseMcpConnection("{not json")).toBeNull();
    expect(parseMcpConnection('"a string"')).toBeNull();
    expect(parseMcpConnection(JSON.stringify({ endpoint: 42 }))).toBeNull();
    // http:// would send the bearer token in the clear — treated as "no info", not as a server.
    expect(parseMcpConnection(JSON.stringify({ endpoint: "http://x.example/mcp" }))).toBeNull();
  });
});

describe("readMcpConnection", () => {
  it("returns null when no server has been installed for the vault", async () => {
    expect(await readMcpConnection(new InMemoryStorage())).toBeNull();
  });

  it("reads the document from the vault prefix root", async () => {
    const storage = new InMemoryStorage();
    await put(storage, JSON.stringify(CONN));
    expect(await readMcpConnection(storage)).toMatchObject({ endpoint: CONN.endpoint, vault: "gsd2" });
  });

  it("treats a corrupt document as absent rather than throwing into settings", async () => {
    const storage = new InMemoryStorage();
    await put(storage, "half-written{");
    expect(await readMcpConnection(storage)).toBeNull();
  });
});

describe("clientConfigs", () => {
  it("covers every supported client surface", () => {
    const clients = clientConfigs(CONN, "tok").map((c) => c.client);
    expect(clients).toEqual([
      "Claude Code",
      "Claude Desktop",
      "Gemini CLI",
      "claude.ai · ChatGPT · Gemini app",
    ]);
  });

  it("embeds the token in the header-capable clients and names the server after the vault", () => {
    const [claudeCode, desktop, gemini, web] = clientConfigs(CONN, "tok");
    expect(claudeCode.text).toContain('--header "Authorization: Bearer tok"');
    expect(claudeCode.text).toContain("vault-gsd2");
    expect(JSON.parse(desktop.text).mcpServers["vault-gsd2"]).toEqual({
      type: "http",
      url: CONN.endpoint,
      headers: { Authorization: "Bearer tok" },
    });
    // Gemini CLI's key is httpUrl, not url — a url here silently means "stdio" to it.
    expect(JSON.parse(gemini.text).mcpServers["vault-gsd2"].httpUrl).toBe(CONN.endpoint);
    // The web connectors cannot send headers: the URL alone, and no secret to leak by copying.
    expect(web.text).toBe(CONN.endpoint);
    expect(web.containsSecret).toBe(false);
  });

  it("falls back to a visible placeholder before a token is pasted on this device", () => {
    for (const cfg of clientConfigs(CONN, "")) {
      expect(cfg.containsSecret).toBe(false);
      if (cfg.kind !== "url") expect(cfg.text).toContain(TOKEN_PLACEHOLDER);
    }
  });

  it("sanitizes a vault name that isn't a legal MCP server name", () => {
    const [claudeCode] = clientConfigs({ ...CONN, vault: "My Vault!" }, "tok");
    expect(claudeCode.text).toContain("vault-my-vault");
  });
});

describe("probeMcp", () => {
  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reports the server identity on a successful handshake", async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse(200, { result: { serverInfo: { name: "vault-mcp", version: "0.1.0" } } });
    expect(await probeMcp(CONN.endpoint, "tok", fetchImpl as typeof fetch)).toEqual({
      state: "ok",
      detail: "Connected — vault-mcp 0.1.0.",
    });
  });

  it("sends the bearer header only when this device has a token", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      seen.push((init?.headers as Record<string, string>)?.authorization ?? null);
      return jsonResponse(200, { result: {} });
    };
    await probeMcp(CONN.endpoint, "tok", fetchImpl as unknown as typeof fetch);
    await probeMcp(CONN.endpoint, "", fetchImpl as unknown as typeof fetch);
    expect(seen).toEqual(["Bearer tok", null]);
  });

  // A 401 proves the pipe: the server is up and enforcing auth. The two cases differ only in whose
  // problem it is — no token here yet, versus a token the server refuses.
  it("distinguishes 'no token here yet' from 'token rejected'", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("", { status: 401 });
    const missing = await probeMcp(CONN.endpoint, "", fetchImpl as typeof fetch);
    const rejected = await probeMcp(CONN.endpoint, "bad", fetchImpl as typeof fetch);
    expect(missing.state).toBe("unauthorized");
    expect(missing.detail).toContain("paste the bearer token");
    expect(rejected.state).toBe("unauthorized");
    expect(rejected.detail).toContain("rejected this token");
  });

  it("reports an unreachable endpoint instead of throwing", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    };
    const res = await probeMcp(CONN.endpoint, "tok", fetchImpl as typeof fetch);
    expect(res.state).toBe("unreachable");
    expect(res.detail).toContain("Failed to fetch");
  });

  it("still reports success when a 200 body isn't the JSON we expect", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("not json", { status: 200 });
    expect((await probeMcp(CONN.endpoint, "tok", fetchImpl as typeof fetch)).state).toBe("ok");
  });
});
