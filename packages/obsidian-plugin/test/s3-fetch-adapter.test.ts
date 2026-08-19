import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3FetchAdapter } from "../src/s3-fetch-adapter";

// list() parses the LIST response with DOMParser, which the node test environment lacks. The retry
// tests only care about how many attempts were made, so an empty-document stub is enough.
class FakeDOMParser {
  parseFromString(): unknown {
    return { getElementsByTagName: () => [] };
  }
}

function makeAdapter(): S3FetchAdapter {
  return new S3FetchAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    region: "ap-southeast-1",
    bucket: "test-bucket",
    prefix: "vault/",
  });
}

/** Queue one outcome per attempt: a Response to return, or an Error to reject with. */
function stubFetch(outcomes: (Response | Error)[]): { calls: Request[] } {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (req: Request) => {
    calls.push(req);
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (next instanceof Error) throw next;
    return next.clone();
  });
  return { calls };
}

const ok = (body = "") => new Response(body, { status: 200 });
const status = (code: number) => new Response("", { status: code });
/** What fetch rejects with when the request never leaves the device (the post-resume failure). */
const networkFailure = () => new TypeError("Failed to fetch");

describe("S3FetchAdapter transient-failure handling", () => {
  beforeEach(() => {
    vi.stubGlobal("DOMParser", FakeDOMParser);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a LIST that failed at the network layer, and succeeds on the retry", async () => {
    const { calls } = stubFetch([networkFailure(), ok("<ListBucketResult/>")]);
    await expect(makeAdapter().list("deltas/")).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("retries a GET twice before giving up, then surfaces the original error", async () => {
    const { calls } = stubFetch([networkFailure()]);
    await expect(makeAdapter().get("files/note.md")).rejects.toThrow("Failed to fetch");
    expect(calls).toHaveLength(3); // initial attempt + 2 retries
  });

  it("re-signs and retries a 403 — a stale/skewed clock after a resume recovers on its own", async () => {
    const { calls } = stubFetch([status(403), ok("body")]);
    const res = await makeAdapter().get("files/note.md");
    expect(res?.body).toBeDefined();
    expect(calls).toHaveLength(2);
    // Each attempt is signed afresh; a reused signature would defeat the point.
    const auth = calls.map((c) => c.headers.get("authorization"));
    expect(auth[0]).toBeTruthy();
    expect(auth[1]).toBeTruthy();
  });

  it("still reports a persistent 403 as a LIST failure once retries are spent", async () => {
    const { calls } = stubFetch([status(403)]);
    await expect(makeAdapter().list("deltas/")).rejects.toThrow("S3 LIST: 403");
    expect(calls).toHaveLength(3);
  });

  it("does NOT retry a write — a PUT that may have landed must never be re-issued", async () => {
    const { calls } = stubFetch([networkFailure()]);
    await expect(makeAdapter().put("deltas/1.json", new Uint8Array([1]))).rejects.toThrow(
      "Failed to fetch",
    );
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 404 or a 412 — those are answers, not failures", async () => {
    const missing = stubFetch([status(404)]);
    await expect(makeAdapter().get("files/gone.md")).resolves.toBeNull();
    expect(missing.calls).toHaveLength(1);

    vi.unstubAllGlobals();
    vi.stubGlobal("DOMParser", FakeDOMParser);
    const conflict = stubFetch([status(412)]);
    await expect(
      makeAdapter().put("deltas/1.json", new Uint8Array([1]), { ifNoneMatch: true }),
    ).rejects.toThrow(/precondition|deltas\/1\.json/i);
    expect(conflict.calls).toHaveLength(1);
  });

  it("bounds every request with an abort signal, so a suspended request can't hang forever", async () => {
    const { calls } = stubFetch([ok("body")]);
    await makeAdapter().get("files/note.md");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal.aborted).toBe(false);
  });

  it("gives up when the request is aborted (the timeout firing looks like this)", async () => {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", async (req: Request) => {
      calls.push(req);
      // Simulate the timeout tripping mid-flight: the same rejection Node/the WebView produces.
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(makeAdapter().get("files/note.md")).rejects.toThrow(/aborted/);
    expect(calls).toHaveLength(3); // an abort is treated as transient, so it retries too
  });

  /** Headers have arrived, so fetch() has already resolved — but the body never flows. This is the
   * stall a per-attempt deadline has to cover: it is indistinguishable from a healthy response until
   * you try to read the bytes, and reading them after the timer was cleared hangs with no error and
   * no connection break. On a real device that held the engine's single-flight lock for 18 hours. */
  function headersThenSilence(signal: AbortSignal): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () =>
          controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
        );
      },
    });
    return new Response(body, { status: 200 });
  }

  /** Real timers with a deliberately tiny deadline. Fake timers are not an option here: they stall
   * aws4fetch's async signing, so the request is never even issued and nothing is under test. */
  function stallingAdapter(): { adapter: S3FetchAdapter; calls: Request[] } {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", async (req: Request) => {
      calls.push(req);
      return headersThenSilence(req.signal);
    });
    return {
      adapter: new S3FetchAdapter({
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret",
        region: "ap-southeast-1",
        bucket: "test-bucket",
        prefix: "vault/",
        requestTimeoutMs: 40,
      }),
      calls,
    };
  }

  it("bounds a body that never flows — the deadline covers the bytes, not just the headers", async () => {
    const { adapter, calls } = stallingAdapter();
    // Before the fix this never settles: fetch() resolved on the headers, the deadline was cleared,
    // and the arrayBuffer() read waited on a stream nothing would ever feed or cancel.
    await expect(adapter.get("files/note.md")).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(3); // a stalled body is transient → the GET retries like any other
  });

  it("bounds a stalled LIST body too — a poll is LIST + GET, and LIST reads XML", async () => {
    const { adapter, calls } = stallingAdapter();
    await expect(adapter.list("deltas/")).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(3);
  });
});
