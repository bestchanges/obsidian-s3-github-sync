import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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

function is412(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412;
}
function is404(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

/** StorageAdapter backed by AWS SDK v3 — used by git-sync in Actions. */
export class S3SdkAdapter implements StorageAdapter {
  private client: S3Client;
  constructor(
    private bucket: string,
    private prefix: string = "",
    region?: string,
  ) {
    this.client = new S3Client(region ? { region } : {});
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key), VersionId: opts?.versionId }),
      );
      return {
        body: await res.Body!.transformToByteArray(),
        etag: res.ETag,
        versionId: res.VersionId,
        metadata: res.Metadata,
      };
    } catch (err) {
      if (is404(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }),
      );
      return { etag: res.ETag, metadata: res.Metadata };
    } catch (err) {
      if (is404(err)) return null;
      throw err;
    }
  }

  async put(key: string, body: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    try {
      const res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.k(key),
          Body: body,
          ...(opts?.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
          ...(opts?.ifMatch ? { IfMatch: opts.ifMatch } : {}),
          ...(opts?.metadata ? { Metadata: opts.metadata } : {}),
        }),
      );
      return { etag: res.ETag, versionId: res.VersionId };
    } catch (err) {
      if (is412(err)) throw new PreconditionFailedError(key);
      throw err;
    }
  }

  async list(prefix: string, startAfter?: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.k(prefix),
          StartAfter: startAfter ? this.k(startAfter) : undefined,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        out.push({ key: obj.Key!.slice(this.prefix.length), lastModified: obj.LastModified });
      }
      token = res.NextContinuationToken;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
  }
}
