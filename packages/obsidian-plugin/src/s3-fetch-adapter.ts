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

/** Per-attempt ceiling. Mobile suspends the WebView mid-request: the socket dies but the promise is
 * never settled, so without this a poll issued before a suspend can hang for hours (observed: 9 h)
 * and hold the engine's single-flight lock the whole time. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Backoff before retry 1 and retry 2 of an idempotent request. Short: the failure mode this exists
 * for (Android tearing down the network stack across a freeze) recovers in well under a second. */
const RETRY_BACKOFF_MS = [300, 900];

/** Network-level failure: the request never left the device. `TypeError` is what fetch rejects with
 * ("Failed to fetch"); `AbortError` is our own timeout above. */
function isTransientError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  return err instanceof Error && err.name === "AbortError";
}

/** 403 is the one status worth another signed attempt: after a resume S3 rejects a request signed
 * with a stale/skewed clock, and re-issuing re-signs it with a fresh x-amz-date. (5xx and 429 are
 * deliberately absent — aws4fetch already retries those itself, with its own backoff.) */
function isTransientStatus(status: number): boolean {
  return status === 403;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** StorageAdapter over aws4fetch — small bundle, works on Obsidian desktop AND mobile. */
export class S3FetchAdapter implements StorageAdapter {
  private aws: AwsClient;
  private base: string;
  private prefix: string;
  private bucket: string;

  constructor(cfg: S3FetchConfig) {
    this.aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: "s3",
    });
    this.bucket = cfg.bucket;
    this.base = `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
    this.prefix = cfg.prefix ?? "";
  }

  private url(key: string, query?: Record<string, string>): string {
    const encoded = (this.prefix + key).split("/").map(encodeURIComponent).join("/");
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    return `${this.base}/${encoded}${qs}`;
  }

  /** Single funnel for every S3 call: signs, bounds the attempt with a timeout, and — for
   * **idempotent** requests only (`retry`) — retries a network-level failure or a transient status.
   *
   * Writes (PUT/DELETE/COPY) pass `retry: false` deliberately. A PUT that failed at the network layer
   * may still have landed in S3, and the delta PUTs are conditional (If-None-Match/If-Match): silently
   * re-issuing one would turn our own write into a lost-CAS race against itself. Reads have no such
   * hazard, and they are where the resume failures actually happen (poll = LIST + GET).
   *
   * Errors and non-ok responses are returned/thrown exactly as an un-retried call would, so callers
   * (and the log lines they produce) are unchanged. This layer only covers what aws4fetch does NOT:
   * it retries 5xx/429 internally but propagates network-level rejections and 403s straight up. */
  private async request(url: string, init: RequestInit = {}, retry = false): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = !retry || attempt >= RETRY_BACKOFF_MS.length;
      const timer = new AbortController();
      const cancel = setTimeout(() => timer.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await this.aws.fetch(url, { ...init, signal: timer.signal });
        if (last || !isTransientStatus(res.status)) return res;
      } catch (err) {
        if (last || !isTransientError(err)) throw err;
      } finally {
        clearTimeout(cancel);
      }
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }

  private static metaFromHeaders(headers: Headers): Record<string, string> {
    const meta: Record<string, string> = {};
    headers.forEach((v, k) => {
      if (k.toLowerCase().startsWith("x-amz-meta-")) meta[k.slice("x-amz-meta-".length)] = v;
    });
    return meta;
  }

  async get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    const res = await this.request(
      this.url(key, opts?.versionId ? { versionId: opts.versionId } : undefined),
      {},
      true,
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
    const res = await this.request(this.url(key), { method: "HEAD" }, true);
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
    const res = await this.request(this.url(key), {
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
      const res = await this.request(`${this.base}/?${new URLSearchParams(query)}`, {}, true);
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
    const res = await this.request(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key}: ${res.status}`);
  }

  async copy(srcKey: string, destKey: string, srcVersionId?: string): Promise<PutResult> {
    // S3 REST CopyObject: PUT the destination with an x-amz-copy-source header (empty body). The
    // source is `/bucket/key`, URL-encoded per PATH SEGMENT (slashes kept) so spaces/Cyrillic keys
    // are valid; the versionId, if given, pins the exact source bytes.
    const encoded = (this.prefix + srcKey).split("/").map(encodeURIComponent).join("/");
    const copySource = `/${this.bucket}/${encoded}` + (srcVersionId ? `?versionId=${srcVersionId}` : "");
    const res = await this.request(this.url(destKey), {
      method: "PUT",
      headers: { "x-amz-copy-source": copySource },
    });
    if (!res.ok) throw new Error(`S3 COPY ${srcKey}→${destKey}: ${res.status}`);
    // versionId of the NEW object is in the response header; the ETag lives in the CopyObjectResult
    // body, which we don't need (the delta only carries s3VersionId).
    return {
      etag: res.headers.get("etag") ?? undefined,
      versionId: res.headers.get("x-amz-version-id") ?? undefined,
    };
  }
}
