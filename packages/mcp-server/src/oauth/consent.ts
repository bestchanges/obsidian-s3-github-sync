/**
 * The one page a human sees. It is the consent screen *and* the login: this deployment has exactly
 * one user — the vault's owner — so "who are you" collapses into "prove you hold the passphrase".
 *
 * Self-contained by necessity (a Lambda serving one HTML response has nowhere to host assets) and
 * by preference: a strict CSP with no external origins means nothing on this page can be influenced
 * by a third party, which matters because the client name and redirect URI shown here come from an
 * untrusted client.
 */

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

export function pageHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": CSP,
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 0; padding: 2.5rem 1.25rem; display: flex; justify-content: center;
         background: Canvas; color: CanvasText; }
  main { width: 100%; max-width: 30rem; }
  h1 { font-size: 1.3rem; margin: 0 0 1.25rem; }
  dl { margin: 0 0 1.5rem; padding: 1rem; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
       border-radius: 8px; display: grid; grid-template-columns: auto 1fr; gap: .4rem 1rem; }
  dt { font-weight: 600; opacity: .75; }
  dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  label { display: block; font-weight: 600; margin-bottom: .4rem; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem; font-size: 1rem;
    border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
    background: Canvas; color: CanvasText; }
  .row { display: flex; gap: .75rem; margin-top: 1.25rem; }
  button { flex: 1; padding: .7rem; font-size: 1rem; border-radius: 6px; border: 0; cursor: pointer; }
  button.approve { background: #2563eb; color: #fff; font-weight: 600; }
  button.deny { background: color-mix(in srgb, CanvasText 12%, transparent); color: CanvasText; }
  .err { margin: 0 0 1rem; padding: .7rem 1rem; border-radius: 6px; background: #b91c1c; color: #fff; }
  .warn { font-size: .85em; opacity: .8; margin-top: 1.25rem; }
`;

export interface ConsentView {
  vaultName: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  /** every /authorize parameter, replayed as hidden fields so the POST carries the same request */
  params: Record<string, string>;
  error?: string;
}

export function renderConsent(view: ConsentView): string {
  const host = (() => {
    try {
      return new URL(view.redirectUri).host || view.redirectUri;
    } catch {
      return view.redirectUri;
    }
  })();
  const hidden = Object.entries(view.params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n      ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to ${esc(view.vaultName)}</title>
<style>${STYLE}</style></head>
<body><main>
  <h1>Connect an app to your vault</h1>
  ${view.error ? `<p class="err">${esc(view.error)}</p>` : ""}
  <dl>
    <dt>Vault</dt><dd>${esc(view.vaultName)}</dd>
    <dt>App</dt><dd>${esc(view.clientName)}</dd>
    <dt>Sends you to</dt><dd>${esc(host)}</dd>
    <dt>Access</dt><dd>${esc(view.scope)}</dd>
  </dl>
  <form method="post">
      ${hidden}
    <label for="password">Vault passphrase</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <div class="row">
      <button class="approve" type="submit" name="action" value="approve">Approve</button>
      <button class="deny" type="submit" name="action" value="deny">Cancel</button>
    </div>
  </form>
  <p class="warn">Approving lets this app read and write everything in the vault until you revoke it.
  Only continue if you started this from the app named above.</p>
</main></body></html>`;
}

/** Terminal error page — used when there is no safe redirect URI to send the error back to. */
export function renderError(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${esc(title)}</h1><p class="err">${esc(detail)}</p>
<p class="warn">Nothing was authorized. Close this page and start again from the app.</p>
</main></body></html>`;
}
