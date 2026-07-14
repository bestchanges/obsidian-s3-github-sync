// Pure device-identity helpers (no `obsidian`/platform imports, so they're unit-testable). The
// runtime pieces — localStorage anchor, Platform checks, hostname — live in main.ts (§4.2).

/** Best-effort phone model from a mobile User-Agent, with version numbers ignored so it stays
 * constant across OS/WebView/app updates (a fluctuating UA was minting phantom new devices — §4.2).
 * Android UAs carry the real model (e.g. `SM-G991B`); Apple hides it, so iOS collapses to
 * `iPhone`/`iPad`/`iPod`. Falls back to the desktop-ish platform token, then `device`. */
export function mobileModelFromUA(ua: string): string {
  // Android: "...(Linux; Android 13; SM-G991B Build/…)" or "…; SM-G991B)" or "…; SM-G991B; wv)".
  const android = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/i);
  if (android) {
    const model = android[1].trim();
    if (model && !/^Android$/i.test(model)) return model;
  }
  const apple = ua.match(/\b(iPhone|iPad|iPod)\b/i);
  if (apple) return apple[1];
  const generic = ua.match(/Macintosh|Windows|Linux/i);
  return generic ? generic[0] : "device";
}
