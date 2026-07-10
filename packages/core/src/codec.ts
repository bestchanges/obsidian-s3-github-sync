import { gzip, ungzip } from "pako";

/** gzip(JSON) — the wire format for snapshot + deltas (§1.1) */
export function encodeJsonGz(value: unknown): Uint8Array {
  return gzip(JSON.stringify(value));
}

export function decodeJsonGz<T>(data: Uint8Array): T {
  return JSON.parse(ungzip(data, { to: "string" })) as T;
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeText(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}
