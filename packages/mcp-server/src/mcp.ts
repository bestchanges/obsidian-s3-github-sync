import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isNotePath, MAX_UPLOAD_BYTES, VaultClient, type PathKind } from "./vault";

export const SERVER_INFO = { name: "vault-mcp", version: "0.1.0" };
/** get_file presigned-URL lifetime */
export const PRESIGN_TTL_SECONDS = 300;

export interface ServerDeps {
  vault: VaultClient;
  /** presigned S3 GET for `files/<path>` — binary content never transits the Lambda */
  presignGet: (path: string, versionId?: string) => Promise<string>;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

const pathArg = z.string().describe("Vault-relative path, e.g. 'projects/idea.md'");
const listArgs = {
  dir: z.string().optional().describe("Scope to this directory (default: vault root)"),
  recursive: z.boolean().optional().describe("Include subdirectories (default: true)"),
};

/** Stateless per-invocation server (design §2): construct, connect to a transport, discard. */
export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  const { vault } = deps;

  const list = (kind: PathKind) => (args: { dir?: string; recursive?: boolean }) =>
    run(async () => ok(await vault.list(kind, args.dir ?? "", args.recursive ?? true)));

  server.registerTool(
    "list_notes",
    { description: "List markdown notes in the vault ({path, size, mtime}).", inputSchema: listArgs },
    list("note"),
  );

  server.registerTool(
    "list_files",
    { description: "List non-markdown files in the vault ({path, size, mtime}).", inputSchema: listArgs },
    list("file"),
  );

  server.registerTool(
    "get_note",
    { description: "Read a markdown note's text.", inputSchema: { path: pathArg } },
    (args) =>
      run(async () => {
        if (!isNotePath(args.path)) return fail(`not a note path (.md): ${args.path}`);
        const res = await vault.read(args.path);
        if (!res) return fail(`note not found: ${args.path}`);
        const { entry } = res;
        return ok({
          path: args.path,
          text: new TextDecoder().decode(res.bytes),
          hash: entry.hash,
          size: entry.size,
          mtime: entry.mtime,
        });
      }),
  );

  server.registerTool(
    "save_note",
    {
      description:
        "Create or overwrite a markdown note (last-writer-wins; concurrent device edits are merged by their sync).",
      inputSchema: { path: pathArg, text: z.string().describe("Full note content") },
    },
    (args) =>
      run(async () => {
        if (!isNotePath(args.path)) return fail(`not a note path (.md): ${args.path}`);
        return ok(await vault.write(args.path, new TextEncoder().encode(args.text)));
      }),
  );

  server.registerTool(
    "remove_note",
    { description: "Delete a markdown note from the vault.", inputSchema: { path: pathArg } },
    (args) =>
      run(async () => {
        if (!isNotePath(args.path)) return fail(`not a note path (.md): ${args.path}`);
        const res = await vault.remove(args.path);
        return res ? ok(res) : fail(`note not found: ${args.path}`);
      }),
  );

  server.registerTool(
    "get_file",
    {
      description: `Get a download URL for a file (presigned, expires in ${PRESIGN_TTL_SECONDS} s).`,
      inputSchema: { path: pathArg },
    },
    (args) =>
      run(async () => {
        const entry = await vault.entry(args.path);
        if (!entry) return fail(`file not found: ${args.path}`);
        const url = await deps.presignGet(args.path, entry.s3VersionId);
        return ok({ path: args.path, url, expiresInSeconds: PRESIGN_TTL_SECONDS, size: entry.size, mtime: entry.mtime });
      }),
  );

  server.registerTool(
    "save_file",
    {
      description: `Create or overwrite a file from base64 content (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB).`,
      inputSchema: { path: pathArg, base64: z.string().describe("File content, base64-encoded") },
    },
    (args) =>
      run(async () => {
        if (!/^[A-Za-z0-9+/=\s]*$/.test(args.base64)) return fail("invalid base64 content");
        const bytes = new Uint8Array(Buffer.from(args.base64, "base64"));
        if (bytes.byteLength > MAX_UPLOAD_BYTES) {
          return fail(`file too large: ${bytes.byteLength} bytes (max ${MAX_UPLOAD_BYTES})`);
        }
        return ok(await vault.write(args.path, bytes));
      }),
  );

  server.registerTool(
    "remove_file",
    { description: "Delete a file from the vault.", inputSchema: { path: pathArg } },
    (args) =>
      run(async () => {
        const res = await vault.remove(args.path);
        return res ? ok(res) : fail(`file not found: ${args.path}`);
      }),
  );

  return server;
}
