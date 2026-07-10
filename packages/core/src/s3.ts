/** Storage abstraction — implementations are injected per side (aws4fetch in the plugin, AWS SDK in git-sync). */

export class PreconditionFailedError extends Error {
  constructor(public key: string) {
    super(`Precondition failed: ${key}`);
    this.name = "PreconditionFailedError";
  }
}

export interface PutOptions {
  /** PUT succeeds only if the key does not exist yet (If-None-Match: *) — CAS for delta appends */
  ifNoneMatch?: boolean;
  /** PUT succeeds only if the current ETag matches — CAS for snapshot compaction */
  ifMatch?: string;
  /** stored as x-amz-meta-* */
  metadata?: Record<string, string>;
}

export interface GetOptions {
  versionId?: string;
}

export interface GetResult {
  body: Uint8Array;
  etag?: string;
  versionId?: string;
  metadata?: Record<string, string>;
}

export interface HeadResult {
  etag?: string;
  metadata?: Record<string, string>;
}

export interface PutResult {
  etag?: string;
  versionId?: string;
}

export interface ObjectInfo {
  key: string;
  lastModified?: Date;
}

export interface StorageAdapter {
  get(key: string, opts?: GetOptions): Promise<GetResult | null>;
  head(key: string): Promise<HeadResult | null>;
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<PutResult>;
  /** Keys strictly after `startAfter`, lexicographic order (S3 ListObjectsV2 semantics) */
  list(prefix: string, startAfter?: string): Promise<ObjectInfo[]>;
  delete(key: string): Promise<void>;
}
