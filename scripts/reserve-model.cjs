/*
 * reserve-model.cjs — a model of the node's coin set for the coin reservation tests (scripts/reserve-test.cjs).
 * In memory only: unspent coins, a mempool, the node's transaction builder, `send` and `consolidate` choosing coins
 * as core does (send: the smallest coin that covers, else the largest first, inside fromaddress: when given;
 * consolidate: the largest). run(cmd) answers in the node's own shapes and records every command in `seen`.
 */
const lc = (s) => String(s).toLowerCase();
const P = (c, k) => { const m = new RegExp("(?:^|\\s)" + k + ":(\\S+)", "i").exec(c); return m ? m[1] : ""; };
const coinId = (n) => "0x" + String(n).padStart(64, "0").toUpperCase();
const ADDR = (n) => "0x" + String(n).padStart(64, "A");
const MXUSD = "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90";

function makeNode(list) {
  const coins = new Map(), mempool = new Map(), txns = new Map(), seen = [];
  let block = 1000, next = 900000, down = false;
  const add = (c) => { const x = Object.assign({ tokenid: "0x00", simple: true, state: [], created: String(block - 10), spent: false }, c); coins.set(lc(x.coinid), x); return x; };
  (list || []).forEach(add);
  const row = (x) => { const r = { coinid: x.coinid, amount: x.amount, address: x.address, tokenid: x.tokenid, state: x.state, created: x.created, spent: false }; if (x.tokenid !== "0x00") r.tokenamount = x.amount; return r; };
  const spendable = (x) => x.simple && !mempool.has(lc(x.coinid));
  function pick(tok, need, from) {
    const c = [...coins.values()].filter(x => lc(x.tokenid) === lc(tok) && spendable(x) && (!from || lc(x.address) === lc(from)));
    const cover = c.filter(x => Number(x.amount) >= need).sort((a, b) => Number(a.amount) - Number(b.amount))[0];
    if (cover) return [cover];
    const out = []; let sum = 0;
    for (const x of c.sort((a, b) => Number(b.amount) - Number(a.amount))) { out.push(x); sum += Number(x.amount); if (sum >= need) return out; }
    return null;
  }
  async function run(cmd) {
    const c = String(cmd), v = lc((/^\s*(\w+)/.exec(c) || [])[1]);
    seen.push(c);
    if (down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const ok = (response) => ({ command: v, status: true, pending: false, response });
    const no = (error) => ({ command: v, status: false, pending: false, error });
    if (v === "block") return ok({ block: String(block) });
    if (v === "seedrandom") return ok({ seedrandom: "0x" + "AB".repeat(32) });
    if (v === "coins") {
      let r = [...coins.values()];
      if (P(c, "coinid")) r = r.filter(x => lc(x.coinid) === lc(P(c, "coinid")));
      if (P(c, "tokenid")) r = r.filter(x => lc(x.tokenid) === lc(P(c, "tokenid")));
      if (P(c, "address")) r = r.filter(x => lc(x.address) === lc(P(c, "address")));
      if (/\bsendable:true/.test(c)) r = r.filter(x => x.simple);
      if (/\bcheckmempool:true/.test(c)) r = r.filter(x => !mempool.has(lc(x.coinid)));
      return ok(r.map(row));
    }
    if (v === "checkaddress") return ok({ simple: true });
    if (v === "txncreate") { txns.set(P(c, "id"), { inputs: [] }); return ok({}); }
    if (v === "txninput") { const t = txns.get(P(c, "id")), x = coins.get(lc(P(c, "coinid"))); if (!t) return no("no such transaction"); if (!x) return no("coin not found"); t.inputs.push(lc(x.coinid)); return ok({}); }
    if (v === "txnoutput" || v === "txnstate" || v === "txnsign" || v === "txnbasics") return txns.has(P(c, "id")) ? ok({}) : no("no such transaction");
    if (v === "txncheck") return ok({ valid: { basic: true, scripts: true, mmrproofs: true }, validamounts: true, allsignaturesvalid: true, validtransaction: true });
    if (v === "txnpost") {
      const t = txns.get(P(c, "id")); if (!t) return no("no such transaction");
      for (const k of t.inputs) if (!coins.has(k) || mempool.has(k)) return no("input already spent");
      for (const k of t.inputs) mempool.set(k, P(c, "id"));
      if (/\btxndelete:true/.test(c)) txns.delete(P(c, "id"));
      return ok({ txpowid: coinId(next++) });
    }
    if (v === "txndelete") { txns.delete(P(c, "id")); return ok({}); }
    if (v === "send") {
      const tok = P(c, "tokenid") || "0x00", need = Number(P(c, "amount")), got = pick(tok, need, P(c, "fromaddress"));
      if (!got) return no("Insufficient funds");
      for (const x of got) mempool.set(lc(x.coinid), "send");
      return ok({ txpowid: coinId(next++), inputs: got.map(x => x.coinid) });
    }
    if (v === "consolidate") {
      const tok = P(c, "tokenid"), got = [...coins.values()].filter(x => lc(x.tokenid) === lc(tok) && spendable(x)).sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 20);
      if (got.length < 2) return no("Not enough coins");
      if (!/\bdryrun:true/.test(c)) for (const x of got) mempool.set(lc(x.coinid), "consolidate");
      return ok({ inputs: got.map(x => x.coinid) });
    }
    return ok({});
  }
  return {
    run, seen, coins, mempool, add,
    /** A block: everything in the mempool is spent. */
    mine(n) { for (const k of mempool.keys()) coins.delete(k); mempool.clear(); block += n || 1; },
    /** The mempool forgets a transaction that never mined (its inputs are unspent again). */
    dropMempool() { mempool.clear(); },
    /** Spent by something that is not this app (a phone on the same node). */
    spendOutside(id) { coins.delete(lc(id)); },
    tick(n) { block += n || 1; }, block: () => block, setDown(v) { down = !!v; },
    saw: (re) => seen.filter(s => re.test(s))
  };
}
/** A builder as every engine's is: one command at a time, txndelete on the first failure. Resolves { ok, error, posted }. */
async function build(run, id, coinIds, opts) {
  const steps = ["txncreate id:" + id].concat(coinIds.map(c => "txninput id:" + id + " coinid:" + c), ["txnoutput id:" + id + " amount:1 address:" + ADDR(9), "txnsign id:" + id + " publickey:auto"]);
  for (const s of steps) { const r = await run(s); if (!r || r.status !== true) { await run("txndelete id:" + id); return { ok: false, error: r && r.error }; } }
  if (opts && opts.noPost) return { ok: true };
  const p = await run("txnpost id:" + id);
  if (!(opts && opts.keep)) await run("txndelete id:" + id);
  return { ok: !!(p && p.status === true), error: p && p.error, posted: p };
}
module.exports = { makeNode, build, coinId, ADDR, MXUSD };
