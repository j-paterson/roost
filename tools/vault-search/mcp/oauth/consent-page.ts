export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ConsentPageOptions {
  clientName: string;
  hiddenParams: Record<string, string>;
  errorMessage: string | undefined;
}

export function renderConsentPage(opts: ConsentPageOptions): string {
  const hidden = Object.entries(opts.hiddenParams)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n        ");

  const errorBlock = opts.errorMessage
    ? `<p class="error">${escapeHtml(opts.errorMessage)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize — vault-search</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .client { font-weight: 600; }
    label { display: block; margin-top: 1.5rem; font-weight: 600; }
    input[type=password] { width: 100%; padding: 0.6rem; font-size: 1rem; border: 1px solid #999; border-radius: 6px; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.6rem 1rem; font-size: 1rem; background: #111; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
    .error { color: #b00; margin-top: 1rem; }
    .help { color: #666; font-size: 0.9rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Authorize <span class="client">${escapeHtml(opts.clientName)}</span></h1>
  <p>This client is requesting access to your Obsidian vault search. Approve by entering your <code>MCP_AUTH_TOKEN</code> below.</p>
  ${errorBlock}
  <form action="/authorize" method="post" autocomplete="off">
        ${hidden}
    <label for="bearer_token">Bearer token</label>
    <input id="bearer_token" name="bearer_token" type="password" autocomplete="off" required>
    <p class="help">Paste the value of <code>MCP_AUTH_TOKEN</code> from your server's <code>.env</code>.</p>
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
}
