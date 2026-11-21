/*
 * payverify.js — has a payment that a Mail or Chat message CLAIMS really reached this wallet? (0.19.7)
 *
 * check(): three kinds of read, nothing else: `txpow onchain:<id>` (is it in the chain), `txpow txpowid:<id>` (its
 * outputs), `checkaddress address:<output address>` (is that address this wallet's). "received" only when the
 * outputs of that token id that pay this wallet add up to EXACTLY the claimed amount. Anything else, or any read
 * that fails, is "unverified": never a guess.
 *
 * What it cannot find: a sender whose node mines asynchronously reports the id its transaction had BEFORE mining,
 * which is not the id on chain. Such a payment stays "not verified" here although it arrived; the balance is the truth.
 *
 * create(): the answers, kept for the running node. A payment is looked for when first asked about and again on
 * each new block, at most MAX_TRIES times, one read at a time; at most MAX_TRACKED payments are followed.
 */
const paylabel = require("../renderer/paylabel.js");
const HEX = /^0x[0-9A-Fa-f]{2,130}$/, MAX_OUTPUTS = 64, MAX_ADDRESSES = 16, MAX_TRIES = 12, MAX_TRACKED = 200, SCALE = 44;
/** A decimal amount as an exact integer of 10^-44 units; null when it is not a plain positive decimal. No rounding. */
function units(s) {
  const m = /^([0-9]{1,40})(?:\.([0-9]{1,44}))?$/.exec(String(s == null ? "" : s).trim());
  return m ? BigInt(m[1] + (m[2] || "").padEnd(SCALE, "0")) : null;
}
async function check(p, run) {
  const txid = String((p && p.txid) || ""), tokenid = String((p && p.tokenid) || ""), want = units(p && p.amount);
  if (!HEX.test(txid) || !HEX.test(tokenid) || want === null || want === 0n) return "unverified";
  try {
    const on = await run("txpow onchain:" + txid);
    if (!on || on.status !== true || !on.response || on.response.found !== true) return "unverified";
    const tx = await run("txpow txpowid:" + txid);
    const outs = tx && tx.status === true && tx.response && tx.response.body && tx.response.body.txn && tx.response.body.txn.outputs;
    if (!Array.isArray(outs)) return "unverified";
    const mine = new Map();
    let sum = 0n;
    for (const o of outs.slice(0, MAX_OUTPUTS)) {
      if (!o || String(o.tokenid).toUpperCase() !== tokenid.toUpperCase()) continue;
      const amt = units(tokenid === paylabel.MINIMA ? o.amount : o.tokenamount), addr = String(o.address || "");
      if (amt === null || !/^0x[0-9A-Fa-f]{64}$/.test(addr)) continue;
      if (!mine.has(addr)) {
        if (mine.size >= MAX_ADDRESSES) return "unverified";
        const c = await run("checkaddress address:" + addr);
        mine.set(addr, !!(c && c.status === true && c.response && c.response.relevant === true));
      }
      if (mine.get(addr)) sum += amt;
    }
    return sum === want ? "received" : "unverified";
  } catch (e) { return "unverified"; }
}
/**
 * claims (0.19.238): a payment's txid belongs to the FIRST message that asked about it (persisted: { get(txid), set(txid, id) }).
 * A second message naming the same txid (a peer repeating one real payment) is never "received".
 */
function create({ run, onChange, claims }) {
  const known = new Map();   // key -> { p, status, tries }
  const owners = claims || (() => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; })();
  let chain = Promise.resolve();
  const queued = (fn) => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };   // one read at a time
  async function attempt(e) {
    if (e.status === "received" || e.tries >= MAX_TRIES) return false;
    e.tries++;
    const s = await check(e.p, run);
    if (known.get(e.key) !== e) return false;   // reset meanwhile
    e.status = s;
    return s === "received";
  }
  return {
    /** "received" | "unverified". The first question about a payment looks for it; later ones answer from what is known. */
    ask(p) {
      const tx = String((p && p.txid) || "").toLowerCase(), id = String((p && p.msgid) || "");
      if (!tx || !id) return Promise.resolve("unverified");
      const owner = owners.get(tx);
      if (owner && owner !== id) return Promise.resolve("unverified");   // claimed by an earlier message
      if (!owner) owners.set(tx, id);
      const k = paylabel.key(p && p.txid, p && p.tokenid, p && p.amount);
      let e = known.get(k);
      if (e) return Promise.resolve(e.status);
      if (known.size >= MAX_TRACKED) return Promise.resolve("unverified");
      e = { key: k, p: { txid: p && p.txid, tokenid: p && p.tokenid, amount: p && p.amount }, status: "unverified", tries: 0 };
      known.set(k, e);
      return queued(async () => { await attempt(e); return e.status; });
    },
    /** A new block: look again for what has not been found (within the limit). */
    onBlock() {
      const open = [...known.values()].filter((e) => e.status !== "received" && e.tries < MAX_TRIES);
      if (!open.length) return Promise.resolve(0);
      return queued(async () => { let found = 0; for (const e of open) if (await attempt(e)) found++; if (found && onChange) { try { onChange(); } catch (x) {} } return found; });
    },
    /** Another node start (it may be another wallet): nothing known is carried over. */
    reset() { known.clear(); },
    size: () => known.size
  };
}
module.exports = { check, create, units, MAX_TRIES, MAX_TRACKED };
