/*
 * mds.js: this desktop's MDS for the Dexicon page. THE ONLY FILE IN THIS FOLDER THAT IS NOT A VERBATIM COPY of
 * mds/dexicon (index.html, ui/, lib/, resting/ are pinned by scripts/dexicon-page.manifest.json). From DexiconPro's
 * renderer/dexicon/mds.js, as the public build.
 *
 * The page is the TAKER's engine: ui/app.js builds, signs and sends FAST takes, voids the ones never answered, places,
 * edits and cancels FAST orders. No other JavaScript implementation of that exists, so the page runs unchanged in a
 * hidden, sandboxed frame (dxroom://exchange/, opaque origin, no window.mcd) and the native Exchange screens
 * (renderer/dexicon-ui.js) drive it through the short list of actions at the bottom of this file. Only its market maker dialogs are ever seen.
 *
 *   MDS.cmd / MDS.sql / MDS.comms.solo  -> postMessage to the shell -> window.mcd.dxCommand (main/dexicon.js: the
 *                                          verb allow-list, the engine's own store, packets to the one service)
 *   XMLHttpRequest                      -> the same bridge ({ op: "net" }): only the engine's current relays, https.
 *                                          The frame itself has no network at all (CSP connect-src 'none').
 *   confirm / prompt                    -> a sandboxed frame has no dialogs. The native screen shows the review; the
 *                                          answer is armed for the one driven call and for nothing else. An on-chain
 *                                          trade goes out only when the page's own review text was shown and returned.
 *   the AtomiX doors                    -> not in this app (doors/ and lib/door.js are not served); their hooks are
 *                                          no-ops, so the page never starts a second settlement engine on the ETH key.
 */
