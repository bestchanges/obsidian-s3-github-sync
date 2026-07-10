import { AwsClient } from "aws4fetch";
import type {
  GetOptions,
  GetResult,
  HeadResult,
  ObjectInfo,
  PutOptions,
  PutResult,
  StorageAdapter,
} from "@vault-sync/core";
import { PreconditionFailedError } from "@vault-sync/core";

export interface S3FetchConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  /** key prefix inside the bucket, e.g. "vault/" */
  prefix?: string;
}

/** StorageAdapter over aws4fetch — small bundle, works on Obsidian desktop AND mobile. */
export class S3FetchAdapter implements StorageAdapter {
  private aws: AwsClient;
  private base: string;
  private prefix: string;

  constructor(cfg: S3FetchConfig) {
    this.aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: "s3",
    });
    this.base = `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
    this.prefix = cfg.prefix ?? "";
  }

  private url(key: string, query?: Record<string, string>): string {
    const encoded = (this.prefix + key).split("/").map(encodeURIComponent).join("/");
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    return `${this.base}/${encoded}${qs}`;
  }

  private static metaFromHeaders(headers: Headers): Record<string, string> {
    const meta: Record<string, string> = {};
    headers.forEach((v, k) => {
      if (k.toLowerCase().startsWith("x-amz-meta-")) meta[k.slice("x-amz-meta-".length)] = v;
    });
    return meta;
  }

  async get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    const res = await this.aws.fetch(
      this.url(key, opts?.versionId ? { versionId: opts.versionId } : undefined),
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET ${key}: ${res.status}`);
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      etag: res.headers.get("etag") ?? undefined,
      versionId: res.headers.get("x-amz-version-id") ?? undefined,
      metadata: S3FetchAdapter.metaFromHeaders(res.headers),
    };
  }

  async head(key: string): Promise<HeadResult | null> {
    const res = await this.aws.fetch(this.url(key), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD ${key}: ${res.status}`);
    return {
      etag: res.headers.get("etag") ?? undefined,
      metadata: S3FetchAdapter.metaFromHeaders(res.headers),
    };
  }

  async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    const headers: Record<string, string> = {};
    if (opts?.ifNoneMatch) headers["If-None-Match"] = "*";
    if (opts?.ifMatch) headers["If-Match"] = opts.ifMatch;
    for (const [k, v] of Object.entries(opts?.metadata ?? {})) headers[`x-amz-meta-${k}`] = v;
    const res = await this.aws.fetch(this.url(key), {
      method: "PUT",
      headers,
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });
    if (res.status === 412) throw new PreconditionFailedError(key);
    if (!res.ok) throw new Error(`S3 PUT ${key}: ${res.status}`);
    return {
      etag: res.headers.get("etag") ?? undefined,
      versionId: res.headers.get("x-amz-version-id") ?? undefined,
    };
  }

  async list(prefix: string, startAfter?: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix: this.prefix + prefix,
      };
      if (startAfter) query["start-after"] = this.prefix + startAfter;
      if (token) query["continuation-token"] = token;
      const res = await this.aws.fetch(`${this.base}/?${new URLSearchParams(query)}`);
      if (!res.ok) throw new Error(`S3 LIST: ${res.status}`);
      const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
      for (const node of Array.from(xml.getElementsByTagName("Contents"))) {
        const key = node.getElementsByTagName("Key")[0]?.textContent ?? "";
        const lm = node.getElementsByTagName("LastModified")[0]?.textContent;
        out.push({
          key: key.slice(this.prefix.length),
          lastModified: lm ? new Date(lm) : undefined,
        });
      }
      const truncated = xml.getElementsByTagName("IsTruncated")[0]?.textContent === "true";
      token = truncated
        ? (xml.getElementsByTagName("NextContinuationToken")[0]?.textContent ?? undefined)
        : undefined;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key}: ${res.status}`);
  }
}
