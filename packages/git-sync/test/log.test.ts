import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log";

/** Capture console.log/warn/error into arrays for one logger call, then restore. */
function capture() {
  const out: string[] = [];
  const errs: string[] = [];
  const warns: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation((m?: unknown) => void warns.push(String(m)));
  vi.spyOn(console, "error").mockImplementation((m?: unknown) => void errs.push(String(m)));
  return { out, warns, errs };
}

afterEach(() => vi.restoreAllMocks());

describe("createLogger threshold", () => {
  it("drops debug at the default (info) level", () => {
    const { out } = capture();
    const log = createLogger({});
    log.debug("noise");
    log.info("kept");
    expect(out.some((l) => l.includes("noise"))).toBe(false);
    expect(out.some((l) => l.includes("kept"))).toBe(true);
  });

  it("emits debug when LOG_LEVEL=debug", () => {
    const { out } = capture();
    createLogger({ LOG_LEVEL: "debug" }).debug("shown");
    expect(out.some((l) => l.includes("shown"))).toBe(true);
  });

  it("suppresses info/warn below threshold when LOG_LEVEL=error", () => {
    const { out, warns, errs } = capture();
    const log = createLogger({ LOG_LEVEL: "error" });
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(out.some((l) => l.includes("i"))).toBe(false);
    expect(warns.length).toBe(0);
    expect(errs.some((l) => l.includes("e"))).toBe(true);
  });

  it("formats lines as [git-sync] LEVEL msg", () => {
    const { out } = capture();
    createLogger({}).info("hello");
    expect(out[0]).toBe("[git-sync] INFO  hello");
  });
});

describe("createLogger Actions integration", () => {
  it("emits ::warning:: / ::error:: annotations only under GITHUB_ACTIONS", () => {
    const { out, warns, errs } = capture();
    const log = createLogger({ GITHUB_ACTIONS: "true" });
    log.warn("w");
    log.error("e");
    expect(out).toContain("::warning::w");
    expect(out).toContain("::error::e");
    // and the plain leveled line still goes to warn/error streams
    expect(warns.some((l) => l.includes("w"))).toBe(true);
    expect(errs.some((l) => l.includes("e"))).toBe(true);
  });

  it("does NOT emit annotations or group markers outside Actions", () => {
    const { out } = capture();
    const log = createLogger({});
    log.warn("w");
    log.group("detail");
    log.endGroup();
    expect(out.some((l) => l.startsWith("::"))).toBe(false);
  });

  it("emits ::group:: / ::endgroup:: under Actions", () => {
    const { out } = capture();
    const log = createLogger({ GITHUB_ACTIONS: "true" });
    log.group("sync detail");
    log.endGroup();
    expect(out).toContain("::group::sync detail");
    expect(out).toContain("::endgroup::");
  });
});
