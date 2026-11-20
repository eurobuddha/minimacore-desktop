/*
 * apps-act.js: what the tray apps' screens ASK of the main process (Phase 5a, 0.19.108+).
 *
 * The screens of ETH Wallet, Minima Vestr, miniMall and the Web Wallet were rebuilt to look like their originals in
 * Pandamonium. Their money did not move: every call that can spend, sign or reveal a key is made here, in one small
 * function per action, so a test can run it against a recording window.mcd and compare the calls and their arguments
 * with what the screens they replaced sent (scripts/apps-money.test.cjs). No DOM in this file.
 */
if (typeof I18N === "undefined" && typeof require === "function") require("./i18n.js");   // loaded by a test or the main process: the same t(), th(), tr() the window has
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
      if (own && to && to.toLowerCase() === String(own).toLowerCase()) return Promise.resolve({ err: I18N.t("That's your own address") });
      return api.ewSendReview(asset, to, amt).then(function (r) { return r && !r.err ? Object.assign({}, r, { to: to, amt: amt }) : (r || { err: I18N.t("No answer") }); }, errOf);
    },
    send: function (api, asset, to, amt, tier) { return api.ewSend(asset, to, amt, tier).catch(errOf); },
    addToken: function (api, addr) { return api.ewAddToken(text(addr)).catch(errOf); },
    removeToken: function (api, addr) { return api.ewRemoveToken(addr).catch(function () {}); },
    setRpc: function (api, url) { return api.ewSetRpc(text(url)).catch(errOf); },
    /** The key leaves the main process only after the typed phrase (checked again there) and, where the system offers one, its own prompt. */
    exportKey: function (api, typed) {
      if (text(typed) !== EXPORT_PHRASE) return Promise.resolve({ err: I18N.t("Type {exportphrase} exactly to continue.", { exportphrase: EXPORT_PHRASE }) });
      return api.ewExportKey(text(typed)).then(function (r) { return r && r.key ? { key: r.key, system: r.system === true } : { err: I18N.t("No key yet") }; }, errOf);
    }
  };

  // ---- Minima Vestr (main/vestr.js) ----
  // No fee is sent as "" (0.19.109). The screens before sent "0", which main/vestr.js has refused since 0.16.97 ("Invalid
  // burn amount": its amount check wants a figure above zero), so a collect or a create with the fee left alone failed.
  var fee = function (v) { v = text(v); return /^0*(\.0*)?$/.test(v) ? "" : v; };
  var vestr = {
    /** What stops a create before anything is asked of the node, in the original's words and order; "" = nothing. */
    createProblem: function (f, now) {
      if (!text(f.beneficiary)) return I18N.t("Enter a valid withdrawal address.");
      if (!/^\d+(\.\d+)?$/.test(text(f.amount))) return I18N.t("Enter a valid amount.");
      if (!(Number(text(f.amount)) > 0)) return I18N.t("Amount must be greater than zero.");
      if (!isFinite(f.startMs)) return I18N.t("Pick a start date.");
      if (!isFinite(f.endMs)) return I18N.t("Pick an end date.");
      if (!(f.startMs > now)) return I18N.t("Start must be in the future.");
      if (!(f.endMs > f.startMs)) return I18N.t("End must be after the start.");
      return "";
    },
    /** The review (the beneficiary whole: this covenant has no cancel), then the one call. → { ok } | { cancelled } | { err }. */
    create: function (api, ui, f, tokenName, graceName) {
      var opts = { tokenid: f.tokenid, amount: text(f.amount), beneficiary: text(f.beneficiary), startMs: f.startMs, endMs: f.endMs,
        graceHours: Number(f.graceHours) || 0, burn: fee(f.burn), password: f.password || "" };
      return ui.confirm(I18N.t("Create vesting contract?"), I18N.t("Lock {amount} {tokenName}\n\nWithdrawal address\n{beneficiary}\n\nCollection: {graceName}, from start to end.\nCheck the address above character by character. This cannot be cancelled.", { amount: opts.amount, tokenName: tokenName, beneficiary: opts.beneficiary, graceName: graceName }), I18N.t("Lock funds"), false).then(function (yes) {
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
    standardShipping: function () { return [{ id: "digital", label: I18N.t("Digital"), fee: "0" }, { id: "domestic", label: I18N.t("Domestic"), fee: "0" }, { id: "international", label: I18N.t("International"), fee: "0" }]; },
    normalizeShipping: function (list) { var by = {}; (list || []).forEach(function (s) { if (s && s.id) by[s.id] = s; }); return shop.standardShipping().map(function (std) { return { id: std.id, label: std.label, fee: std.id === "digital" ? "0" : String((by[std.id] && by[std.id].fee) || "0") }; }); },
    shipOf: function (s, shipId) { if (!s || !s.shipping || !s.shipping.length) return null; return s.shipping.find(function (x) { return x.id === shipId; }) || s.shipping[0]; },
    /** The token a shop is paid in, from its CURRENCY alone (0.19.118). A .shop file is the vendor's: one that says "Minima" and
     *  carries another token's id would have a buyer pay that token under the Minima label. → { tokenid, name } | { err }. */
    token: function (s) {
      var c = String(s && s.currency == null ? "" : s && s.currency), t = /^minima$/i.test(c) ? MINIMA : /^(usdt|mxusdt)$/i.test(c) ? MXUSD : "";
      if (!t) return { err: I18N.t("This shop asks to be paid in \"{c}\". This app pays shops in Minima or MxUSD only.", { c: c.slice(0, 40) }) };
      var given = s.tokenid == null || s.tokenid === "" ? "" : String(s.tokenid);
      if (given && given.toLowerCase() !== t.toLowerCase()) return { err: I18N.t("This shop says it is paid in {c} but names another token ({given}). Nothing was sent. Ask the vendor for a corrected .shop file.", { c: shop.cur(c), given: given.slice(0, 80) }) };
      return { tokenid: t, name: t === MINIMA ? "Minima" : "MxUSD" };
    },
    /** A product picture from a .shop: an inline picture or nothing. Any other URL (file://host/… opens an SMB connection on Windows) is no picture. */
    image: function (src) { return typeof src === "string" && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/]+=*$/.test(src) ? src : ""; },
    /** What is wrong with a shop, before it is opened, saved or ordered from; "" = nothing. */
    problem: function (s) {
      if (!s || typeof s !== "object" || !s.shopName || !Array.isArray(s.products)) return I18N.t("That doesn't look like a valid .shop file.");
      var t = shop.token(s); if (t.err) return t.err;
      for (var i = 0; i < s.products.length; i++) {
        var p = s.products[i] || {};
        if (!plain(p.price)) return I18N.t("The price of \"") + String(p.name).slice(0, 60) + "\" is not a plain number (" + String(p.price).slice(0, 40) + ").";
        if (p.maxUnits != null && p.maxUnits !== "" && !/^[1-9]\d{0,8}$/.test(String(p.maxUnits))) return I18N.t("The stock of \"") + String(p.name).slice(0, 60) + "\" is not a whole number above zero.";
      }
      var sh = s.shipping || [];
      if (!Array.isArray(sh)) return I18N.t("This shop's delivery methods cannot be read.");
      for (var j = 0; j < sh.length; j++) if (!sh[j] || !plain(sh[j].fee == null || sh[j].fee === "" ? "0" : sh[j].fee)) return I18N.t("The fee of the delivery method \"") + String(sh[j] && sh[j].label).slice(0, 60) + "\" is not a plain number.";
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
        if (!Number.isSafeInteger(q) || q < 1) return { err: I18N.t("The quantity of \"") + String(p.name).slice(0, 60) + "\" is not a whole number above zero." };
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
      if (!t.items.length) return Promise.resolve({ err: I18N.t("Cart is empty."), refused: true });
      delivery = text(delivery); note = text(note);
      if (!delivery) return Promise.resolve({ err: I18N.t("Add a delivery address."), refused: true });
      if (t.zero) return Promise.resolve({ err: I18N.t("The total is zero. Nothing was sent."), refused: true });
      var ship = shop.shipOf(s, shipId), total = t.total, tok = shop.token(s), cur = tok.name;
      return Promise.resolve(ui.confirm(I18N.t("Pay {total} {cur}?", { total: total, cur: cur }), I18N.t("This sends your encrypted order to {shopName} and pays {total} {cur}. Payment is final.\n\nAmount sent\n{total2}\n\nToken: {cur2}\n{tokenid}\n\nVendor's payment address\n{vendorAddress}", { shopName: s.shopName, total: total, cur: cur, total2: total, cur2: cur, tokenid: tok.tokenid, vendorAddress: String(s.vendorAddress) }))).then(function (yes) {
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
      if (!d.shopName) return Promise.resolve({ err: I18N.t("Give the shop a name") });
      if (!d.products.length) return Promise.resolve({ err: I18N.t("Add at least one product") });
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
    problem: function (f) { if (!text(f.to)) return I18N.t("Enter a recipient address"); if (!(Number(text(f.amount)) > 0)) return I18N.t("Enter a valid amount"); return ""; },
    /**
     * The figure to record when the user confirms the secret key uses: what they typed, never below what the chain
     * shows. → null (REFUSE) when the chain's figure was not read: an unread figure is never taken as 0, because a
     * count that is too low signs with a one-time key a second time.
     */
    confirmUses: function (typed, onchain) {
      if (typeof onchain !== "number" || !Number.isSafeInteger(onchain) || onchain < 0) return null;
      var n = Math.floor(Number(typed));
      return Math.max(Number.isSafeInteger(n) && n > 0 ? n : 0, onchain);
    },
    /** → the main process's answer ({ ok, txnid } | { ambiguous, message } | { message }), or { err } when it threw. */
    send: function (api, f) { return api.wwSend({ seed: f.seed, to: text(f.to), amount: text(f.amount), tokenid: f.tokenid }).catch(function (e) { return { message: String((e && e.message) || I18N.t("Send failed")) }; }); }
  };

  // ---- KeyUses (main/keyuses.js): what the audit's answer is SHOWN as. Pandamonium's KeyUses 0.1.4, MainActivity. ----
  // Wording: apks/base localization bear_strings.xml (l10n_keyuses_*), with the phone-only parts taken out.
  var KU = {
    reuseTitle: L_("One-time key reuse detected"), riskTitle: L_("Classic counter is behind recorded usage"),
    riskBody: L_("The archive shows more spend blocks than the stored classic counter. Review these keys before signing again. Block-based leaf positions are not compared with spend counts."),
    causes: L_("Common causes"), causesBody: L_("Independent signers using the same seed, restoring an old counter, or restoring an older wallet snapshot can reuse a one-time key. This audit never changes counters or signs transactions."),
    okTitle: L_("No known key reuse was found in the checked keys."), partial: L_("Audit needs review"),
    incomplete: L_("Some public audit results are missing or inconsistent. Those rows remain unknown. Confirmed reuse findings still apply."),
    explain: L_("Each one-time signing leaf must sign only once. Classic keys use counters; block-based keys use block-derived positions. The audit combines archive spend counts with witnessed reuse reports for both families. USED/UNUSED describes the archive history; it does not verify a local signing counter."),
    blockLabel: L_("Node seed · block-based"), blockNote: L_("Block-based keys use a block-derived leaf position. A classic keyuses recovery estimate does not apply to these keys."),
    reco: L_("Classic recovery estimate: review before use"), keyAudit: L_("Key audit"),
    mismatch: L_("The server’s address differs from the locally derived address. Treat the audit as incomplete."),
    exhaustion: L_("A key is near its signature capacity. Review it before signing again."),
    // said INSIDE the verdict, beside the checked scope: L_("no reuse in the checked keys") is not a clean bill for the keys that were not checked
    gap: L_("Not checked here: the keys this wallet's seed gives in the other key mode (the phone checks 64 classic and 32 block-based keys derived from the seed), and minimaWallet's keys. If this seed was ever used in the other mode or in another wallet app, those keys can have been reused and this result does not show it.")
  };
  var keyuses = {
    COPY: KU, UNAVAILABLE: L_("The node’s keys could not be read. Check that the node is running, then run the audit again."),
    /** A count the node or the server gave, grouped as the phone groups it; null (nothing was read) is said in words, never as 0. */
    num: function (v) { return typeof v === "number" && isFinite(v) ? String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : I18N.t("Not read"); },
    // The two key shapes, as main/keyuses.js SHAPES (a test holds the two copies together). A classic key's counter is a
    // count of SIGNATURES; a block-based key's is its KEY BLOCK POSITION (it follows the chain's block number), which is
    // not a count of signatures and is never set beside a classic count.
    SHAPES: { classic: { size: 64, depth: 3, maxuses: 262144 }, block: { size: 128, depth: 4, maxuses: 268435456 } },
    /**
     * The node's key list (`keys action:list`) by family → { classic, block }, each null or { used, cap, count } with
     * `used` the highest counter of that family. → null when the list is empty or ANY row is not exactly a classic or a
     * block key with a whole counter: an unread counter is never shown as 0 and no capacity is assumed.
     */
    families: function (keys) {
      var whole = function (v) { if (typeof v === "number") return Number.isSafeInteger(v) ? v : null; return typeof v === "string" && /^-?\d{1,15}(\.0+)?$/.test(v) ? Number(v.split(".")[0]) : null; };
      if (!Array.isArray(keys) || !keys.length) return null;
      var out = { classic: null, block: null };
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i] || {}, size = whole(k.size), depth = whole(k.depth), cap = whole(k.maxuses), used = whole(k.uses), fam = null;
        for (var f in keyuses.SHAPES) if (keyuses.SHAPES[f].size === size && keyuses.SHAPES[f].depth === depth && keyuses.SHAPES[f].maxuses === cap) fam = f;
        if (!fam || used == null || used < 0) return null;
        if (!out[fam]) out[fam] = { used: used, cap: cap, count: 0 };
        out[fam].count++; if (used > out[fam].used) out[fam].used = used;
      }
      return out;
    },
    /** Settings' "Signing keys" card from families(): one line per family the wallet has. Only a classic line has a share, a bar and the 80% warning. */
    signing: function (f) {
      var rows = [], n = function (c) { return keyuses.num(c) + (" " + I18N.t(c === 1 ? "key" : "keys")); };
      if (f && f.classic) { var pct = Math.min(100, Math.floor(f.classic.used * 100 / f.classic.cap));
        rows.push({ family: "classic", label: I18N.t("Classic keys: most-used key"), value: I18N.t("{used} of {cap} signatures · {count}", { used: keyuses.num(f.classic.used), cap: keyuses.num(f.classic.cap), count: n(f.classic.count) }), pct: pct, warn: pct >= 80,
          note: pct >= 80 ? I18N.t("A classic signing key is {pct}% used. Generate fresh keys or restore with the correct key uses before it is exhausted.", { pct: pct }) : "" }); }
      if (f && f.block) rows.push({ family: "block", label: I18N.t("Block-based keys: key block position"), value: "position " + keyuses.num(f.block.used) + " of " + keyuses.num(f.block.cap) + " · " + n(f.block.count), pct: null, warn: false,
        note: I18N.t("A block-based key's position follows the chain's block number. It is not a count of signatures, so it is not compared with classic keys.") });
      return rows;
    },
    /** The status chip of one row (MainActivity.row): → { label, tone: "ok" | "warn" | "risk" }. */
    chip: function (r) {
      if (r.reused) return { label: I18N.t("REUSED{reuseCount}", { reuseCount: (r.reuseCount > 0 ? " ×" + r.reuseCount : "") }), tone: r.reuseCount > 3 ? "risk" : "warn" };
      if (r.risk) return { label: I18N.t("AT RISK"), tone: "risk" };
      if (!r.checked) return { label: I18N.t("Unknown"), tone: "warn" };
      return { label: r.sigs > 0 ? I18N.t("USED {sigs}", { sigs: keyuses.num(r.sigs) }) : I18N.t("UNUSED"), tone: "ok" };
    },
    /** The verdict card (MainActivity.verdictCard, addRecoBlocks): → { tone, title, body, blocks: [{ label, body } | { label, cmd }] }. */
    verdict: function (r) {
      var out, reco = function (b) {
        if (r.complete && r.classicKeys > 0 && r.recommendedKeyUses < 262144) b.push({ label: KU.reco, cmd: "keyuses:" + r.recommendedKeyUses });
        if (r.blockKeys > 0) b.push({ label: KU.blockLabel, body: KU.blockNote });
        return b;
      };
      if (r.verdict === "REUSE_RISK" || r.verdict === "REUSE_WARN")
        out = { tone: r.verdict === "REUSE_RISK" ? "risk" : "warn", title: KU.reuseTitle, body: I18N.t("The witness index reports repeated use of a one-time key; maximum reported depth: {worstReuse}. Review the affected addresses before further use.", { worstReuse: keyuses.num(r.worstReuse) }),
          blocks: [{ label: KU.causes, body: KU.causesBody }] };   // the advice there is to move, so no keyuses estimate is shown (as the original)
      else if (r.verdict === "RISK_HEURISTIC") out = { tone: "risk", title: KU.riskTitle, body: KU.riskBody, blocks: reco([{ label: KU.causes, body: KU.causesBody }, { label: KU.keyAudit, body: KU.riskBody }]) };
      else out = { tone: r.complete ? "ok" : "warn", title: r.complete ? KU.okTitle : KU.partial, body: r.complete ? KU.explain : KU.incomplete, blocks: reco([]) };
      out.scope = "Checked scope: " + keyuses.num(r.classicKeys) + " classic · " + keyuses.num(r.blockKeys) + " block-based keys held by this node.";
      out.gap = KU.gap;
      return out;
    },
    /** The table's sections (renderKeySections): classic keys, then block keys; empty ones left out; rows numbered inside each. */
    sections: function (r) {
      return [["classic", I18N.t("Classic keys")], ["block", I18N.t("Blocks-as-keyuses keys")]].map(function (g) {
        var rows = r.rows.filter(function (x) { return x.family === g[0]; });
        return { family: g[0], title: g[1] + " · 1–" + rows.length, rows: rows };
      }).filter(function (s) { return s.rows.length; });
    }
  };

  // ---- Minima Explorer (main/explorer.js): how chain data is READ for the screen. Pandamonium's blockexplorer Util + MainActivity. ----
  var digits = function (v) { v = typeof v === "number" && isFinite(v) ? String(v) : v; return typeof v === "string" && /^[0-9]{1,18}$/.test(v) ? v.replace(/^0+(?=\d)/, "") : ""; };
  var explorer = {
    PAGE: 16, FETCH_GAP_MS: 60, MAX_LIVE_GAP: 5,   // MainActivity's constants: blocks per page, the pause between two block reads, the gap above which the list starts again
    /** What the search box holds (MainActivity.doSearch): → { kind: "block" | "txpow" | "address", arg } , { kind: "bad" } or null for nothing typed. */
    classify: function (q) {
      q = text(q); if (!q) return null;
      if (/^[0-9]+$/.test(q)) return q.length > 15 ? { kind: "bad" } : { kind: "block", arg: digits(q) };
      if (/^0x[0-9a-fA-F]+$/.test(q)) return { kind: "txpow", arg: q };          // a TxPoW id or an address: the id is tried first
      if (/^Mx[0-9A-Za-z]+$/.test(q)) return { kind: "address", arg: q };
      return { kind: "bad" };
    },
    /** 1234567 → "1,234,567", from the digits themselves; "" for anything that is not a whole number. */
    groupNum: function (v) { return digits(v).replace(/\B(?=(\d{3})+(?!\d))/g, ","); },
    isMinima: function (tid) { return tid == null || tid === "" || tid === "0x00"; },
    /** Util.tidyAmount: trailing zeros off a decimal string. The node's own digits; no number is made of them. */
    tidyAmount: function (a) {
      a = a == null ? "" : String(a); if (!a) return "0";
      if (a.indexOf(".") < 0) return a;
      a = a.replace(/0+$/, "").replace(/\.$/, "");
      return a || "0";
    },
    /** Util.coinAmount: a token's human figure is `tokenamount`; Minima's is `amount`. */
    coinAmount: function (c) { c = c || {}; return !explorer.isMinima(c.tokenid) && c.tokenamount != null && c.tokenamount !== "" ? explorer.tidyAmount(c.tokenamount) : explorer.tidyAmount(c.amount == null ? "0" : c.amount); },
    /** A coin's token name as its creator wrote it (a string, or an object with a name), or "". Untrusted: the screen shows the token id beside it. */
    tokenName: function (c) { var t = c && c.token, n = t && t.name; n = n && typeof n === "object" ? n.name : n; return typeof n === "string" && n.charAt(0) !== "{" ? n : ""; },
    height: function (txpow) { return digits(txpow && txpow.header && txpow.header.block); },
    timeMilli: function (txpow) { var d = digits(txpow && txpow.header && txpow.header.timemilli); return d ? Number(d) : 0; },
    /** How many transactions a block row counts (BlockAdapter): the list, plus its own when the TxPoW is one. */
    txCount: function (txpow) { var l = txpow && txpow.body && txpow.body.txnlist; return (Array.isArray(l) ? l.length : 0) + (txpow && txpow.istransaction === true ? 1 : 0); },
    /** The BLOCK TIME tile: seconds per block from the node's blocks-per-second figure, cut to one decimal. "" when it was not given. */
    blockTime: function (speed) { var s = Number(speed); if (!(s > 0) || !isFinite(s)) return ""; var t = Math.floor(10 / s); return Math.floor(t / 10) + "." + (t % 10) + " s"; },
    /** The found record's page (showTxpowSmart): a block gets the block page, anything else the transaction page. */
    pageOf: function (txpow) { return txpow && txpow.isblock === true ? "block" : "txn"; },
    /** The confirmations line under a transaction, from the reply to `txpow onchain:` (showTxnDetail). */
    onchain: function (j) {
      var r = j && j.status === true && j.response;
      if (r && r.found === true) return { ok: true, text: I18N.t("✓ on chain · block {block} · confirmations: {confirmations}", { block: (digits(r.block) || "?"), confirmations: (digits(r.confirmations) || "?") }) };
      return { ok: false, text: I18N.t("not found on chain (mempool or pruned)") };
    }
  };

  return { eth: eth, vestr: vestr, shop: shop, ww: ww, keyuses: keyuses, explorer: explorer };
});
