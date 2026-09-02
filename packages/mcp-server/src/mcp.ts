import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  isNotePath,
  MAX_UPLOAD_BYTES,
  VaultClient,
  type PathKind,
  type SearchHit,
} from "./vault";

export const SERVER_INFO = { name: "vault-mcp", version: "0.2.0" };
/** get_file presigned-URL lifetime */
export const PRESIGN_TTL_SECONDS = 300;

export interface ServerDeps {
  vault: VaultClient;
  /** presigned S3 GET for `files/<path>` — binary content never transits the Lambda */
  presignGet: (path: string, versionId?: string) => Promise<string>;
  /** Vault name, used to build `obsidian://` citation links. Derived from PREFIX by the handler. */
  vaultName?: string;
  /**
   * Register the reading tools only. Set when the caller's OAuth token carries `vault.read` without
   * `vault.write`: the writing tools are not merely refused but never listed, so a read-only client
   * sees a coherent surface instead of tools that always error.
   */
  readOnly?: boolean;
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

/** Deep-link a result back into the user's own vault, so a citation resolves on their machine. */
function noteUrl(vaultName: string | undefined, path: string): string {
  const file = encodeURIComponent(isNotePath(path) ? path.replace(/\.md$/i, "") : path);
  return vaultName
    ? `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${file}`
    : `obsidian://open?file=${file}`;
}

function titleOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return isNotePath(base) ? base.slice(0, -3) : base;
}

/** One line of context for a hit: its first matching line, or the path match that found it. */
function hitSnippet(hit: SearchHit): string {
  return hit.matches[0]?.text ?? `(matched on path) ${hit.path}`;
}

const listArgs = {
  dir: z.string().optional().describe("Scope to this directory (default: vault root)"),
  recursive: z.boolean().optional().describe("Include subdirectories (default: true)"),
};

/** Stateless per-invocation server (design §2): construct, connect to a transport, discard. */
export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  const { vault } = deps;

  /** Registers a tool that changes the vault — skipped entirely for a read-only token. */
  const registerWrite: McpServer["registerTool"] = ((name, config, cb) => {
    if (deps.readOnly) return undefined as never;
    return server.registerTool(name, config, cb);
  }) as McpServer["registerTool"];

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
    "search_notes",
    {
      description:
        "Full-text search across the vault's markdown notes. Matches note paths and content, " +
        "newest notes first. Returns matching lines with their line numbers; large vaults are " +
        "scanned under a budget and the result says when it was truncated.",
      inputSchema: {
        query: z.string().describe("Literal substring, or a regular expression when regex is true"),
        dir: z.string().optional().describe("Scope to this directory (default: whole vault)"),
        regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression"),
        caseSensitive: z.boolean().optional().describe("Default: false"),
        maxResults: z.number().int().positive().optional().describe("Matching notes to return (default 20)"),
        maxMatchesPerFile: z.number().int().positive().optional().describe("Lines per note (default 5)"),
        pathOnly: z.boolean().optional().describe("Match paths only — reads no content, much faster"),
      },
    },
    (args) => run(async () => ok(await vault.search(args))),
  );

  // ── ChatGPT-shaped aliases ──────────────────────────────────────────────────────────────────
  // OpenAI's connectors look for a `search`/`fetch` pair with this exact result shape (results
  // carrying id/title/url, then a fetch by id) to build citations. Same engine underneath as
  // search_notes / get_note; only the envelope differs.
  server.registerTool(
    "search",
    {
      description: "Search the vault's notes and return citable results (id, title, url).",
      inputSchema: { query: z.string().describe("What to look for") },
    },
    (args) =>
      run(async () => {
        const res = await vault.search({ query: args.query });
        return ok({
          results: res.hits.map((hit) => ({
            id: hit.path,
            title: titleOf(hit.path),
            url: noteUrl(deps.vaultName, hit.path),
            snippet: hitSnippet(hit),
          })),
          truncated: res.truncated,
        });
      }),
  );

  server.registerTool(
    "fetch",
    {
      description: "Fetch one vault document by the id returned from search.",
      inputSchema: { id: z.string().describe("Document id — the vault-relative path from search") },
    },
    (args) =>
      run(async () => {
        const entry = await vault.entry(args.id);
        if (!entry) return fail(`not found: ${args.id}`);
        const base = {
          id: args.id,
          title: titleOf(args.id),
          url: noteUrl(deps.vaultName, args.id),
          metadata: { path: args.id, size: entry.size, mtime: entry.mtime, hash: entry.hash },
        };
        if (!isNotePath(args.id)) {
          // Binary/attachment: there is no text to cite, so hand back a download URL instead.
          return ok({ ...base, text: "", url: await deps.presignGet(args.id, entry.s3VersionId) });
        }
        const res = await vault.read(args.id);
        if (!res) return fail(`not found: ${args.id}`);
        return ok({ ...base, text: new TextDecoder().decode(res.bytes) });
      }),
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

  registerWrite(
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

  registerWrite(
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

  registerWrite(
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

  registerWrite(
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
