import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeNotifier, type WebSocketLike, revTopic } from "../src/notify";
import { MqttParser, encodePublish, encodeRemainingLength } from "../src/mqtt";

/** A scriptable stand-in for the browser WebSocket: records what the notifier sent (decoded as
 * MQTT) and lets a test push broker frames back. */
class FakeSocket implements WebSocketLike {
  binaryType = "";
  sent: Uint8Array[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  send(data: ArrayBufferView | ArrayBuffer): void {
    if (this.closed) throw new Error("send after close");
    const view = data as ArrayBufferView;
    this.sent.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice());
  }
  close(): void {
    this.closed = true;
  }

  /** Everything the client sent, decoded — so assertions read as protocol, not bytes. */
  packets() {
    const parser = new MqttParser();
    const out = [];
    for (const frame of this.sent) out.push(...parser.push(frame));
    return out;
  }
  /** Packet type numbers the client sent, in order (parser only decodes server->client shapes). */
  sentTypes(): number[] {
    return this.sent.map((f) => f[0] >> 4);
  }
  receive(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  }
}

function broker(typeAndFlags: number, body: number[]): Uint8Array {
  return new Uint8Array([typeAndFlags, ...encodeRemainingLength(body.length), ...body]);
}
const CONNACK_OK = () => broker(0x20, [0x00, 0x00]);
const SUBACK_OK = (packetId = 1) => broker(0x90, [packetId >> 8, packetId & 0xff, 0x00]);

const CFG = {
  endpoint: "abc123.iot.eu-central-1.amazonaws.com",
  region: "eu-central-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  deviceId: "macmini-8f3a",
  topic: "vaultsync/test/rev",
};

