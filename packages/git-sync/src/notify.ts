import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";

/** Server-side half of change notification (§4.14, `Change Notification Design.md`).
 *
 * The plugin holds an MQTT socket because it also *subscribes*; git-sync and the MCP server only
 * ever announce, and both are short-lived processes, so they publish over the IoT Data plane's
 * HTTPS endpoint instead. One signed request, no connection to keep alive, no MQTT client.
 *
 * Shared by git-sync and mcp-server (which already depends on this package) so both legs announce
 * identically — the same lockstep rule the exclusion rules and the merge follow (§6).
 */

/** Topic for a vault, derived from the S3 prefix. MUST match the plugin's `revTopic()` in
 * `packages/obsidian-plugin/src/notify.ts` — they are two implementations of one wire contract, so
 * a change to either is a change to both. */
export function revTopic(prefix: string): string {
  const slug = prefix.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
  return `vaultsync/${slug}/rev`;
}

export interface RevPublisher {
  publish(rev: number): Promise<void>;
}

/** No-op publisher: what you get when the feature isn't configured. Keeps every call site free of
 * `if (notifier)` — announcing is optional by design, so "off" must be a valid, silent mode. */
const NOOP: RevPublisher = { publish: async () => {} };

export interface RevPublisherOptions {
  /** IoT ATS data endpoint host. Empty/undefined disables announcements entirely. */
  endpoint?: string;
  region?: string;
  prefix: string;
  /** Writer id that goes in the payload — `"git-sync"` or `"mcp"`. */
  by: string;
  log?: (msg: string) => void;
}

/** Build a publisher, or a no-op when no endpoint is configured. */
export function createRevPublisher(opts: RevPublisherOptions): RevPublisher {
  const endpoint = opts.endpoint?.trim();
  if (!endpoint) return NOOP;
  const client = new IoTDataPlaneClient({
    region: opts.region,
    endpoint: endpoint.startsWith("http") ? endpoint : `https://${endpoint}`,
  });
  const topic = revTopic(opts.prefix);
  return {
    async publish(rev: number): Promise<void> {
      try {
        await client.send(
          new PublishCommand({
            topic,
            qos: 0, // fire-and-forget: the subscriber's poll is the safety net, not a redelivery queue
            payload: new TextEncoder().encode(JSON.stringify({ rev, by: opts.by })),
          }),
        );
        opts.log?.(`notify: announced rev ${rev} on ${topic}`);
      } catch (err) {
        // Never fatal. The delta is already durable; failing the run over an announcement would
        // turn a latency optimisation into an outage.
        opts.log?.(`notify: announce rev ${rev} failed (peers will poll): ${String(err)}`);
      }
    },
  };
}
