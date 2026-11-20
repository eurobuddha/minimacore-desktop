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

  // ---- miniMall (main/shop.js) ----
  // The figures an order carries are built exactly as the screens before built them (six decimals, as the phone apps send).
  var MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  var shop = {
    /** The label of a shop's currency: the wire value "USDT" is MxUSD on Minima. */
    cur: function (c) { return /^(usdt|mxusdt)$/i.test(String(c)) ? "MxUSD" : String(c == null ? "" : c); },
    slug: function (s) { return String(s || "shop").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shop"; },
    standardShipping: function () { return [{ id: "digital", label: "Digital", fee: "0" }, { id: "domestic", label: "Domestic", fee: "0" }, { id: "international", label: "International", fee: "0" }]; },
    normalizeShipping: function (list) { var by = {}; (list || []).forEach(function (s) { if (s && s.id) by[s.id] = s; }); return shop.standardShipping().map(function (std) { return { id: std.id, label: std.label, fee: std.id === "digital" ? "0" : String((by[std.id] && by[std.id].fee) || "0") }; }); },
    shipOf: function (s, shipId) { if (!s || !s.shipping || !s.shipping.length) return null; return s.shipping.find(function (x) { return x.id === shipId; }) || s.shipping[0]; },
    /** shipId "none": the items alone. */
    cartTotal: function (s, cart, shipId) {
      if (!s) return 0; var t = 0;
      (s.products || []).forEach(function (p) { var q = cart[p.id] || 0; if (q) t += q * Number(p.price); });
      var ship = shipId === "none" ? null : shop.shipOf(s, shipId); if (ship) t += Number(ship.fee) || 0;
      return t;
    },
    orderItems: function (s, cart) { return (s.products || []).filter(function (p) { return cart[p.id]; }).map(function (p) { return { product: p.name, quantity: cart[p.id], unitPrice: String(p.price), lineTotal: (cart[p.id] * Number(p.price)).toFixed(6) }; }); },
    /** Checkout. ui.confirm(title, text) -> bool (the original's "Pay …?" question). → { ref, payError } | { cancelled } | { err[, refused] }. */
    place: function (api, ui, s, cart, shipId, delivery, note) {
      var items = shop.orderItems(s, cart);
      if (!items.length) return Promise.resolve({ err: "Cart is empty.", refused: true });
      delivery = text(delivery); note = text(note);
      if (!delivery) return Promise.resolve({ err: "Add a delivery address.", refused: true });
      var ship = shop.shipOf(s, shipId), total = shop.cartTotal(s, cart, shipId).toFixed(6), cur = shop.cur(s.currency);
      return Promise.resolve(ui.confirm("Pay " + total + " " + cur + "?", "This sends your encrypted order to " + s.shopName + " and pays " + total + " " + cur + ". Payment is final.")).then(function (yes) {
        if (!yes) return { cancelled: true };
        if (ui.busy) ui.busy();
        return api.shopPlaceOrder(s, items, total, ship ? ship.label : "", delivery, note).catch(errOf);
      });
    },
    retryPay: function (api, ref) { return api.shopRetryPay(ref).then(function () { return { ok: true }; }, errOf); },
    /** The one status a vendor may set next (the screens before allowed exactly this): none before payment, none for an enquiry. */
    nextStatus: function (o) {
      if (!o || o.status === "INQUIRY" || !o.paid) return null;
      var rank = { PAID: -1, CONFIRMED: 0, SHIPPED: 1, DELIVERED: 2 }, cur = rank[o.status] != null ? rank[o.status] : -1;
      return ["CONFIRMED", "SHIPPED", "DELIVERED"][cur + 1] || null;
    },
    advance: function (api, ref, status) { return api.shopAdvance(ref, status).then(function () { return { ok: true }; }, errOf); },
    /** → null when there is nothing to send. */
    reply: function (api, ref, typed) { var t = text(typed); if (!t) return Promise.resolve(null); return api.shopReply(ref, t).then(function () { return { ok: true }; }, errOf); },
    /** The .shop a Studio draft becomes. */
    cfgOf: function (d) {
      return { shopName: d.shopName, shopId: d.shopId || shop.slug(d.shopName), vendorPublicId: d.vendorPublicId, vendorAddress: d.vendorAddress,
        currency: d.currency, tokenid: d.currency === "Minima" ? "0x00" : MXUSD,
        shipping: shop.normalizeShipping(d.shipping),
        products: d.products.filter(function (p) { return p.name && Number(p.price) > 0; }).map(function (p) { return { id: p.id, name: p.name, description: p.description || "", mode: "units", price: String(p.price), maxUnits: String(Number(p.maxUnits) || 10), image: p.image || "" }; }) };
    },
    save: function (api, d) {
      if (!d.shopName) return Promise.resolve({ err: "Give the shop a name" });
      if (!d.products.length) return Promise.resolve({ err: "Add at least one product" });
      var cfg = shop.cfgOf(d), wasNew = !d.shopId;
      return api.shopSave(cfg).then(function () {
        if (!wasNew) return { ok: true };
        return api.shopExport(JSON.stringify(cfg, null, 2), cfg.shopId).then(function (p) { return { ok: true, exported: p || "" }; });
      }).catch(errOf);
    }
  };

  // ---- Web Wallet (main/webwallet.js) ----
  var ww = {
    problem: function (f) { if (!text(f.to)) return "Enter a recipient address"; if (!(Number(text(f.amount)) > 0)) return "Enter a valid amount"; return ""; },
    /** → the main process's answer ({ ok, txnid } | { ambiguous, message } | { message }), or { err } when it threw. */
    send: function (api, f) { return api.wwSend({ seed: f.seed, to: text(f.to), amount: text(f.amount), tokenid: f.tokenid }).catch(function (e) { return { message: String((e && e.message) || "Send failed") }; }); }
  };

  return { eth: eth, vestr: vestr, shop: shop, ww: ww };
});
