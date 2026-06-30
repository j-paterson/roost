// packages/core/src/probes/instagram-probe.js
/**
 * Instagram ACTIVE probe (Phase 2). Unlike instagram-discovery.js (passive
 * observer), this exposes page-context helpers the TS sync orchestrator drives:
 *   - window.__roostIgFetch(path)            authenticated same-origin GET
 *   - window.__roostIgFetchMediaBase64(url)  CDN media → data URL
 * It also passively harvests the SPA's outgoing x-asbd-id and the server's
 * x-ig-www-claim so __roostIgFetch can resend live values (both rotate).
 */
(function () {
  if (window.__roostIgProbeInstalled) return;
  window.__roostIgProbeInstalled = true;

  var IG_APP_ID = "936619743392459"; // web app constant (confirmed live)
  if (typeof window.__ig_www_claim === "undefined") window.__ig_www_claim = "0";

  // ── passive harvest of x-asbd-id from the SPA's own fetch traffic ──
  var nativeFetch = window.fetch;
  function harvest(init) {
    try {
      var h = (init && init.headers) || {};
      var get = function (k) {
        if (h.get) return h.get(k);
        return h[k] || h[k.toLowerCase()];
      };
      var asbd = get("x-asbd-id") || get("X-ASBD-ID");
      if (asbd) window.__ig_asbd_id = String(asbd);
    } catch (e) {}
  }
  try {
    window.fetch = function (input, init) {
      harvest(init);
      return nativeFetch.apply(this, arguments);
    };
  } catch (e) {}

  function csrf() {
    var m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : "";
  }

  window.__roostIgFetch = function (pathUrl) {
    return (async function () {
      try {
        var headers = {
          "X-IG-App-ID": IG_APP_ID,
          "X-CSRFToken": csrf(),
          "X-Requested-With": "XMLHttpRequest",
          "X-IG-WWW-Claim": window.__ig_www_claim || "0",
        };
        if (window.__ig_asbd_id) headers["X-ASBD-ID"] = window.__ig_asbd_id;
        var r = await nativeFetch(pathUrl, { method: "GET", credentials: "include", headers: headers });
        var claim = r.headers.get("x-ig-set-www-claim") || r.headers.get("x-ig-www-claim") || null;
        if (claim) { try { window.__ig_www_claim = claim; } catch (e) {} }
        var body = await r.text();
        // Large cap so the JSON stays complete + parseable.
        return JSON.stringify({ status: r.status, claim: claim, body: body.slice(0, 600000) });
      } catch (e) {
        return JSON.stringify({ status: -1, error: String(e) });
      }
    })();
  };

  window.__roostIgFetchMediaBase64 = function (url) {
    return (async function () {
      try {
        var res = await nativeFetch(url, { credentials: "include" });
        var blob = await res.blob();
        return await new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(reader.result); };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (e) { return null; }
    })();
  };
})();
