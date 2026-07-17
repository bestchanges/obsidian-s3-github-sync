import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * One-shot server transport for stateless Streamable HTTP over Lambda (design §2, §3): each POST
 * carries exactly one JSON-RPC message and the invocation ends with the response, so there is no
 * stream to keep open — `handle()` delivers the message and resolves with the server's reply
 * (null for notifications → HTTP 202). No session, no SSE; a fresh server+transport pair per
 * invocation is the SDK's documented stateless pattern.
 */
export class SingleShotTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private resolveResponse?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Only a response (id, no method) completes the shot; stray server notifications are dropped —
    // there is no open stream to deliver them on.
    if ("id" in message && !("method" in message)) this.resolveResponse?.(message);
  }

  handle(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    const expectsResponse = "method" in message && "id" in message;
    if (!expectsResponse) {
      this.onmessage?.(message);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.resolveResponse = resolve;
      this.onmessage?.(message);
    });
  }
}
