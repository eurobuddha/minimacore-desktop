/*
 * shop-listing.js — what an incoming order is due by the vendor's OWN listing (0.19.166; ported from the released desktop
 * 0.18.159, 1b7f8e8a836e67f7469f65d32e2f6828826129d9, with one change: a currency is named MxUSD or Minima in a problem,
 * never by the wire value "USDT"). An order's items, prices,
 * quantities and total are the buyer's own JSON. The shop the vendor made on this desktop (shop-store) is the
 * listing: every line must be a listed product (same name, and NFT token id / edition / bundle where present), at
 * the listed price, a whole quantity above zero within the listed stock (1 for an edition or a bundle), plus the
 * listed fee of the chosen delivery method, in the shop's currency. Exact decimals in BigInt. Same rule as the
 * phone Inbox (apks/merchinbox Listing.check, 0.5.18).
 *
 * Wire shapes it reads (both buyers): items is an array (this desktop) or a JSON array STRING (the phone's
 * MerchMessage.items); a line is { product, quantity, unitPrice, lineTotal, size?, nftTokenId?, nftStateIdx?,
 * nftBundle? }; shipping is the delivery method's LABEL (this desktop) or its ID (the phone: "domestic", "digital").
 * Every problem is one English sentence; renderer/mainsaid.js lists each (SL_*) so the Inbox says it in the app's language.
 */
"use strict";

// A plain decimal: digits, at most one point with digits after it. → [units, decimals] or null.
function dec(v) {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
  if (typeof s !== "string" || !/^\d{1,30}(\.\d{1,44})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return [BigInt(i + f), f.length];
}
const scale = (d, dp) => d[0] * 10n ** BigInt(dp - d[1]);
const same = (a, b) => { const dp = Math.max(a[1], b[1]); return scale(a, dp) === scale(b, dp); };
function figure(units, dp) { if (!dp) return units.toString(); const t = units.toString().padStart(dp + 1, "0"); return t.slice(0, -dp) + "." + t.slice(-dp); }

/** The order's items as an array, from either wire shape; null when they cannot be read. */
function itemsOf(items) {
  if (Array.isArray(items)) return items;
  if (typeof items === "string" && items.trim()) { try { const a = JSON.parse(items); return Array.isArray(a) ? a : null; } catch (e) { return null; } }
  return null;
}
const tokenOf = (c) => (/^(usdt|mxusdt)$/i.test(String(c)) ? "MXUSD" : /^minima$/i.test(String(c)) ? "MINIMA" : "");
/** A currency as a problem names it: MxUSD or Minima, anything else as it came, in quotes. */
const label = (c) => ({ MXUSD: "MxUSD", MINIMA: "Minima" })[tokenOf(c)] || "\"" + String(c).slice(0, 20) + "\"";
const wholeOf = (v) => (typeof v === "number" ? (Number.isSafeInteger(v) ? v : null) : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : null);

/**
 * check(listing, order) → { due, problems }. listing: the vendor's stored shop (null = not there). order: { items,
 * shipping, currency } as the buyer sent them. due is the recomputed total (a plain decimal string) and is only
 * meaningful when problems is empty.
 */
function check(listing, order) {
  const problems = [];
  if (!listing || !Array.isArray(listing.products)) return { due: "", problems: ["the shop this order names is not one of your shops on this computer"] };
  if (!tokenOf(listing.currency) || tokenOf(order.currency) !== tokenOf(listing.currency))
    problems.push("the order's currency (" + label(order.currency) + ") is not your shop's (" + label(listing.currency) + ")");
  const items = itemsOf(order.items);
  if (!items || !items.length) problems.push("the order has no items that can be read");
  let dp = 0; const lines = [];
  for (const it of items || []) {
    if (!it || typeof it !== "object") { problems.push("an item cannot be read"); continue; }
    const name = String(it.product == null ? "" : it.product), token = String(it.nftTokenId || ""), idx = wholeOf(it.nftStateIdx) || 0, bundle = Number(it.nftBundle) > 0 ? 1 : 0;
    const what = "\"" + name.slice(0, 60) + "\"" + (token ? " (token " + token + (idx > 0 ? " #" + idx : "") + ")" : "");
    const found = listing.products.filter(p => p && String(p.name) === name && String(p.nftTokenId || "").toLowerCase() === token.toLowerCase()
      && (wholeOf(p.nftStateIdx) || 0) === idx && (Number(p.nftBundle) > 0 ? 1 : 0) === bundle);
    if (!found.length) { problems.push(what + " is not in your listing"); continue; }
    if (found.length > 1) { problems.push(what + " is listed more than once"); continue; }
    const p = found[0], q = wholeOf(it.quantity), cap = (bundle || idx > 0) ? 1 : Math.max(1, wholeOf(p.maxUnits) || 10);
    if (!q || q < 1) { problems.push(what + ": the quantity " + String(it.quantity).slice(0, 20) + " is not a whole number above zero"); continue; }
    if (q > cap) { problems.push(what + ": the quantity " + q + " is more than you list (" + cap + ")"); continue; }
    const price = dec(String(p.price)), stated = dec(it.unitPrice == null ? "" : String(it.unitPrice));
    if (!price) { problems.push(what + ": your own price " + String(p.price).slice(0, 40) + " is not a plain number"); continue; }
    if (!stated || !same(stated, price)) { problems.push(what + ": the order's price " + String(it.unitPrice).slice(0, 40) + " is not your price " + p.price); continue; }
    lines.push([price, q]); dp = Math.max(dp, price[1]);
  }
  const ship = String(order.shipping == null ? "" : order.shipping), methods = Array.isArray(listing.shipping) ? listing.shipping : [];
  const m = methods.find(s => s && (String(s.id) === ship || String(s.label) === ship));
  let fee = null;
  if (m) fee = dec(String(m.fee == null || m.fee === "" ? "0" : m.fee));
  else if (!methods.length && (ship === "" || ship === "digital")) fee = [0n, 0];
  if (!fee) problems.push("the delivery method \"" + ship.slice(0, 40) + "\" is not in your listing");
  else dp = Math.max(dp, fee[1]);
  let due = fee ? scale(fee, dp) : 0n;
  for (const [price, q] of lines) due += scale(price, dp) * BigInt(q);
  return { due: figure(due, dp), problems };
}

module.exports = { check, itemsOf };
