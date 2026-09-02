import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { S3SdkAdapter } from "@vault-sync/git-sync/src/s3-adapter";
import { createRevPublisher } from "@vault-sync/git-sync/src/notify";
import { authenticate, canWrite } from "./auth";
import { buildServer, type ServerDeps } from "./mcp";
import { challengeHeader, issuerFromHost, MCP_PATH } from "./oauth/metadata";
import { handleOAuth } from "./oauth/routes";
import { AuthStore } from "./oauth/store";
import { makePresigner } from "./presign";
import { SingleShotTransport } from "./transport";
import { VaultClient, WRITER_ID } from "./vault";

/** Lambda Function URL event (payload format 2.0) — the few fields we use, typed inline. */
export interface FunctionUrlEvent {
  requestContext: { http: { method: string; path: string } };
  headers?: Record<string, string | undefined>;
  rawQueryString?: string;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

interface Config {
  bucket: string;
  prefix: string;
  region?: string;
  token?: string;
  signingKey?: string;
  passwordHash?: string;
  vaultName?: string;
}

// Config + deps are resolved lazily (not at import) and cached for the warm container.
let cached: { config: Config; deps: ServerDeps; store: AuthStore } | undefined;

function init(): { config: Config; deps: ServerDeps; store: AuthStore } {
  if (cached) return cached;
  const bucket = process.env.BUCKET;
  if (!bucket) throw new Error("BUCKET env is required");
  const token = process.env.MCP_BEARER_TOKEN;
  const signingKey = process.env.MCP_OAUTH_SIGNING_KEY;
  if (!token && !signingKey) {
    throw new Error("one of MCP_BEARER_TOKEN or MCP_OAUTH_SIGNING_KEY is required");
  }
  const config: Config = {
    bucket,
    prefix: process.env.PREFIX ?? "",
    region: process.env.AWS_REGION,
    token,
    signingKey,
    passwordHash: process.env.MCP_LOGIN_PASSWORD_HASH,
    vaultName: vaultNameFromPrefix(process.env.PREFIX ?? ""),
  };
  const storage = new S3SdkAdapter(config.bucket, config.prefix, config.region);
  cached = {
    config,
    store: new AuthStore(storage),
    deps: {
      vault: new VaultClient(
        storage,
        undefined,
        // Optional (§4.14): with IOT_ENDPOINT unset this is a no-op publisher and writes behave
        // exactly as before — devices simply learn about them on their next poll.
        createRevPublisher({
          endpoint: process.env.IOT_ENDPOINT,
          region: config.region,
          prefix: config.prefix,
          by: WRITER_ID,
        }),
      ),
      presignGet: makePresigner(config.bucket, config.prefix, config.region),
      vaultName: config.vaultName,
    },
  };
  return cached;
}

/**
 * The vault's name out of its key prefix (`<user>/vaults/<vault>/`) — the same name the user's
 * Obsidian vault folder carries, which is what `obsidian://open?vault=…` citation links need, and
 * what the consent page shows the owner.
 * Undefined for any prefix that doesn't follow the layout; links then omit the vault.
 */
export function vaultNameFromPrefix(prefix: string): string | undefined {
  return /(?:^|\/)vaults\/([^/]+)\/?$/.exec(prefix)?.[1];
}

function json(statusCode: number, value: unknown): HttpResult {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

function decodeBody(event: FunctionUrlEvent): string {
  return event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
}

export async function handler(event: FunctionUrlEvent): Promise<HttpResult> {
  const { config, deps, store } = init();
  const { method, path } = event.requestContext.http;
  // Function URLs have no configured base URL, so the issuer is whatever host the client called —
  // which is also what its OAuth metadata must echo back for discovery to line up.
  const issuer = issuerFromHost(event.headers?.host) ?? "https://localhost";

  if (path !== MCP_PATH) {
    const oauth = await handleOAuth(
      {
        method,
        path,
        issuer,
        query: new URLSearchParams(event.rawQueryString ?? ""),
        body: decodeBody(event),
      },
      {
        signingKey: config.signingKey ?? "",
        passwordHash: config.signingKey ? config.passwordHash : undefined,
        store,
        vaultName: config.vaultName ?? "this vault",
      },
    );
    return oauth ?? json(404, { error: "not found" });
  }

  const auth = authenticate(event.headers?.authorization, {
    staticToken: config.token,
    signingKey: config.signingKey,
    audience: issuer + MCP_PATH,
  });
  if (!auth.ok) {
    // The challenge is what starts OAuth discovery, and clients only honour it on a 401.
    return {
      statusCode: 401,
      headers: { "www-authenticate": config.signingKey ? challengeHeader(issuer) : "Bearer" },
      body: "",
    };
  }
  // Streamable HTTP, JSON-response mode only: no SSE stream (GET) and no session to DELETE.
  if (method !== "POST") return { statusCode: 405, headers: { allow: "POST" }, body: "" };

  let message: JSONRPCMessage;
  try {
    const parsed = JSON.parse(decodeBody(event));
    if (Array.isArray(parsed)) return json(400, { error: "JSON-RPC batching is not supported" });
    message = JSONRPCMessageSchema.parse(parsed);
  } catch {
    return json(400, { error: "invalid JSON-RPC message" });
  }

  const server = buildServer({ ...deps, readOnly: !canWrite(auth.scope) });
  const transport = new SingleShotTransport();
  await server.connect(transport);
  try {
    const response = await transport.handle(message);
    return response ? json(200, response) : { statusCode: 202, body: "" };
  } finally {
    await server.close();
  }
}