function makeNotifier() {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const revs: Array<{ rev: number; by: string }> = [];
  const logs: string[] = [];
  const notifier = new ChangeNotifier(
    CFG,
    {
      onRev: (rev, by) => revs.push({ rev, by }),
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    },
    (url) => {
      urls.push(url);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  );
  return { notifier, sockets, urls, revs, logs };
}

/** Drive a socket through open -> CONNACK -> SUBACK, the happy path. */
async function handshake(sock: FakeSocket): Promise<void> {
  sock.onopen?.();
  sock.receive(CONNACK_OK());
  await Promise.resolve();
  sock.receive(SUBACK_OK());
}

describe("revTopic", () => {
  it("derives a distinct topic per vault prefix", () => {
    expect(revTopic("vaults3sync/")).toBe("vaultsync/vaults3sync/rev");
    expect(revTopic("egorka/vaults/gsd2/")).toBe("vaultsync/egorka-vaults-gsd2/rev");
  });

  it("never produces wildcards or empty levels from an odd prefix", () => {
    expect(revTopic("")).toBe("vaultsync/default/rev");
    expect(revTopic("a/#/+")).toBe("vaultsync/a/rev");
  });
});

describe("ChangeNotifier", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("presigns a wss URL for the IoT endpoint with SigV4 query auth", async () => {
    const { notifier, urls } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    const url = new URL(urls[0]);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe(CFG.endpoint);
    expect(url.pathname).toBe("/mqtt");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // service must be iotdevicegateway, or IoT rejects the handshake
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/iotdevicegateway/");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  });

  it("connects, subscribes, and only reports ready after SUBACK", async () => {
    const { notifier, sockets } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const sock = sockets[0];

    sock.onopen?.();
    expect(sock.sentTypes()).toEqual([1]); // CONNECT
    expect(notifier.connected()).toBe(false);

    sock.receive(CONNACK_OK());
    await Promise.resolve();
    expect(sock.sentTypes()).toEqual([1, 8]); // + SUBSCRIBE
    expect(notifier.connected()).toBe(false); // not until the broker grants it

    sock.receive(SUBACK_OK());
    expect(notifier.connected()).toBe(true);
  });

  it("delivers a peer's rev to onRev", async () => {
    const { notifier, sockets, revs } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await handshake(sockets[0]);

    sockets[0].receive(
      encodePublish(CFG.topic, new TextEncoder().encode('{"rev":4213,"by":"iphone-2b7c"}')),
    );
    expect(revs).toEqual([{ rev: 4213, by: "iphone-2b7c" }]);
  });

  it("echo-suppresses this device's own announcement", async () => {
    const { notifier, sockets, revs } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await handshake(sockets[0]);

    sockets[0].receive(
      encodePublish(CFG.topic, new TextEncoder().encode(`{"rev":9,"by":"${CFG.deviceId}"}`)),
    );
    expect(revs).toEqual([]);
  });

  it("ignores malformed payloads instead of throwing into the socket handler", async () => {
    const { notifier, sockets, revs } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await handshake(sockets[0]);

    const enc = new TextEncoder();
    sockets[0].receive(encodePublish(CFG.topic, enc.encode("not json")));
    sockets[0].receive(encodePublish(CFG.topic, enc.encode('{"by":"x"}'))); // no rev
    sockets[0].receive(encodePublish(CFG.topic, enc.encode('{"rev":"soon","by":"x"}'))); // wrong type
    expect(revs).toEqual([]);
    expect(notifier.connected()).toBe(true); // still healthy
  });

  it("publishes {rev, by} once ready, and silently no-ops before that", async () => {
    const { notifier, sockets } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const sock = sockets[0];

    notifier.publish(7, CFG.deviceId); // not ready yet
    expect(sock.sent).toHaveLength(0);

    await handshake(sock);
    notifier.publish(4213, CFG.deviceId);
    const pub = sock.packets().find((p) => p.type === "publish");
    expect(pub).toBeTruthy();
    if (pub?.type !== "publish") throw new Error("expected publish");
    expect(pub.topic).toBe(CFG.topic);
    expect(JSON.parse(new TextDecoder().decode(pub.payload))).toEqual({
      rev: 4213,
      by: CFG.deviceId,
    });
  });

  it("reconnects with backoff after the socket closes", async () => {
    const { notifier, sockets } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await handshake(sockets[0]);

    sockets[0].onclose?.();
    expect(notifier.connected()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000); // first backoff step
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await handshake(sockets[1]);
    expect(notifier.connected()).toBe(true);
  });

  it("gives up on a refused CONNACK and retries rather than looking connected", async () => {
    const { notifier, sockets, logs } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onopen?.();
    sockets[0].receive(broker(0x20, [0x00, 0x05])); // 5 = not authorized

    expect(notifier.connected()).toBe(false);
    expect(logs.join()).toMatch(/CONNACK refused \(code 5\)/);
    expect(sockets[0].closed).toBe(true);
  });

  it("treats a refused subscription as a failure — connected but deaf is worse than down", async () => {
    const { notifier, sockets, logs } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onopen?.();
    sockets[0].receive(CONNACK_OK());
    await Promise.resolve();
    sockets[0].receive(broker(0x90, [0x00, 0x01, 0x80])); // 0x80 = failure

    expect(notifier.connected()).toBe(false);
    expect(logs.join()).toMatch(/subscription refused/);
  });

  it("reconnects when a socket opens but never completes the handshake", async () => {
    const { notifier, sockets, logs } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onopen?.(); // CONNECT sent, broker never answers

    await vi.advanceTimersByTimeAsync(15_000);
    expect(logs.join()).toMatch(/handshake timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
  });

  it("pings on the keepalive, and reconnects when nothing comes back", async () => {
    const { notifier, sockets, logs } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await handshake(sockets[0]);
    const before = sockets[0].sentTypes().length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0].sentTypes().slice(before)).toEqual([12]); // PINGREQ

    // Broker goes silent past 1.5x keepalive -> the socket is half-open.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(logs.join()).toMatch(/half-open/);
    expect(notifier.connected()).toBe(false);
  });

  it("stops cleanly and does not reconnect afterwards", async () => {
    const { notifier, sockets } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await handshake(sockets[0]);

    notifier.stop();
    expect(notifier.connected()).toBe(false);
    expect(sockets[0].closed).toBe(true);

    sockets[0].onclose?.(); // the close event still fires; it must not restart anything
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it("ignores callbacks from a superseded socket", async () => {
    const { notifier, sockets, revs } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await handshake(sockets[0]);

    sockets[0].onclose?.(); // fences generation 1
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    // The dead socket delivers a late frame: it must not reach onRev.
    sockets[0].receive(
      encodePublish(CFG.topic, new TextEncoder().encode('{"rev":1,"by":"ghost"}')),
    );
    expect(revs).toEqual([]);
  });

  it("start() is idempotent while a connection is live", async () => {
    const { notifier, sockets } = makeNotifier();
    notifier.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await handshake(sockets[0]);

    notifier.start();
    notifier.start();
    expect(sockets).toHaveLength(1);
  });
});