(function () {
  "use strict";
  var seq = 0, waiting = {}, handler = null, lastBlock = 0, answer = null, asked = null;
  var $ = function (id) { return document.getElementById(id); };

  function call(name, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      waiting[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ dxRoom: 1, id: id, name: name, args: args }, "*");
    });
  }
  function fire(msg) { if (handler) { try { handler(msg); } catch (e) { if (window.console) console.error(e); } } }
  function comms(message) { fire({ event: "MDSCOMMS", data: { public: false, message: String(message) } }); }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var m = e.data || {};
    if (m.dxRoom !== 1) return;
    if (m.id && waiting[m.id]) {
      var w = waiting[m.id]; delete waiting[m.id];
      if (m.error != null) w.reject(new Error(m.error)); else w.resolve(m.value);
      return;
    }
    if (m.update && typeof m.update === "object" && m.update.dex != null) comms(m.update.dex);   // service -> page
    else if (m.drive && typeof m.drive === "object") drive(m.drive);
  });

  // an opaque-origin frame has no localStorage: an in-memory one keeps the page's preferences for the session
  try { window.localStorage.getItem("x"); } catch (e) {
    var mem = {};
    var store = { getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; }, setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; }, clear: function () { mem = {}; }, key: function (i) { return Object.keys(mem)[i] || null; }, get length() { return Object.keys(mem).length; } };
    try { Object.defineProperty(window, "localStorage", { value: store, configurable: true }); } catch (e2) { }
  }
  // the page copies identifiers with navigator.clipboard, which an opaque-origin frame may not use: the shell copies
  // the COMPLETE value instead
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: function (t) {
      return call("clip", { text: String(t) }).then(function (ok) { if (!ok) throw new Error("copy failed"); });
    } } });
  } catch (e) { }

  // The page's relay transport (lib/relay.js xhrTransport) and its DISCOVER, through the host's relay allow-list.
  function Xhr() { this.readyState = 0; this.status = 0; this.responseText = ""; this.timeout = 0; }
  Xhr.prototype.open = function (method, url) { this._m = String(method).toUpperCase(); this._u = String(url); this.readyState = 1; };
  Xhr.prototype.setRequestHeader = function () { };
  Xhr.prototype.send = function (body) {
    var x = this, done = function (status, text) { x.status = status; x.responseText = text || ""; x.readyState = 4; if (x.onreadystatechange) x.onreadystatechange(); };
    call("room.dex", { op: "net", method: x._m, url: x._u, body: body == null ? null : String(body) }).then(function (r) {
      if (r && r.status) done(200, String(r.response)); else done(0, "");
    }, function () { done(0, ""); });
  };
  window.XMLHttpRequest = Xhr;
  window.fetch = function () { return Promise.reject(new Error("no network in this frame")); };

  // A cancel or an edit was confirmed on the native screen. An on-chain trade is confirmed only by the page's own
  // review text, word for word: the first call returns that text and sends nothing; the second call must bring it back.
  window.confirm = function (msg) { if (!answer) return false; if (answer.any) return true; asked = String(msg); return answer.reviewed === asked; };
  window.prompt = function () { return answer && answer.prompt != null ? String(answer.prompt) : null; };
  window.alert = function () { };

  function tick() {
    fire({ event: "MDS_TIMER_10SECONDS" });
    call("room.dex", { op: "cmd", command: "block" }).then(function (r) {
      var b = Number(r && r.response && r.response.block) || 0;
      if (b > lastBlock) { lastBlock = b; fire({ event: "NEWBLOCK", data: { txpow: { header: { block: String(b) } } } }); }
    }, function () { });
  }

  window.MDS = {
    minidappuid: "",
    init: function (cb) {
      handler = cb;
      window.addEventListener("load", function () {
        if (window.DexiconDoors) { DexiconDoors.inited = function () { }; DexiconDoors.onBlock = function () { }; DexiconDoors.refresh = function () { }; DexiconDoors.ethCard = function () { return ""; }; }
        fire({ event: "inited" });
        tick(); setInterval(tick, 10000); setInterval(report, 500);
      });
    },
    cmd: function (command, cb) {
      call("room.dex", { op: "cmd", command: String(command) }).then(function (r) { if (cb) cb(r); },
        function (e) { if (cb) cb({ status: false, error: e.message }); });
    },
    sql: function (query, cb) {
      call("room.dex", { op: "sql", query: String(query) }).then(function (r) { if (cb) cb(r); },
        function (e) { if (cb) cb({ status: false, error: e.message }); });
    },
    comms: {
      solo: function (message, cb) {
        call("room.dex", { op: "comms", message: String(message) }).then(function () { if (cb) cb({ status: true }); }, function (e) {
          // The page sends and does not look at the answer. A packet the host refused must not look "sent": it comes
          // back as the service's own ERROR packet, so the page says it and stops waiting.
          comms(JSON.stringify({ origin: "service", type: "ERROR", data: { message: e.message } }));
          if (cb) cb({ status: false, error: e.message });
        });
      },
      broadcast: function (message, cb) { window.MDS.comms.solo(message, cb); }
    },
    net: {
      GET: function (url, cb) { if (cb) cb({ status: false, error: "MDS.net is not available to the page" }); },
      POST: function (url, data, cb) { if (cb) cb({ status: false, error: "MDS.net is not available to the page" }); }
    },
    notify: function () { },
    log: function (m) { if (window.console) console.log("[dexicon] " + m); }
  };

  // ---- what the native screens may ask the page to do: these actions and no others ----
  var NUM = /^[0-9]{1,30}(\.[0-9]{1,30})?$/, HEXID = /^[0-9A-Za-z]{1,160}$/;
  function need(ok, why) { if (!ok) throw new Error(why); }
  var ACTS = {
    /** One order from the Trade form. layer "fast": takes the crossing FAST orders best-first or, when none crosses,
     *  rests as a FAST order (ui/app.js place). layer "chain": the on-chain book and pools (ui/pd_app.js place). */
    place: function (a) {
      need(NUM.test(a.price) && NUM.test(a.amount), "Enter a valid price and amount.");
      need(a.layer === "fast" || a.layer === "chain", "unknown layer");
      var b = $("trade").querySelector(".order-form .cta");
      need(!(b && b.classList.contains("busy")), "A trade is still running. Wait for it to finish.");
      chooseSide(!!a.buy); DexiconFast.setMode(a.layer === "fast");
      $("price").value = a.price; $("amount").value = a.amount;
      preview(); DexiconFast.refreshPreview();
      need(!($("fundsWarn").textContent || "").trim(), ($("fundsWarn").textContent || "").trim());
      if (a.layer === "chain") {
        // ui/pd_app.js place() rounds an on-chain price to 6 decimals and sends an order that crosses nothing without
        // asking. Neither may happen from here: no rounding, and nothing leaves without its review.
        need((a.price.split(".")[1] || "").length <= 6, "An on-chain order takes a price of at most 6 decimals. Nothing was sent.");
        need((a.amount.split(".")[1] || "").length <= 8, "At most 8 decimals in the amount. Nothing was sent.");
        need(chainCrosses(a), "Nothing on the chain crosses this price now. Nothing was sent.");
      }
      place();
    },
    cancelFast: function (a) { need(HEXID.test(a.orderId), "bad order id"); DexiconFast.cancelOrder(a.orderId); },
    editFast: function (a) { need(HEXID.test(a.orderId) && NUM.test(a.price), "Enter a valid new price."); DexiconFast.editOrder(a.orderId, a.price); },
    cancelChain: function (a) { need(/^0x[0-9A-Fa-f]{1,128}$/.test(a.coinid), "bad coin id"); cancel(a.coinid); },
    editChain: function (a) { need(/^0x[0-9A-Fa-f]{1,128}$/.test(a.coinid) && NUM.test(a.price), "Enter a valid new price."); editOrder(a.coinid, a.price); },
    addRelay: function (a) { need(typeof a.url === "string" && a.url.length < 300, "bad relay address"); DexiconFast.addRelay(a.url); },
    removeRelay: function (a) { need(typeof a.url === "string" && a.url.length < 300, "bad relay address"); DexiconFast.removeRelay(a.url); },
    discover: function () { DexiconFast.discover(); },
    refresh: function () { send("REFRESH"); DexiconFast.refresh(); },
    // The market maker's own dialogs (ui/maker.js, the mirror of the Android MarketMaker): the frame is shown over the
    // native screen while one of them is open, and nothing of the page but the dialog is ever visible (style below).
    makerOpen: function (a) { theme(a); DexiconMaker.open(); },
    makerStop: function () { DexiconMaker.stop(); },
    makerReview: function (a) { theme(a); DexiconMaker.review(); }
  };
  function theme(a) { try { localStorage.setItem("dexicon_theme", a && a.light ? "DAYLIGHT" : "ONYX"); applyTheme(); } catch (e) { } }
  var style = document.createElement("style");
  style.textContent = "html,body{background:transparent!important}.topbar,main>:not(dialog){display:none!important}";
  (document.head || document.documentElement).appendChild(style);
  /** The page's own test for "this order trades on the chain now" (ui/pd_app.js place): pools, else book orders. */
  function chainCrosses(a) {
    var block = Number(state.block || 0), comp = PandaComposite.plan(state.book || [], state.pools || [], !!a.buy, a.amount, a.price, block), plan;
    if (!PandaComposite.isEmpty(comp) && PandaComposite.poolCount(comp) > 0) return true;
    plan = PandaBook.plan(state.book || [], !!a.buy, a.amount, a.price, block);
    return !!(plan && plan.takes && plan.takes.length);
  }
  function drive(d) {
    var err = null;
    try {
      need(Object.prototype.hasOwnProperty.call(ACTS, d.act), "not an action of the Exchange screens: " + d.act);
      asked = null;
      answer = { any: d.act !== "place", reviewed: d.args && d.args.reviewed, prompt: d.args && d.args.price };
      ACTS[d.act](d.args || {});
    } catch (e) { err = (e && e.message) || String(e); }
    answer = null;
    parent.postMessage({ dxRoom: 1, driven: d.id, error: err, asked: asked }, "*");
    report();
  }

  // ---- what the page says, for the native screens to show in the page's own words ----
  var last = "";
  function report() {
    var s = $("status"), log = $("tradeLog"), b = $("trade") && $("trade").querySelector(".order-form .cta"), rows = document.querySelectorAll("#relayList .relay-row");
    var p = {
      ready: !!(window.DexiconFast && DexiconFast.myId()), idError: window.DexiconFast ? String(DexiconFast.myIdError() || "") : "",
      notice: s ? String(s.textContent || "") : "", kind: s ? String(s.className || "").replace(/^notice\s*/, "") : "",
      log: log && !log.hidden ? Array.prototype.map.call(log.children, function (c) { return String(c.textContent || ""); }) : [],
      trading: !!(b && b.classList.contains("busy")), dialog: !!document.querySelector("dialog[open]"),
      relays: Array.prototype.map.call(rows, function (r) {
        var u = r.querySelector(".url"), m = r.querySelector(".meta"), dot = r.querySelector("b");
        return { url: u ? u.textContent : "", meta: m ? m.textContent : "", state: dot ? dot.className : "", found: r.classList.contains("discovered") };
      })
    };
    var j = JSON.stringify(p);
    if (j === last) return;
    last = j;
    parent.postMessage({ dxRoom: 1, page: p }, "*");
  }
})();
