import { AwsClient } from "aws4fetch";
import {
  CONNACK_ACCEPTED,
  MqttParser,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePublish,
  encodeSubscribe,
} from "./mqtt";

/** Change notification over AWS IoT Core (§4.14, `Change Notification Design.md`).
 *
 * Every writer already knows the revision it just appended, so nothing has to watch S3: after a
 * successful CAS append the writer publishes `{rev, by}` to one topic, and subscribers run the
 * SAME `listDeltasSince` cycle a poll would have run.
 *
 * The contract that makes this safe to bolt onto a sync protocol with a history of correctness
 * bugs: **a notification is a hint, never a source of truth.** It carries no content, establishes
 * no state, and changes no schema. Every failure path here degrades to "the poll gets it" — which
 * is why nothing in this file is allowed to throw into a sync cycle.
 */

/** MQTT keepalive. IoT bills connection-minutes, not pings, so a short keepalive is nearly free —
 * and it is what detects a half-open socket after a laptop sleeps or a phone changes network. */
const KEEPALIVE_SEC = 60;
/** Ping at half the keepalive so a single lost PINGRESP doesn't trip the broker's own timeout. */
const PING_INTERVAL_MS = (KEEPALIVE_SEC / 2) * 1000;
/** No traffic at all for this long (1.5× keepalive) means the socket is dead even though the OS
 * hasn't told us — reconnect rather than sit on a connection nothing arrives through. */
const SILENCE_TIMEOUT_MS = KEEPALIVE_SEC * 1500;
/** Reconnect backoff. Caps at a minute: past that the poll is carrying the load anyway. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
/** Presigned-URL lifetime. The URL only has to survive the handshake — an established SigV4
 * connection lives up to 24 h regardless. */
const PRESIGN_EXPIRES_SEC = 300;
/** How long to wait for CONNACK/SUBACK before treating the attempt as failed. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface NotifierConfig {
  /** IoT ATS data endpoint host, e.g. `a1b2c3d4e5.iot.eu-central-1.amazonaws.com`. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** This device's writer id — the MQTT client id AND the `by` we publish and echo-suppress on. */
  deviceId: string;
  /** Vault topic; derived from the S3 prefix so several vaults can share an account. */
  topic: string;
}

export interface NotifierHooks {
  /** A peer announced `rev`. Already echo-suppressed: never called for our own `by`. */
  onRev: (rev: number, by: string) => void;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

/** Injected in tests; production uses the global WebSocket (Electron and the mobile WebView both
 * have it, and WS needs no CORS preflight — unlike every S3 request this plugin makes). */
export type SocketFactory = (url: string, protocol: string) => WebSocketLike;

export interface WebSocketLike {
  binaryType: string;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

type State = "idle" | "connecting" | "ready" | "closed";

export class ChangeNotifier {
  private ws: WebSocketLike | null = null;
  private parser = new MqttParser();
  private state: State = "idle";
  private attempt = 0;
  private packetId = 1;
  /** Global (not `window.`) timers so this module runs under the Node test environment as well as
   * the Electron/mobile WebView. Timeouts and intervals are tracked apart so each is cleared with
   * its own function rather than relying on the two being interchangeable. */
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  private intervals: ReturnType<typeof setInterval>[] = [];
  private lastInboundAt = 0;
  /** Bumped on every (re)connect; a callback from a superseded socket checks it and unwinds. Same
   * fencing idea as the engine's cycle tokens — an orphaned socket must never mutate live state. */
  private generation = 0;

  constructor(
    private cfg: NotifierConfig,
    private hooks: NotifierHooks,
    private socketFactory: SocketFactory = (url, protocol) =>
      new WebSocket(url, protocol) as unknown as WebSocketLike,
  ) {}

  connected(): boolean {
    return this.state === "ready";
  }

  /** Idempotent: calling it while connecting or connected is a no-op. */
  start(): void {
    if (this.state === "connecting" || this.state === "ready") return;
    this.state = "idle";
    void this.connect();
  }

