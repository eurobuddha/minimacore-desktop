/*
 * shop-rules.js — the miniMall rules both sides use (0.18.150): which token a .shop is paid in, what a price is, what a
 * product picture may be, and the exact totals of a cart. Loaded by renderer/index.html (window.ShopRules) and
 * required by main/shop.js, so the screen and the main process cannot disagree.
 *
 * A .shop file is the vendor's and can say anything. One that says "Minima" and carries the MxUSD token id (or any
 * token id that is not its currency's) would have a buyer pay that token under the Minima label: it is refused.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ShopRules = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var MINIMA = "0x00", MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";
  // A price or a fee: digits, at most one point with digits after it, at most 44 decimals (Minima's own limit). No sign, no exponent, no hex.
  var plain = function (v) { return (typeof v === "string" || typeof v === "number") && /^\d{1,30}(\.\d{1,44})?$/.test(String(v)); };
  var decimals = function (v) { var i = v.indexOf("."); return i < 0 ? 0 : v.length - i - 1; };
  var units = function (v, dp) { var i = v.indexOf("."), whole = i < 0 ? v : v.slice(0, i), frac = i < 0 ? "" : v.slice(i + 1); return BigInt(whole + frac.padEnd(dp, "0")); };
  var figure = function (n, dp) { var t = n.toString().padStart(dp + 1, "0"); return t.slice(0, -dp) + "." + t.slice(-dp); };
  var R = {
    MINIMA: MINIMA, MXUSD: MXUSD,
    /** THE currency to token mapping (0.18.202; main/shop.js and main/shop-listing.js use it): Minima → 0x00, USDT (the
     *  wire name of MxUSD) or mxUSDT → the MxUSD token id, anything else → "". */
    tokenOfCurrency: function (c) { return /^minima$/i.test(String(c)) ? MINIMA : /^(usdt|mxusdt)$/i.test(String(c)) ? MXUSD : ""; },
    /** The label of a currency: the wire value "USDT" is MxUSD on Minima. */
    cur: function (c) { return /^(usdt|mxusdt)$/i.test(String(c)) ? "MxUSD" : String(c == null ? "" : c); },
    /** The token a shop (or an order) is paid in, from its CURRENCY alone. → { tokenid, name } | { err }. */
    token: function (s) {
      var c = String(s && s.currency != null ? s.currency : ""), t = R.tokenOfCurrency(c);
      if (!t) return { err: "This shop asks to be paid in \"" + c.slice(0, 40) + "\". This app pays shops in Minima or MxUSD only." };
      var given = s.tokenid == null || s.tokenid === "" ? "" : String(s.tokenid);
      if (given && given.toLowerCase() !== t.toLowerCase()) return { err: "This shop says it is paid in " + R.cur(c) + " but names another token (" + given.slice(0, 80) + "). Nothing was sent. Ask the vendor for a corrected .shop file." };
      return { tokenid: t, name: t === MINIMA ? "Minima" : "MxUSD" };
    },
    /** A product picture: an inline picture or nothing. Any other URL (file://host/… opens an SMB connection on Windows) is no picture. */
    image: function (src) { return typeof src === "string" && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/]+=*$/.test(src) ? src : ""; },
    /** What is wrong with a shop, before it is opened, saved or ordered from; "" = nothing. */
    problem: function (s) {
      if (!s || typeof s !== "object" || !s.shopName || !Array.isArray(s.products)) return "That doesn't look like a valid .shop file.";
      var t = R.token(s); if (t.err) return t.err;
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
    shipOf: function (s, shipId) { if (!s || !s.shipping || !s.shipping.length) return null; return s.shipping.find(function (x) { return x.id === shipId; }) || s.shipping[0]; },
    /** The lines and totals of a cart in BigInt (never a floating-point number): six decimals at least, as this app has
     *  always sent; more only when a price has more (the exact figure; nothing is rounded). shipId "none": the items alone.
     *  → { items, itemsTotal, fee, total, zero } | { err }. */
    totals: function (s, cart, shipId) {
      var why = R.problem(s); if (why) return { err: why };
      cart = cart || {};
      var ship = shipId === "none" ? null : R.shipOf(s, shipId), fee = ship ? String(ship.fee == null || ship.fee === "" ? "0" : ship.fee) : "0";
      var lines = [], dp = Math.max(6, decimals(fee));
      for (var i = 0; i < s.products.length; i++) {
        var p = s.products[i], q = cart[p.id];
        if (!q) continue;
        if (!Number.isSafeInteger(q) || q < 1) return { err: "The quantity of \"" + String(p.name).slice(0, 60) + "\" is not a whole number above zero." };
        lines.push([p, q]); dp = Math.max(dp, decimals(String(p.price)));
      }
      var sum = 0n, items = lines.map(function (l) { var line = units(String(l[0].price), dp) * BigInt(l[1]); sum += line; return { product: l[0].name, quantity: l[1], unitPrice: String(l[0].price), lineTotal: figure(line, dp) }; });
      var all = sum + units(fee, dp);
      return { items: items, itemsTotal: figure(sum, dp), fee: figure(units(fee, dp), dp), total: figure(all, dp), zero: all === 0n };
    },
    /** A plain decimal above zero (what may be sent). */
    payable: function (v) { return /^\d+(\.\d+)?$/.test(String(v)) && /[1-9]/.test(String(v)); }
  };
  return R;
}));
