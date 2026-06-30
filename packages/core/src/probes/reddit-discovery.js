/**
 * Reddit API discovery probe (passive observer — does NOT make its own calls).
 * Wraps fetch + XHR and records Reddit API requests/responses into
 * window.__REDDIT_DISCOVERY__ for export. Mirrors instagram-discovery.js.
 *
 * Used by the discovery-only Reddit descriptor (enabled:false) so a login
 * session can also surface the real saved-listing API shape for Phase-2.
 */
(function () {
  var store = (window.__REDDIT_DISCOVERY__ = window.__REDDIT_DISCOVERY__ || {
    installed: false, observedCalls: [], allUrls: [], fetchCalls: 0, xhrCalls: 0, startedAt: new Date().toISOString(),
  });
  if (store.installed) return;
  store.installed = true;

  var CAP = 200;
  var URL_CAP = 250;
  function isApi(url) {
    try {
      var u = String(url);
      // Same-origin reddit JSON/api/gateway/svc calls, or the oauth/gateway hosts.
      var isReddit = u.charAt(0) === "/" || u.indexOf("reddit.com") !== -1 || u.indexOf("redditmedia.com") !== -1;
      return isReddit && (u.indexOf("/api/") !== -1 || u.indexOf(".json") !== -1 || u.indexOf("/svc/") !== -1 || u.indexOf("/graphql") !== -1 || u.indexOf("/saved") !== -1);
    } catch (e) { return false; }
  }
  function note(via, method, url) {
    try {
      store.allUrls.push({ via: via, method: method || "GET", url: String(url).slice(0, 300), api: isApi(url) });
      if (store.allUrls.length > URL_CAP) store.allUrls.shift();
    } catch (e) {}
  }
  function record(call) {
    try { store.observedCalls.push(call); if (store.observedCalls.length > CAP) store.observedCalls.shift(); } catch (e) {}
  }
  function pickHeaders(h) {
    var out = {};
    try {
      var want = ["authorization", "x-reddit-loid", "x-reddit-session", "content-type", "referer"];
      for (var i = 0; i < want.length; i++) { var v = h && h[want[i]]; if (v) out[want[i]] = String(v); }
    } catch (e) {}
    return out;
  }

  var nativeFetch = window.fetch;
  function roostFetch(input, init) {
    store.fetchCalls++;
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = (init && init.method) || (input && input.method) || "GET";
    note("fetch", method, url);
    var headers = {};
    try {
      var hh = (init && init.headers) || {};
      if (hh.forEach) { hh.forEach(function (v, k) { headers[k.toLowerCase()] = v; }); }
      else { for (var k in hh) { headers[k.toLowerCase()] = hh[k]; } }
    } catch (e) {}
    var p = nativeFetch.apply(this, arguments);
    if (isApi(url)) {
      p.then(function (resp) {
        var entry = { url: url, method: method, reqHeaders: pickHeaders(headers), status: resp.status, respSample: undefined, at: Date.now() };
        record(entry);
        try { var clone = resp.clone(); clone.text().then(function (t) { entry.respSample = t.slice(0, 4000); }).catch(function () {}); } catch (e) {}
      }).catch(function () {});
    }
    return p;
  }
  try {
    Object.defineProperty(window, "fetch", { configurable: true, get: function () { return roostFetch; }, set: function () {} });
  } catch (e) { window.fetch = roostFetch; }

  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__r = { method: method, url: url }; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    store.xhrCalls++;
    var self = this, meta = this.__r;
    if (meta) note("xhr", meta.method, meta.url);
    if (meta && isApi(meta.url)) {
      this.addEventListener("load", function () {
        try {
          var sample; try { sample = String(self.responseText || "").slice(0, 4000); } catch (e) { sample = undefined; }
          record({ url: meta.url, method: meta.method, reqHeaders: {}, status: self.status, respSample: sample, at: Date.now() });
        } catch (e) {}
      });
    }
    return send.apply(this, arguments);
  };
})();
