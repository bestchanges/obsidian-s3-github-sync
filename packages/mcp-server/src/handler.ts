import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { S3SdkAdapter } from "@vault-sync/git-sync/src/s3-adapter";
import { checkBearer } from "./auth";
import { buildServer, type ServerDeps } from "./mcp";
import { makePresigner } from "./presign";
import { SingleShotTransport } from "./transport";
import { VaultClient } from "./vault";

/** Lambda Function URL event (payload format 2.0) — the few fields we use, typed inline. */
export interface FunctionUrlEvent {
  requestContext: { http: { method: string; path: string } };
  headers?: Record<string, string | undefined>;
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
  token: string;
}

// Config + deps are resolved lazily (not at import) and cached for the warm container.
let cached: { config: Config; deps: ServerDeps } | undefined;

function init(): { config: Config; deps: ServerDeps } {
  if (cached) return cached;
  const bucket = process.env.BUCKET;
  const token = process.env.MCP_BEARER_TOKEN;
  if (!bucket) throw new Error("BUCKET env is required");
  if (!token) throw new Error("MCP_BEARER_TOKEN env is required");
  const config: Config = {
    bucket,
    prefix: process.env.PREFIX ?? "",
    region: process.env.AWS_REGION,
    token,
  };
  cached = {
    config,
    deps: {
      vault: new VaultClient(new S3SdkAdapter(config.bucket, config.prefix, config.region)),
      presignGet: makePresigner(config.bucket, config.prefix, config.region),
    },
  };
  return cached;
}

function json(statusCode: number, value: unknown): HttpResult {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

export async function handler(event: FunctionUrlEvent): Promise<HttpResult> {
  const { config, deps } = init();
  const { method, path } = event.requestContext.http;

  if (path !== "/mcp") return json(404, { error: "not found" });
  if (!checkBearer(event.headers?.authorization, config.token)) {
    return { statusCode: 401, headers: { "www-authenticate": "Bearer" }, body: "" };
  }
  // Streamable HTTP, JSON-response mode only: no SSE stream (GET) and no session to DELETE.
  if (method !== "POST") return { statusCode: 405, headers: { allow: "POST" }, body: "" };

  let message: JSONRPCMessage;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return json(400, { error: "JSON-RPC batching is not supported" });
    message = JSONRPCMessageSchema.parse(parsed);
  } catch {
    return json(400, { error: "invalid JSON-RPC message" });
  }

  const server = buildServer(deps);
  const transport = new SingleShotTransport();
  await server.connect(transport);
  try {
    const response = await transport.handle(message);
    return response ? json(200, response) : { statusCode: 202, body: "" };
  } finally {
    await server.close();
  }
}
