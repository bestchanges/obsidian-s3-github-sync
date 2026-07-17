import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGN_TTL_SECONDS, type ServerDeps } from "./mcp";
import { FILES_PREFIX } from "./vault";

/** Presigned GET for `files/<path>`, pinned to the journal-recorded object version when present. */
export function makePresigner(bucket: string, prefix: string, region?: string): ServerDeps["presignGet"] {
  const client = new S3Client(region ? { region } : {});
  return (path, versionId) =>
    getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: prefix + FILES_PREFIX + path, VersionId: versionId }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );
}
