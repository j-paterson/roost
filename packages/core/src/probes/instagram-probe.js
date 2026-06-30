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
        // Return the FULL body — do NOT truncate. Any byte cap mid-JSON breaks
        // JSON.parse on the caller side (a count=50 saved/posts page is ~600KB-1MB,
        // far past the old 600000 cap that silently corrupted it). count<=50 bounds
        // the size, and executeJavaScript handles ~1MB string returns fine.
        return JSON.stringify({ status: r.status, claim: claim, body: body });
      } catch (e) {
        return JSON.stringify({ status: -1, error: String(e) });
      }
    })();
  };

  window.__roostIgFetchMediaBase64 = function (url) {
    return (async function () {
      // IG media is on cross-origin CDNs (scontent.*.cdninstagram.com /
      // *.fbcdn.net). These URLs are signed/public and need NO cookies — and a
      // CREDENTIALED cross-origin fetch is CORS-blocked. Verified live against a
      // real account: credentials:"omit" succeeded for 67/67 assets;
      // credentials:"include" returned 0 bytes for every one. So use omit; keep
      // a no-cors last-ditch (opaque → usually unreadable, but free to try).
      async function attempt(init) {
        try {
          var res = await nativeFetch(url, init);
          var blob = await res.blob();
          if (!blob || blob.size === 0) return null; // opaque/blocked → no bytes
          var dataUrl = await new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(new Error("FileReader error")); };
            reader.readAsDataURL(blob);
          });
          return (typeof dataUrl === "string" && dataUrl.length > 100) ? dataUrl : null;
        } catch (e) { return null; }
      }
      return (await attempt({ credentials: "omit" }))
        || (await attempt({ mode: "no-cors", credentials: "omit" }));
    })();
  };
})();
