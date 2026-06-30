/**
 * Instagram API discovery probe (spike). Observes — does NOT make its own calls.
 * Wraps fetch + XHR and records instagram API requests/responses into
 * window.__INSTAGRAM_DISCOVERY__ for export. Mirrors twitter-probe.js.
 */
(function () {
  var store = window.__INSTAGRAM_DISCOVERY__ = window.__INSTAGRAM_DISCOVERY__ || {
    installed: false, observedCalls: [], fetchCalls: 0, xhrCalls: 0, startedAt: new Date().toISOString(),
  };
  if (store.installed) return;
  store.installed = true;

  var CAP = 200;
  function isApi(url) {
    try { return url.indexOf("instagram.com") !== -1 && (url.indexOf("/api/") !== -1 || url.indexOf("/graphql") !== -1); }
    catch (e) { return false; }
  }
  function record(call) {
    try { store.observedCalls.push(call); if (store.observedCalls.length > CAP) store.observedCalls.shift(); }
    catch (e) {}
  }
  function pickHeaders(h) {
    var out = {};
    try {
      var want = ["x-ig-app-id", "x-csrftoken", "x-asbd-id", "x-ig-www-claim", "x-requested-with", "content-type", "referer"];
      for (var i = 0; i < want.length; i++) { var v = h && h[want[i]]; if (v) out[want[i]] = String(v); }
    } catch (e) {}
    return out;
  }

  // ── fetch ──
  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    store.fetchCalls++;
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = (init && init.method) || (input && input.method) || "GET";
    var headers = {};
    try {
      var hh = (init && init.headers) || {};
      if (hh.forEach) { hh.forEach(function (v, k) { headers[k.toLowerCase()] = v; }); }
      else { for (var k in hh) { headers[k.toLowerCase()] = hh[k]; } }
    } catch (e) {}
    var p = nativeFetch.apply(this, arguments);
    if (isApi(url)) {
      p.then(function (resp) {
        // Record immediately so the entry is visible to callers that await fetch.
        var entry = {
          url: url,
          method: method,
          reqHeaders: pickHeaders(headers),
          reqBody: init && init.body ? String(init.body).slice(0, 1000) : undefined,
          status: resp.status,
          respSample: undefined,
          at: Date.now(),
        };
        record(entry);
        // Fill respSample asynchronously — entry is already in observedCalls.
        try {
          var clone = resp.clone();
          clone.text().then(function (t) { entry.respSample = t.slice(0, 4000); }).catch(function () {});
        } catch (e) {}
      }).catch(function () {});
    }
    return p;
  };

  // ── XHR ──
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  var setH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ig = { method: method, url: url, headers: {} };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__ig) this.__ig.headers[String(k).toLowerCase()] = v; } catch (e) {}
    return setH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    store.xhrCalls++;
    var self = this, meta = this.__ig;
    if (meta && isApi(meta.url)) {
      this.addEventListener("load", function () {
        try {
          var sample;
          try { sample = String(self.responseText || "").slice(0, 4000); } catch (e) { sample = undefined; }
          record({
            url: meta.url,
            method: meta.method,
            reqHeaders: pickHeaders(meta.headers),
            reqBody: body ? String(body).slice(0, 1000) : undefined,
            status: self.status,
            respSample: sample,
            at: Date.now(),
          });
        } catch (e) {} // never let recording break the host page
      });
    }
    return send.apply(this, arguments);
  };
})();
