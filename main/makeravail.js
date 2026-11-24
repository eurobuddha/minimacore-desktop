"use strict";
/**
 * makeravail.js — what an AtomiX market may be published against, from one balances() read.
 * A balance that could not be READ is not a balance of zero: publishing 0 takes the market off every book (and costs a
 * key use) because of a failed read. strict (publish, save): a failed read THROWS and nothing is published. Not strict
 * (withdraw, currency switch: a tombstone carries no size): a failed read counts as 0, as before, so a withdraw always goes.
 * b: { minima, usdt, minimaErr } as main/atomix.js balances() gives them ("—" = the USDT read failed).
 */
function makerAvailFrom(b, strict) {
  const num = (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null));
  const m = b && !b.minimaErr ? num(b.minima) : null, u = b ? num(b.usdt) : null;
  if (strict && (m === null || u === null)) {
    throw new Error("Your " + (m === null ? "Minima-side" : "USDT") + " balance could not be read just now" + (b && b.minimaErr && m === null ? " (" + b.minimaErr + ")" : "") + ": nothing was published. A market is never published as zero because a read failed; try again in a moment.");
  }
  return { minima: m === null ? 0 : m, usdt: u === null ? 0 : u };
}
module.exports = { makerAvailFrom };
