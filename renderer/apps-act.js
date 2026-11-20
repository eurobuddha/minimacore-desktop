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

  // ---- Minima Vestr (main/vestr.js) ----
  // No fee is sent as "" (0.19.109). The screens before sent "0", which main/vestr.js has refused since 0.16.97 ("Invalid
  // burn amount": its amount check wants a figure above zero), so a collect or a create with the fee left alone failed.
  var fee = function (v) { v = text(v); return /^0*(\.0*)?$/.test(v) ? "" : v; };
  var vestr = {
    /** What stops a create before anything is asked of the node, in the original's words and order; "" = nothing. */
    createProblem: function (f, now) {
      if (!text(f.beneficiary)) return "Enter a valid withdrawal address.";
      if (!/^\d+(\.\d+)?$/.test(text(f.amount))) return "Enter a valid amount.";
      if (!(Number(text(f.amount)) > 0)) return "Amount must be greater than zero.";
      if (!isFinite(f.startMs)) return "Pick a start date.";
      if (!isFinite(f.endMs)) return "Pick an end date.";
      if (!(f.startMs > now)) return "Start must be in the future.";
      if (!(f.endMs > f.startMs)) return "End must be after the start.";
      return "";
    },
    /** The review (the beneficiary whole: this covenant has no cancel), then the one call. → { ok } | { cancelled } | { err }. */
    create: function (api, ui, f, tokenName, graceName) {
      var opts = { tokenid: f.tokenid, amount: text(f.amount), beneficiary: text(f.beneficiary), startMs: f.startMs, endMs: f.endMs,
        graceHours: Number(f.graceHours) || 0, burn: fee(f.burn), password: f.password || "" };
      return ui.confirm("Create vesting contract?", "Lock " + opts.amount + " " + tokenName + "\n\nWithdrawal address\n" + opts.beneficiary + "\n\n"
        + "Collection: " + graceName + ", from start to end.\nCheck the address above character by character. This cannot be cancelled.", "Lock funds", false).then(function (yes) {
        if (!yes) return { cancelled: true };
        return api.vestrCreate(opts).then(function () { return { ok: true }; }, errOf);
      });
    },
    collect: function (api, coinid, typed) { return api.vestrCollect(coinid, fee(typed)).then(function (r) { return r || { ok: true }; }, errOf); }
  };

  return { eth: eth, vestr: vestr };
});
