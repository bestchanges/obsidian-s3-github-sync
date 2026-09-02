import type { StorageAdapter } from "@vault-sync/core";

/**
 * Connection metadata for this vault's remote MCP server, published to S3 by
 * `scripts/install/05-create-mcp-server.sh` and read back here so every device can see how to
 * connect an AI assistant to the vault.
 *
 * The key sits at the vault prefix ROOT, beside `snapshot.json.gz` / `deltas/` / `files/` /
 * `_logs/`. Neither sync leg lists or folds anything outside those, so this object is invisible to
 * the protocol: it never becomes vault content and never reaches the GitHub repo.
 *
 * It also carries the bearer **token**, which is what makes the MCP server usable without typing a
 * secret into every device. That needs a word of justification:
 *
 * `data.json` is where the token belongs — per-device, and excluded from sync by full path on both
 * legs, which is the same reason it can hold the AWS secret key. But precisely because it never
 * syncs, it cannot *transport* anything: a device that didn't run the installer would never see it.
 * A synced file inside the plugin's own directory would reach every device, and would also land in
 * the GitHub content repo and its history. So the token travels here — one object beside the
 * journal, inside the same private prefix, never in git — and each device copies it into its own
 * `data.json` once (`adoptToken`). Anyone who can read this object already holds the S3 keys to the
 * whole vault; the token grants a strict subset of that.
 */
export const MCP_INFO_KEY = "mcp.json";

export interface McpConnection {
  /** schema version of this document — bumped only on a breaking shape change */
  version: number;
  /** full MCP endpoint, e.g. https://<id>.lambda-url.<region>.on.aws/mcp */
  endpoint: string;
  region?: string;
  functionName?: string;
  /** vault name the server is pointed at (the `--vault` argument, not the local folder name) */
  vault?: string;
  /** which auth mechanisms the deployment accepts, e.g. ["bearer"] or ["bearer","oauth"] */
  authModes?: string[];
  /** tool names the server exposes — informational, so a device can see what it can ask for */
  tools?: string[];
  updatedAt?: string;
  /** where the human-facing setup guide lives */
  docs?: string;
  /**
   * Bearer token for this server, published so devices don't have to be told it by hand. Absent
   * when the installer was run with `--no-publish-token`, in which case the token is typed in.
   */
  token?: string;
}

/** Parse + validate a published document. Unknown fields are kept; a bad endpoint means "no info". */
export function parseMcpConnection(text: string): McpConnection | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Partial<McpConnection>;
  if (typeof doc.endpoint !== "string" || !/^https:\/\/\S+$/.test(doc.endpoint)) return null;
  return { ...doc, version: typeof doc.version === "number" ? doc.version : 1, endpoint: doc.endpoint };
}

/** Read the published document, or null when no MCP server has been installed for this vault. */
export async function readMcpConnection(storage: StorageAdapter): Promise<McpConnection | null> {
  const res = await storage.get(MCP_INFO_KEY);
  if (!res) return null;
  return parseMcpConnection(new TextDecoder().decode(res.body));
}

/**
 * Copy the published token into this device's settings, once. Returns the token that should now be
 * in use, or null when there is nothing to adopt — an unpublished deployment, or a device that
 * already has one (a token typed in here always wins, so a per-device override survives).
 */
export function tokenToAdopt(conn: McpConnection | null, current: string): string | null {
  if (current.length > 0) return null;
  const published = conn?.token?.trim();
  return published ? published : null;
}

/** Placeholder shown in copyable configs until this device has been given the bearer token. */
export const TOKEN_PLACEHOLDER = "<paste-your-token>";

export interface ClientConfig {
  /** client this snippet is for, e.g. "Claude Code" */
  client: string;
  /** what to do with `text`: run it in a shell, paste it into a config file, or paste it into a UI */
  kind: "command" | "json" | "url";
  /** one line of orientation — where the snippet goes */
  hint: string;
  text: string;
  /** true when `text` embeds the bearer token, so the UI can warn before it hits a clipboard */
  containsSecret: boolean;
}

