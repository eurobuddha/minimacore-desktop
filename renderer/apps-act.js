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
  var MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", MINIMA = "0x00";
  // A price, a fee: digits, at most one point with digits after it, at most 44 decimals (Minima's own limit). No sign, no exponent, no hex.
  var plain = function (v) { return (typeof v === "string" || typeof v === "number") && /^\d{1,30}(\.\d{1,44})?$/.test(String(v)); };
  var decimals = function (v) { var i = v.indexOf("."); return i < 0 ? 0 : v.length - i - 1; };
  var units = function (v, dp) { var i = v.indexOf("."), whole = i < 0 ? v : v.slice(0, i), frac = i < 0 ? "" : v.slice(i + 1); return BigInt(whole + frac.padEnd(dp, "0")); };
  var figure = function (n, dp) { var t = n.toString().padStart(dp + 1, "0"); return t.slice(0, -dp) + "." + t.slice(-dp); };
  var shop = {
    /** The label of a shop's currency: the wire value "USDT" is MxUSD on Minima. */
    cur: function (c) { return /^(usdt|mxusdt)$/i.test(String(c)) ? "MxUSD" : String(c == null ? "" : c); },
    slug: function (s) { return String(s || "shop").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shop"; },
    standardShipping: function () { return [{ id: "digital", label: "Digital", fee: "0" }, { id: "domestic", label: "Domestic", fee: "0" }, { id: "international", label: "International", fee: "0" }]; },
    normalizeShipping: function (list) { var by = {}; (list || []).forEach(function (s) { if (s && s.id) by[s.id] = s; }); return shop.standardShipping().map(function (std) { return { id: std.id, label: std.label, fee: std.id === "digital" ? "0" : String((by[std.id] && by[std.id].fee) || "0") }; }); },
    shipOf: function (s, shipId) { if (!s || !s.shipping || !s.shipping.length) return null; return s.shipping.find(function (x) { return x.id === shipId; }) || s.shipping[0]; },
    /** The token a shop is paid in, from its CURRENCY alone (0.19.118). A .shop file is the vendor's: one that says "Minima" and
     *  carries another token's id would have a buyer pay that token under the Minima label. → { tokenid, name } | { err }. */
    token: function (s) {
      var c = String(s && s.currency == null ? "" : s && s.currency), t = /^minima$/i.test(c) ? MINIMA : /^(usdt|mxusdt)$/i.test(c) ? MXUSD : "";
      if (!t) return { err: "This shop asks to be paid in \"" + c.slice(0, 40) + "\". This app pays shops in Minima or MxUSD only." };
      var given = s.tokenid == null || s.tokenid === "" ? "" : String(s.tokenid);
      if (given && given.toLowerCase() !== t.toLowerCase()) return { err: "This shop says it is paid in " + shop.cur(c) + " but names another token (" + given.slice(0, 80) + "). Nothing was sent. Ask the vendor for a corrected .shop file." };
      return { tokenid: t, name: t === MINIMA ? "Minima" : "MxUSD" };
    },
    /** A product picture from a .shop: an inline picture or nothing. Any other URL (file://host/… opens an SMB connection on Windows) is no picture. */
    image: function (src) { return typeof src === "string" && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/]+=*$/.test(src) ? src : ""; },
    /** What is wrong with a shop, before it is opened, saved or ordered from; "" = nothing. */
    problem: function (s) {
      if (!s || typeof s !== "object" || !s.shopName || !Array.isArray(s.products)) return "That doesn't look like a valid .shop file.";
      var t = shop.token(s); if (t.err) return t.err;
      for (var i = 0; i < s.products.length; i++) {
        var p = s.products[i] || {};
        if (!plain(p.price)) return "The price of \"" + String(p.name).slice(0, 60) + "\" is not a plain number (" + String(p.price).slice(0, 40) + ").";
        if (p.maxUnits != null && p.maxUnits !== "" && !/^[1-9]\d{0,8}$/.test(String(p.maxUnits))) return "The stock of \"" + String(p.name).slice(0, 60) + "\" is not a whole number above zero.";
      }
      var sh = s.shipping || [];
      if (!Array.isArray(sh)) return "This shop's delivery methods cannot be read.";
      for (var j = 0; j < sh.length; j++) if (!sh[j] || !plain(sh[j].fee == null || sh[j].fee === "" ? "0" : sh[j].fee)) return "The fee of the delivery method \"" + String(sh[j] && sh[j].label).slice(0, 60) + "\" is not a plain number.";
      return "";
    },
    /** The lines and totals of a cart, in whole units of the smallest decimal in play (BigInt; never a floating-point number).
     *  Six decimals at least, as this app has always sent; more only when a price has more (the exact figure, as the phone
     *  sends it: nothing is rounded and nothing needs cutting). shipId "none": the items alone. → { items, itemsTotal, fee, total } | { err }. */
    totals: function (s, cart, shipId) {
      var why = shop.problem(s); if (why) return { err: why };
      var ship = shipId === "none" ? null : shop.shipOf(s, shipId), fee = ship ? String(ship.fee == null || ship.fee === "" ? "0" : ship.fee) : "0";
      var lines = [], dp = Math.max(6, decimals(fee));
      for (var i = 0; i < s.products.length; i++) {
        var p = s.products[i], q = cart[p.id];
        if (!q) continue;
        if (!Number.isSafeInteger(q) || q < 1) return { err: "The quantity of \"" + String(p.name).slice(0, 60) + "\" is not a whole number above zero." };
        lines.push([p, q]); dp = Math.max(dp, decimals(String(p.price)));
      }
      var sum = 0n, items = lines.map(function (l) { var line = units(String(l[0].price), dp) * BigInt(l[1]); sum += line; return { product: l[0].name, quantity: l[1], unitPrice: String(l[0].price), lineTotal: figure(line, dp) }; });
      return { items: items, itemsTotal: figure(sum, dp), fee: figure(units(fee, dp), dp), total: figure(sum + units(fee, dp), dp), zero: sum + units(fee, dp) === 0n };
    },
    cartTotal: function (s, cart, shipId) { return shop.totals(s, cart, shipId).total || "0.000000"; },
    orderItems: function (s, cart) { return shop.totals(s, cart, "none").items || []; },
    /** Checkout. ui.confirm(title, text) -> bool (the original's "Pay …?" question, then what is sent, to whom and in which token, each whole
     *  on its own line). The amount shown is the string that is sent. → { ref, payError } | { cancelled } | { err[, refused] }. */
    place: function (api, ui, s, cart, shipId, delivery, note) {
      var t = shop.totals(s || {}, cart, shipId);
      if (t.err) return Promise.resolve({ err: t.err, refused: true });
      if (!t.items.length) return Promise.resolve({ err: "Cart is empty.", refused: true });
      delivery = text(delivery); note = text(note);
      if (!delivery) return Promise.resolve({ err: "Add a delivery address.", refused: true });
      if (t.zero) return Promise.resolve({ err: "The total is zero. Nothing was sent.", refused: true });
      var ship = shop.shipOf(s, shipId), total = t.total, tok = shop.token(s), cur = tok.name;
      return Promise.resolve(ui.confirm("Pay " + total + " " + cur + "?", "This sends your encrypted order to " + s.shopName + " and pays " + total + " " + cur + ". Payment is final."
        + "\n\nAmount sent\n" + total + "\n\nToken: " + cur + "\n" + tok.tokenid + "\n\nVendor's payment address\n" + String(s.vendorAddress))).then(function (yes) {
        if (!yes) return { cancelled: true };
        if (ui.busy) ui.busy();
        return api.shopPlaceOrder(s, t.items, total, ship ? ship.label : "", delivery, note).catch(errOf);
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
      var cfg = shop.cfgOf(d), wasNew = !d.shopId, why = shop.problem(cfg);
      if (why) return Promise.resolve({ err: why });
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
