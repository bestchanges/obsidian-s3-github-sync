/** Minimal MQTT 3.1.1 codec — only what change notification needs (§4.14).
 *
 * Deliberately hand-rolled rather than taking `mqtt.js` (~150 KB) into a bundle that ships to
 * phones: we speak exactly five packet types at QoS 0, which is a few hundred bytes of encoding.
 * Same trade-off as the hand-parsed `ListObjectsV2` XML in `s3-fetch-adapter.ts`.
 *
 * QoS 0 only, and that is load-bearing: there are no PUBACK/PUBREC flows, no message ids to track on
 * publish, no inflight window, no redelivery. A notification that is lost is *supposed* to be lost —
 * the poll is the safety net (see `Change Notification Design.md`).
 *
 * Everything here is pure (`Uint8Array` in, packets out) so it is unit-testable without a socket.
 */

// ---------------------------------------------------------------- packet types
const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;
const DISCONNECT = 14;

export type MqttPacket =
  | { type: "connack"; sessionPresent: boolean; returnCode: number }
  | { type: "suback"; packetId: number; granted: number[] }
  | { type: "publish"; topic: string; payload: Uint8Array }
  | { type: "pingresp" }
  | { type: "other"; packetType: number };

/** CONNACK return codes worth naming; anything non-zero is fatal for the attempt. */
export const CONNACK_ACCEPTED = 0;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** MQTT string: 2-byte big-endian length, then UTF-8 bytes. */
function encodeString(s: string): number[] {
  const bytes = textEncoder.encode(s);
  if (bytes.length > 0xffff) throw new Error(`MQTT string too long: ${bytes.length} bytes`);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

/** Remaining Length: 7 bits per byte, high bit = "more follows", max 4 bytes (268 MB). */
export function encodeRemainingLength(n: number): number[] {
  if (n < 0 || n > 268_435_455) throw new Error(`MQTT remaining length out of range: ${n}`);
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function packet(typeAndFlags: number, rest: number[]): Uint8Array {
  return new Uint8Array([typeAndFlags, ...encodeRemainingLength(rest.length), ...rest]);
}

// ---------------------------------------------------------------- encoders
/** CONNECT with clean session, no will, no credentials — auth is in the presigned URL, not here. */
export function encodeConnect(clientId: string, keepaliveSec: number): Uint8Array {
  return packet(CONNECT << 4, [
    ...encodeString("MQTT"),
    0x04, // protocol level 4 = MQTT 3.1.1
    0x02, // connect flags: clean session
    (keepaliveSec >> 8) & 0xff,
    keepaliveSec & 0xff,
    ...encodeString(clientId),
  ]);
}

/** SUBSCRIBE at QoS 0. The 0x02 in the fixed header is reserved-but-required by the spec. */
export function encodeSubscribe(packetId: number, topic: string): Uint8Array {
  return packet((SUBSCRIBE << 4) | 0x02, [
    (packetId >> 8) & 0xff,
    packetId & 0xff,
    ...encodeString(topic),
    0x00, // requested QoS
  ]);
}

/** PUBLISH at QoS 0 — no packet id (the spec omits it below QoS 1), no dup, no retain.
 * Retain is deliberately off: a retained rev would hand every reconnecting client a stale
 * notification to react to, which is noise rather than safety. */
export function encodePublish(topic: string, payload: Uint8Array): Uint8Array {
  return packet(PUBLISH << 4, [...encodeString(topic), ...payload]);
}

export function encodePingreq(): Uint8Array {
  return new Uint8Array([PINGREQ << 4, 0]);
}

export function encodeDisconnect(): Uint8Array {
  return new Uint8Array([DISCONNECT << 4, 0]);
}

// ---------------------------------------------------------------- decoder
/** Incremental decoder. A WebSocket message boundary is not a packet boundary — a frame may carry
 * half a packet or three of them — so bytes are buffered until a whole packet is present. */
export class MqttParser {
  private buf = new Uint8Array(0);

  /** Feed received bytes; returns every complete packet they finished. */
  push(chunk: Uint8Array): MqttPacket[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: MqttPacket[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const header = this.readRemainingLength(1);
      if (!header) break; // length varint itself is incomplete
      const { value: remaining, next } = header;
      if (this.buf.length < next + remaining) break; // body still in flight
      const typeAndFlags = this.buf[0];
      const body = this.buf.subarray(next, next + remaining);
      out.push(decodeBody(typeAndFlags, body));
      this.buf = this.buf.subarray(next + remaining);
    }
    return out;
  }

  /** Returns null when the varint is not fully buffered yet. Throws only on a malformed one
   * (5th continuation byte), which means the stream is desynchronised beyond recovery. */
  private readRemainingLength(offset: number): { value: number; next: number } | null {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 4; i++) {
      const at = offset + i;
      if (at >= this.buf.length) return null;
      const byte = this.buf[at];
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return { value, next: at + 1 };
      multiplier *= 128;
    }
    throw new Error("malformed MQTT remaining length");
  }
}

function decodeBody(typeAndFlags: number, body: Uint8Array): MqttPacket {
  const type = typeAndFlags >> 4;
  switch (type) {
    case CONNACK:
      return {
        type: "connack",
        sessionPresent: (body[0] & 0x01) === 1,
        returnCode: body[1] ?? 0xff,
      };
    case SUBACK:
      return {
        type: "suback",
        packetId: (body[0] << 8) | body[1],
        granted: Array.from(body.subarray(2)),
      };
    case PUBLISH: {
      const topicLen = (body[0] << 8) | body[1];
      const topic = textDecoder.decode(body.subarray(2, 2 + topicLen));
      // QoS 0 has no packet identifier, so the payload starts right after the topic.
      return { type: "publish", topic, payload: body.subarray(2 + topicLen) };
    }
    case PINGRESP:
      return { type: "pingresp" };
    default:
      return { type: "other", packetType: type };
  }
}
