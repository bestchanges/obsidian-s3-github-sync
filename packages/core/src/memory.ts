import {
  GetOptions,
  GetResult,
  HeadResult,
  ObjectInfo,
  ObjectVersion,
  PreconditionFailedError,
  PutOptions,
  PutResult,
  StorageAdapter,
} from "./s3";

/** In-memory StorageAdapter with versioning + conditional writes — protocol conformance tests run against this. */
export class InMemoryStorage implements StorageAdapter {
  private objects = new Map<
    string,
    { body: Uint8Array; etag: string; versionId: string; lastModified: Date; metadata?: Record<string, string> }
  >();
  private versions = new Map<string, Map<string, Uint8Array>>();
  /** Per-version metadata, in write order — mirrors what S3 ListObjectVersions returns (§2.9). */
  private versionMeta = new Map<string, { versionId: string; etag: string; size: number; lastModified: Date }[]>();
  private counter = 0;

  /** test hook */
  now: () => Date = () => new Date();

  async get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    if (opts?.versionId) {
      const body = this.versions.get(key)?.get(opts.versionId);
      return body ? { body: body.slice(), versionId: opts.versionId } : null;
    }
    const obj = this.objects.get(key);
    if (!obj) return null;
    return { body: obj.body.slice(), etag: obj.etag, versionId: obj.versionId, metadata: obj.metadata };
  }

  async head(key: string): Promise<HeadResult | null> {
    const obj = this.objects.get(key);
    return obj ? { etag: obj.etag, metadata: obj.metadata } : null;
  }

  async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    const existing = this.objects.get(key);
    if (opts?.ifNoneMatch && existing) throw new PreconditionFailedError(key);
    if (opts?.ifMatch !== undefined && existing?.etag !== opts.ifMatch) {
      throw new PreconditionFailedError(key);
    }
    this.counter += 1;
    const etag = `"etag-${this.counter}"`;
    const versionId = `v${this.counter}`;
    this.objects.set(key, {
      body: body.slice(),
      etag,
      versionId,
      lastModified: this.now(),
      metadata: opts?.metadata,
    });
    if (!this.versions.has(key)) this.versions.set(key, new Map());
    this.versions.get(key)!.set(versionId, body.slice());
    if (!this.versionMeta.has(key)) this.versionMeta.set(key, []);
    this.versionMeta.get(key)!.push({
      versionId,
      etag,
      size: body.byteLength,
      lastModified: this.objects.get(key)!.lastModified,
    });
    return { etag, versionId };
  }

  async list(prefix: string, startAfter?: string): Promise<ObjectInfo[]> {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, o]) => ({ key, lastModified: o.lastModified }));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** Newest first, like S3. Versions survive `delete()` here for the same reason they do in S3:
   * the protocol tombstones in the journal and never issues DeleteObject (§2.8). */
  async listVersions(key: string): Promise<ObjectVersion[]> {
    const metas = this.versionMeta.get(key) ?? [];
    const latest = this.objects.get(key)?.versionId;
    return metas
      .map((m) => ({
        versionId: m.versionId,
        lastModified: m.lastModified,
        size: m.size,
        etag: m.etag.replace(/"/g, ""),
        isLatest: m.versionId === latest,
      }))
      .reverse();
  }

  async copy(srcKey: string, destKey: string, srcVersionId?: string): Promise<PutResult> {
    const body = srcVersionId
      ? this.versions.get(srcKey)?.get(srcVersionId)
      : this.objects.get(srcKey)?.body;
    if (!body) throw new Error(`copy: source not found: ${srcKey}${srcVersionId ? `@${srcVersionId}` : ""}`);
    return this.put(destKey, body);
  }
}
