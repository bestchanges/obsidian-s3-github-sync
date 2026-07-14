import { describe, expect, it } from "vitest";
import { mobileModelFromUA } from "../src/device-id";

// Real-world Obsidian mobile / WebView User-Agents. The point of mobileModelFromUA is that the
// *stable* device-model token survives OS / WebView / app version bumps — the churn that used to
// mint phantom "new devices" and force a foreign-state resync (§4.2).
describe("mobileModelFromUA", () => {
  it("extracts the Android model, ignoring the OS and Chrome versions", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36";
    expect(mobileModelFromUA(ua)).toBe("SM-G991B");
  });

  it("is stable across OS + WebView version bumps (the phantom-device bug)", () => {
    const before =
      "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36";
    const after = // Android 13→14, Chrome 112→121: same physical phone
      "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36";
    expect(mobileModelFromUA(after)).toBe(mobileModelFromUA(before));
  });

  it("handles the WebView `; wv` variant", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; SM-G991B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.0.0 Mobile Safari/537.36";
    expect(mobileModelFromUA(ua)).toBe("SM-G991B");
  });

  it("handles a `Build/…` suffix on the model", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/SQ1D.220205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.0.0 Mobile Safari/537.36";
    expect(mobileModelFromUA(ua)).toBe("Pixel 6");
  });

  it("collapses iOS to the coarse family token (Apple hides the model)", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    const ipad =
      "Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    expect(mobileModelFromUA(iphone)).toBe("iPhone");
    expect(mobileModelFromUA(ipad)).toBe("iPad");
  });

  it("is stable across iOS version bumps", () => {
    const before = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15";
    const after = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15";
    expect(mobileModelFromUA(after)).toBe(mobileModelFromUA(before));
  });

  it("falls back to a platform token, then `device`, for unrecognized UAs", () => {
    expect(mobileModelFromUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Macintosh");
    expect(mobileModelFromUA("")).toBe("device");
  });
});
