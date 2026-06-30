/** Reddit ACTIVE probe. Exposes a same-origin authenticated GET helper the TS
 *  sync drives. Reddit's .json reads need only the session cookie (same-origin
 *  credentials:include) — no extra headers. */
(function () {
  if (window.__roostRedditProbeInstalled) return;
  window.__roostRedditProbeInstalled = true;
  var nativeFetch = window.fetch.bind(window);
  window.__roostRedditFetch = function (pathUrl) {
    return (async function () {
      try {
        var r = await nativeFetch(pathUrl, { method: "GET", credentials: "include", headers: { "Accept": "application/json" } });
        var body = await r.text();
        return JSON.stringify({ status: r.status, body: body });
      } catch (e) { return JSON.stringify({ status: -1, error: String(e) }); }
    })();
  };
})();