/** Server name clients will show for this vault; keeps one vault distinguishable from the next. */
function serverName(conn: McpConnection): string {
  const raw = conn.vault ?? "vault";
  return "vault-" + raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/**
 * Ready-to-paste configuration for every client surface the vault supports, in the order a user
 * meets them: header-capable clients first (they work with the bearer token alone), then the web
 * connectors, which take the bare URL and negotiate auth themselves.
 */
export function clientConfigs(conn: McpConnection, token: string): ClientConfig[] {
  const name = serverName(conn);
  const secret = token || TOKEN_PLACEHOLDER;
  const header = `Bearer ${secret}`;
  const hasToken = token.length > 0;

  return [
    {
      client: "Claude Code",
      kind: "command",
      hint: "Run in a terminal (add --scope user to share it across projects).",
      text: `claude mcp add --transport http ${name} "${conn.endpoint}" --header "Authorization: ${header}"`,
      containsSecret: hasToken,
    },
    {
      client: "Claude Desktop",
      kind: "json",
      hint: "Settings → Developer → Edit Config, inside \"mcpServers\".",
      text: JSON.stringify(
        { mcpServers: { [name]: { type: "http", url: conn.endpoint, headers: { Authorization: header } } } },
        null,
        2,
      ),
      containsSecret: hasToken,
    },
    {
      client: "Gemini CLI",
      kind: "json",
      hint: "~/.gemini/settings.json, inside \"mcpServers\".",
      text: JSON.stringify(
        { mcpServers: { [name]: { httpUrl: conn.endpoint, headers: { Authorization: header } } } },
        null,
        2,
      ),
      containsSecret: hasToken,
    },
    {
      client: "claude.ai · ChatGPT · Gemini app",
      kind: "url",
      // These clients can't send a header at all: they paste a URL and run OAuth against it.
      hint: conn.authModes?.includes("oauth")
        ? "Paste as a custom connector URL — no token. Sign in on the consent page with your vault passphrase."
        : "Paste as a custom connector URL. Needs the OAuth mode: re-run 05-create-mcp-server.sh with --passphrase.",
      text: conn.endpoint,
      containsSecret: false,
    },
  ];
}

export type ProbeState = "ok" | "unauthorized" | "unreachable";

export interface ProbeResult {
  state: ProbeState;
  /** one line for the settings UI */
  detail: string;
}

/** Minimal MCP handshake used as a liveness check — the cheapest call that proves the whole pipe. */
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vault-s3-sync-settings", version: "1" },
  },
};

/**
 * Ping the endpoint from this device. A 401 is a *successful* probe of an unauthenticated attempt:
 * the server is up and enforcing auth, and the user simply hasn't pasted the token here yet.
 *
 * `fetchImpl` is injectable so this is testable without a network — and because the plugin must
 * pass Obsidian's `requestUrl` instead of the global `fetch`: the Function URL sends no CORS
 * headers, so a renderer/WebView `fetch` never leaves the device (see `obsidianFetch` in main.ts).
 */
export async function probeMcp(
  endpoint: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(INITIALIZE),
    });
  } catch (err) {
    return { state: "unreachable", detail: `Unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      state: "unauthorized",
      detail: token
        ? "Server is up, but rejected this token — check it, or rotate with 05-create-mcp-server.sh --rotate-token."
        : "Server is up and requires a token — paste the bearer token below.",
    };
  }
  if (!res.ok) return { state: "unreachable", detail: `Server returned HTTP ${res.status}.` };

  let name = "vault-mcp";
  try {
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string; version?: string } } };
    const info = body.result?.serverInfo;
    if (info?.name) name = info.version ? `${info.name} ${info.version}` : info.name;
  } catch {
    // A 200 that isn't the JSON we expect still proves reachability + auth; report the plain form.
  }
  return { state: "ok", detail: `Connected — ${name}.` };
}