  /** Tear down and stop reconnecting. Safe to call from unload or a visibility change. */
  stop(): void {
    this.state = "closed";
    this.generation++;
    this.clearTimers();
    this.sendRaw(encodeDisconnect()); // best-effort courtesy; the close below is what matters
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  /** Announce a revision this device just published. Best-effort by contract: a failure here must
   * never fail the sync cycle that produced the revision. */
  publish(rev: number, by: string): void {
    if (this.state !== "ready") return;
    const payload = new TextEncoder().encode(JSON.stringify({ rev, by }));
    try {
      this.sendRaw(encodePublish(this.cfg.topic, payload));
    } catch (err) {
      this.hooks.log("warn", `notify: publish rev ${rev} failed: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------- connection
  private async connect(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "connecting";
    const gen = ++this.generation;
    try {
      const url = await this.presign();
      if (gen !== this.generation) return; // superseded while signing
      const ws = this.socketFactory(url, "mqtt"); // AWS IoT requires the `mqtt` subprotocol
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.parser = new MqttParser();

      ws.onopen = () => {
        if (gen !== this.generation) return;
        this.lastInboundAt = Date.now();
        this.sendRaw(encodeConnect(this.cfg.deviceId, KEEPALIVE_SEC));
      };
      ws.onmessage = (ev) => {
        if (gen !== this.generation) return;
        this.onData(ev.data);
      };
      ws.onerror = (err) => {
        if (gen !== this.generation) return;
        this.hooks.log("warn", `notify: socket error: ${String(err)}`);
      };
      ws.onclose = () => {
        if (gen !== this.generation) return;
        this.retry("socket closed");
      };

      // A socket that opens but never completes the MQTT handshake would otherwise hang here
      // forever, looking connected while delivering nothing.
      this.after(HANDSHAKE_TIMEOUT_MS, () => {
        if (gen === this.generation && this.state !== "ready") this.retry("handshake timed out");
      });
    } catch (err) {
      this.retry(`connect failed: ${String(err)}`);
    }
  }

  /** SigV4-presigned WebSocket URL. Reuses the same credentials and signer as every S3 call — the
   * `iotdevicegateway` service name is what makes it an IoT connect rather than an S3 request. */
  private async presign(): Promise<string> {
    const aws = new AwsClient({
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      service: "iotdevicegateway",
    });
    const target = `https://${this.cfg.endpoint}/mqtt?X-Amz-Expires=${PRESIGN_EXPIRES_SEC}`;
    const signed = await aws.sign(target, { method: "GET", aws: { signQuery: true } });
    // The scheme is not part of the SigV4 canonical request, so swapping it after signing is safe.
    return signed.url.replace(/^https:/, "wss:");
  }

  private onData(data: unknown): void {
    this.lastInboundAt = Date.now();
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else return; // a text frame is not something this protocol produces

    let packets;
    try {
      packets = this.parser.push(bytes);
    } catch (err) {
      this.retry(`unparseable stream: ${String(err)}`); // desynchronised — restart clean
      return;
    }

    for (const pkt of packets) {
      switch (pkt.type) {
        case "connack":
          if (pkt.returnCode !== CONNACK_ACCEPTED) {
            // Non-zero is a credential/authorisation problem: retrying immediately would hammer.
            this.retry(`CONNACK refused (code ${pkt.returnCode})`);
            return;
          }
          this.sendRaw(encodeSubscribe(this.nextPacketId(), this.cfg.topic));
          break;
        case "suback":
          this.onReady(pkt.granted);
          break;
        case "publish":
          this.onPublish(pkt.payload);
          break;
        default:
          break; // pingresp / unknown: the inbound timestamp above is all we needed
      }
    }
  }

  private onReady(granted: number[]): void {
    // 0x80 is the spec's "subscription refused" — being connected but unsubscribed would look
    // healthy while silently delivering nothing.
    if (granted.some((g) => g >= 0x80)) {
      this.retry("subscription refused");
      return;
    }
    this.state = "ready";
    this.attempt = 0;
    this.hooks.log("info", `notify: subscribed to ${this.cfg.topic} as ${this.cfg.deviceId}`);
    this.clearTimers();
    this.every(PING_INTERVAL_MS, () => {
      if (Date.now() - this.lastInboundAt > SILENCE_TIMEOUT_MS) {
        this.retry("no traffic — socket looks half-open");
        return;
      }
      this.sendRaw(encodePingreq());
    });
  }

  private onPublish(payload: Uint8Array): void {
    let msg: { rev?: unknown; by?: unknown };
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return; // not ours to interpret; ignoring is strictly safer than guessing
    }
    const rev = typeof msg.rev === "number" ? msg.rev : NaN;
    const by = typeof msg.by === "string" ? msg.by : "";
    if (!Number.isFinite(rev)) return;
    // Echo suppression, same basis as the journal's `Delta.by`: our own announcement tells us
    // nothing we don't already know, and reacting to it would loop.
    if (by === this.cfg.deviceId) return;
    this.hooks.onRev(rev, by);
  }

  // ------------------------------------------------------------- plumbing
  private sendRaw(bytes: Uint8Array): void {
    try {
      this.ws?.send(bytes);
    } catch (err) {
      this.hooks.log("warn", `notify: send failed: ${String(err)}`);
    }
  }

  private nextPacketId(): number {
    this.packetId = (this.packetId % 0xffff) + 1;
    return this.packetId;
  }

  /** Close the current socket and schedule another attempt. Fences the old generation first so a
   * late callback from the dying socket can't reconnect a second time in parallel. */
  private retry(reason: string): void {
    if (this.state === "closed") return;
    this.generation++;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.state = "idle";
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.attempt++;
    // Only the first failure and then every 5th are worth a line: a device that is simply offline
    // would otherwise fill the log with the same message forever.
    if (this.attempt === 1 || this.attempt % 5 === 0) {
      this.hooks.log("warn", `notify: ${reason} — reconnecting in ${delay / 1000}s (polling continues)`);
    }
    this.after(delay, () => void this.connect());
  }

  private after(ms: number, fn: () => void): void {
    this.timeouts.push(setTimeout(fn, ms));
  }

  private every(ms: number, fn: () => void): void {
    this.intervals.push(setInterval(fn, ms));
  }

  private clearTimers(): void {
    for (const t of this.timeouts) clearTimeout(t);
    for (const i of this.intervals) clearInterval(i);
    this.timeouts = [];
    this.intervals = [];
  }
}

/** Topic for a vault. Derived from the S3 prefix so vaults sharing one AWS account never cross
 * streams; sanitised because MQTT topic levels can't contain `#`, `+` or empty segments. */
export function revTopic(prefix: string): string {
  const slug = prefix.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
  return `vaultsync/${slug}/rev`;
}
