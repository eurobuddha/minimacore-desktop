"use strict";
/**
 * makeravail.js — what an AtomiX market may be published against, from one balances() read.
 * A balance that could not be READ is not a balance of zero: publishing 0 takes the market off every book (and costs a
 * key use) because of a failed read. strict (publish, save): a failed read of a side the ladder USES throws and nothing is
 * published; a side the ladder does not use (an ask-only market has no USDT side) goes as 0 and blocks nothing (0.19.431).
 * Not strict (withdraw, currency switch: a tombstone carries no size): a failed read counts as 0, so a withdraw always goes.
 * b: { minima, usdt, minimaErr } as main/atomix.js balances() gives them ("—" = the USDT read failed).
 */
function makerAvailFrom(b, strict, needs) {
  const num = (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null));
  const m = b && !b.minimaErr ? num(b.minima) : null, u = b ? num(b.usdt) : null;
  const need = needs || { minima: true, usdt: true }, noM = m === null && need.minima, noU = u === null && need.usdt;
  if (strict && (noM || noU)) {
    throw new Error("Your " + (noM ? "Minima-side" : "USDT") + " balance could not be read just now" + (b && b.minimaErr && noM ? " (" + b.minimaErr + ")" : "") + ": nothing was published. A market is never published as zero because a read failed; try again in a moment.");
  }
  return { minima: m === null ? 0 : m, usdt: u === null ? 0 : u };
}
/**
 * Which balances a maker's ladder is published against: asks sell the Minima-side coin, bids pay USDT. Read as the engine reads
 * the config (main/atomix/lib/maker.js pegCfg, lib/peg.js applyPeg: a pegged side with size 0 is not published; askSize and
 * bidSize fall back to size) and the manual ladder (levels with an amount). A ladder with no side at all asks for both, as before.
 */
function ladderNeeds(cfg, manual) {
  const n = (v, d) => { const x = v == null || v === "" ? d : Number(v); return Number.isFinite(x) ? x : d; };
  const c = cfg || {}, man = manual || {}, has = (l) => Array.isArray(l) && l.some((x) => x && Number(x.a) > 0);
  const size = n(c.size, 0), asks = c.pegEnable ? n(c.askSize, size) > 0 : has(man.asks), bids = c.pegEnable ? n(c.bidSize, size) > 0 : has(man.bids);
  return asks || bids ? { minima: asks, usdt: bids } : { minima: true, usdt: true };
}
/**
 * Save a maker's order and publish it: the balances are read FIRST, and a refused read stores nothing (0.19.431: the config was
 * stored before the read, so a refused Save still left the new order saved, for the keep-alive to publish later).
 * io = { read() → balances, save(), publish(avail) }.
 */
async function saveThenPublish(io, cfg, manual) {
  const avail = makerAvailFrom(await io.read(), true, ladderNeeds(cfg, manual));
  await io.save();
  return io.publish(avail);
}
module.exports = { makerAvailFrom, ladderNeeds, saveThenPublish };
