import SparkMD5 from "spark-md5";

/**
 * "md5:<hex>" of content. MD5 matches the S3 ETag for plain (non-multipart) PUTs,
 * so remote drift can be detected without downloads. spark-md5 is pure JS —
 * works in the Obsidian plugin (desktop + mobile) and Node identically.
 */
export function contentHash(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return `md5:${SparkMD5.ArrayBuffer.hash(buf)}`;
}
