/*
 * apps-act.js: what the tray apps' screens ASK of the main process (Phase 5a, 0.19.108+).
 *
 * The screens of ETH Wallet, Minima Vestr, miniMall and the Web Wallet were rebuilt to look like their originals in
 * Pandamonium. Their money did not move: every call that can spend, sign or reveal a key is made here, in one small
 * function per action, so a test can run it against a recording window.mcd and compare the calls and their arguments
 * with what the screens they replaced sent (scripts/apps-money.test.cjs). No DOM in this file.
 */
(function (root, make) { if (typeof module === "object" && module.exports) module.exports = make(); else root.AppsAct = make(); })(this, function () {
  "use strict";
  var errOf = function (e) { return { err: String((e && e.message) || e) }; };
  var text = function (v) { return String(v == null ? "" : v).trim(); };

  // ---- ETH Wallet (main/ethwallet.js, the AtomiX engine's Ethereum code) ----
  var EXPORT_PHRASE = "SHOW KEY";
  var eth = {
    EXPORT_PHRASE: EXPORT_PHRASE,
    max: function (api, asset) { return api.ewSendMax(asset).catch(function () { return null; }); },
    /** The review of a send. → { err } or the main process's answer with the trimmed `to` and `amt` the send will carry. */
    review: function (api, own, asset, to, amt) {
      to = text(to); amt = text(amt);
      if (own && to && to.toLowerCase() === String(own).toLowerCase()) return Promise.resolve({ err: "That's your own address" });
      return api.ewSendReview(asset, to, amt).then(function (r) { return r && !r.err ? Object.assign({}, r, { to: to, amt: amt }) : (r || { err: "No answer" }); }, errOf);
    },
    send: function (api, asset, to, amt, tier) { return api.ewSend(asset, to, amt, tier).catch(errOf); },
    addToken: function (api, addr) { return api.ewAddToken(text(addr)).catch(errOf); },
    removeToken: function (api, addr) { return api.ewRemoveToken(addr).catch(function () {}); },
    setRpc: function (api, url) { return api.ewSetRpc(text(url)).catch(errOf); },
    /** The key leaves the main process only after the typed phrase (checked again there) and, where the system offers one, its own prompt. */
    exportKey: function (api, typed) {
      if (text(typed) !== EXPORT_PHRASE) return Promise.resolve({ err: "Type " + EXPORT_PHRASE + " exactly to continue." });
      return api.ewExportKey(text(typed)).then(function (k) { return k ? { key: k } : { err: "No key yet" }; }, errOf);
    }
  };

  return { eth: eth };
});
