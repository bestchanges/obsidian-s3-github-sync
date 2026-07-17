import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryStorage } from "@vault-sync/core";
import { buildServer } from "../src/mcp";
import { VaultClient } from "../src/vault";

async function connect() {
  const storage = new InMemoryStorage();
  const server = buildServer({
    vault: new VaultClient(storage),
    presignGet: async (path, versionId) => `https://signed.example/${path}?v=${versionId ?? "latest"}`,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, storage };
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function payload(res: ToolResult): unknown {
  expect(res.isError ?? false).toBe(false);
  return JSON.parse(res.content[0].text);
}

describe("MCP tool surface", () => {
  it("exposes the eight POC tools", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_file",
      "get_note",
      "list_files",
      "list_notes",
      "remove_file",
      "remove_note",
      "save_file",
      "save_note",
    ]);
  });

  it("save_note / get_note / list_notes round-trip", async () => {
    const { client } = await connect();
    const saved = payload(await call(client, "save_note", { path: "inbox/idea.md", text: "# Idea\n" })) as {
      rev: number;
      hash: string;
    };
    expect(saved.rev).toBe(1);

    const note = payload(await call(client, "get_note", { path: "inbox/idea.md" })) as Record<string, unknown>;
    expect(note.text).toBe("# Idea\n");
    expect(note.hash).toBe(saved.hash);

    const listed = payload(await call(client, "list_notes", { dir: "inbox" })) as { path: string }[];
    expect(listed.map((e) => e.path)).toEqual(["inbox/idea.md"]);
  });

  it("note tools reject non-.md paths", async () => {
    const { client } = await connect();
    for (const name of ["get_note", "save_note", "remove_note"]) {
      const res = await call(client, name, { path: "img.png", text: "x" });
      expect(res.isError, name).toBe(true);
      expect(res.content[0].text).toContain("not a note path");
    }
  });

  it("remove_note deletes; a later get_note errors", async () => {
    const { client } = await connect();
    await call(client, "save_note", { path: "a.md", text: "x" });
    expect(payload(await call(client, "remove_note", { path: "a.md" }))).toEqual({ rev: 2 });
    const gone = await call(client, "get_note", { path: "a.md" });
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain("not found");
  });

  it("save_file / get_file round-trip via base64 + presigned URL", async () => {
    const { client, storage } = await connect();
    const bytes = new Uint8Array([1, 2, 3, 255]);
    payload(await call(client, "save_file", { path: "assets/blob.bin", base64: Buffer.from(bytes).toString("base64") }));

    const stored = await storage.get("files/assets/blob.bin");
    expect([...stored!.body]).toEqual([...bytes]);

    const file = payload(await call(client, "get_file", { path: "assets/blob.bin" })) as Record<string, unknown>;
    expect(file.url).toBe(`https://signed.example/assets/blob.bin?v=${stored!.versionId}`);
    expect(file.size).toBe(4);
    expect(file.expiresInSeconds).toBe(300);
  });

  it("save_file rejects malformed base64", async () => {
    const { client } = await connect();
    const res = await call(client, "save_file", { path: "a.bin", base64: "not-base64!!!" });
    expect(res.isError).toBe(true);
  });

  it("hidden paths error instead of leaking", async () => {
    const { client } = await connect();
    const res = await call(client, "save_note", { path: ".obsidian/app.md", text: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unsafe or excluded");
  });
});
