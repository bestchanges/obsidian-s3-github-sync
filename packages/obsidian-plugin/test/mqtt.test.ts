import { describe, expect, it } from "vitest";
import {
  MqttParser,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePublish,
  encodeRemainingLength,
  encodeSubscribe,
} from "../src/mqtt";

/** Helper: build a raw packet the way a broker would, so decode tests aren't just our own
 * encoder played back to us. */
function raw(typeAndFlags: number, body: number[]): Uint8Array {
  return new Uint8Array([typeAndFlags, ...encodeRemainingLength(body.length), ...body]);
}

describe("MQTT remaining-length varint", () => {
  it("encodes the spec's boundary values", () => {
    expect(encodeRemainingLength(0)).toEqual([0x00]);
    expect(encodeRemainingLength(127)).toEqual([0x7f]);
    expect(encodeRemainingLength(128)).toEqual([0x80, 0x01]);
    expect(encodeRemainingLength(16_383)).toEqual([0xff, 0x7f]);
    expect(encodeRemainingLength(16_384)).toEqual([0x80, 0x80, 0x01]);
    expect(encodeRemainingLength(268_435_455)).toEqual([0xff, 0xff, 0xff, 0x7f]);
  });

  it("refuses a length no MQTT packet can carry", () => {
    expect(() => encodeRemainingLength(268_435_456)).toThrow(/out of range/);
  });
});

describe("MQTT encoders", () => {
  it("encodes CONNECT byte-for-byte per MQTT 3.1.1", () => {
    const bytes = encodeConnect("dev1", 60);
    expect(Array.from(bytes)).toEqual([
      0x10, // CONNECT
      16, // remaining length: 10 (variable header) + 6 (client id)
      0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
      0x04, // protocol level 4
      0x02, // clean session
      0x00, 0x3c, // keepalive 60
      0x00, 0x04, 0x64, 0x65, 0x76, 0x31, // "dev1"
    ]);
  });

  it("encodes SUBSCRIBE with the reserved 0x02 header flags the spec requires", () => {
    const bytes = encodeSubscribe(1, "a/b");
    expect(bytes[0]).toBe(0x82);
    expect(Array.from(bytes.subarray(2))).toEqual([
      0x00, 0x01, // packet id
      0x00, 0x03, 0x61, 0x2f, 0x62, // "a/b"
      0x00, // requested QoS 0
    ]);
  });

  it("encodes PUBLISH at QoS 0 with no packet id, no retain, no dup", () => {
    const bytes = encodePublish("t", new Uint8Array([0xaa, 0xbb]));
    expect(bytes[0]).toBe(0x30); // QoS 0, retain off, dup off
    expect(Array.from(bytes.subarray(1))).toEqual([5, 0x00, 0x01, 0x74, 0xaa, 0xbb]);
  });

  it("encodes the two-byte fixed packets", () => {
    expect(Array.from(encodePingreq())).toEqual([0xc0, 0x00]);
    expect(Array.from(encodeDisconnect())).toEqual([0xe0, 0x00]);
  });

  it("encodes multi-byte lengths for a payload over 127 bytes", () => {
    const payload = new Uint8Array(200);
    const bytes = encodePublish("t", payload);
    // remaining = 2 (topic len) + 1 (topic) + 200 = 203 -> varint [0xcb, 0x01]
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0x30, 0xcb, 0x01]);
    expect(bytes.length).toBe(3 + 203);
  });
});

describe("MqttParser", () => {
  it("decodes CONNACK", () => {
    const [pkt] = new MqttParser().push(raw(0x20, [0x00, 0x00]));
    expect(pkt).toEqual({ type: "connack", sessionPresent: false, returnCode: 0 });
  });

  it("surfaces a refused CONNACK return code rather than swallowing it", () => {
    const [pkt] = new MqttParser().push(raw(0x20, [0x00, 0x05])); // 5 = not authorized
    expect(pkt).toMatchObject({ type: "connack", returnCode: 5 });
  });

  it("decodes SUBACK with its granted QoS list", () => {
    const [pkt] = new MqttParser().push(raw(0x90, [0x00, 0x07, 0x00]));
    expect(pkt).toEqual({ type: "suback", packetId: 7, granted: [0] });
  });

  it("decodes PUBLISH topic and payload", () => {
    const parser = new MqttParser();
    const [pkt] = parser.push(encodePublish("vault/rev", new TextEncoder().encode('{"rev":42}')));
    expect(pkt).toMatchObject({ type: "publish", topic: "vault/rev" });
    if (pkt.type !== "publish") throw new Error("expected publish");
    expect(new TextDecoder().decode(pkt.payload)).toBe('{"rev":42}');
  });

  it("decodes PINGRESP and reports unknown packet types without throwing", () => {
    const parser = new MqttParser();
    expect(parser.push(new Uint8Array([0xd0, 0x00]))).toEqual([{ type: "pingresp" }]);
    expect(parser.push(raw(0x40, [0x00, 0x01]))).toEqual([{ type: "other", packetType: 4 }]);
  });

  it("reassembles a packet split across WebSocket frames", () => {
    const parser = new MqttParser();
    const whole = encodePublish("t", new TextEncoder().encode("hello"));
    expect(parser.push(whole.subarray(0, 3))).toEqual([]); // header only
    expect(parser.push(whole.subarray(3, 5))).toEqual([]); // still short
    const out = parser.push(whole.subarray(5));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "publish", topic: "t" });
  });

  it("waits for an incomplete length varint instead of misreading it", () => {
    const parser = new MqttParser();
    const big = encodePublish("t", new Uint8Array(200));
    expect(parser.push(big.subarray(0, 2))).toEqual([]); // varint continues into byte 3
    expect(parser.push(big.subarray(2))).toHaveLength(1);
  });

  it("returns every packet a single frame carried, in order", () => {
    const parser = new MqttParser();
    const frame = new Uint8Array([
      ...encodePublish("a", new Uint8Array([1])),
      ...encodePingreq(), // a client packet, but shape-wise fine to decode
      ...encodePublish("b", new Uint8Array([2])),
    ]);
    const out = parser.push(frame);
    expect(out.map((p) => (p.type === "publish" ? p.topic : p.type))).toEqual(["a", "other", "b"]);
  });

  it("keeps leftover bytes buffered across pushes", () => {
    const parser = new MqttParser();
    const two = new Uint8Array([...encodePublish("a", new Uint8Array()), 0x30]); // + a stray header
    expect(parser.push(two)).toHaveLength(1);
    // the stray byte is retained, and completing it yields the second packet
    expect(parser.push(new Uint8Array([0x03, 0x00, 0x01, 0x62]))).toEqual([
      { type: "publish", topic: "b", payload: new Uint8Array() },
    ]);
  });

  it("throws on a malformed length varint — the stream is unrecoverable at that point", () => {
    const parser = new MqttParser();
    expect(() => parser.push(new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow(
      /malformed/,
    );
  });
});
