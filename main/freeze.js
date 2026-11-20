/*
 * freeze.js — the Apps tab's Freeze switch (0.19.117), after Pandamonium's (PandamoniumHooks.setIntegratedFrozen):
 * a frozen app does no background work until it is unfrozen, and its data is left exactly as it is.
 *
 *   what Freeze stops       mail      the scan for new mail and the address beacon renewals
 *                           minimall  the scan for orders, payments and messages
 *                           vestr     its block poll
 *                           chat      the message drain and the file transfers' loop
 *                           dexicon   the three trading engines (AtomiX, PandaPools, the Exchange), by the same hold
 *                                     a wallet replacement uses: nothing is published, answered, scanned or signed
 *                           ethwallet, faucet, webwallet   nothing: they do no work while closed (the switch only
 *                                     puts them away)
 *   never frozen            core (the node and the wallet), parlons (the account is part of the node itself)
 *
 * REFUSED WHILE MONEY IS IN FLIGHT. Dexicon is not frozen while a swap, a live market or OTC offer, an unanswered or
 * unsettled Exchange trade, an order with coins behind it, an unconfirmed pool transaction or an open pool of this
 * wallet exists, or while any of that cannot be read: each needs the engine running to be claimed, refunded, voided
 * or kept up. What could not be asked is refused too, and said. (P2P Chance, removed in 0.18.68, has no row: its
 * settle-only loop runs only while a bet is open and is not something to freeze.)
 *
 * The list is kept in the app's config (frozenApps) and honoured at startup: a frozen app's loop is never started
 * (every start site in main.js goes through start(id)), and Dexicon's engines are held before the node is up.
 */
const FREEZABLE = ["mail", "ethwallet", "vestr", "faucet", "minimall", "webwallet", "dexicon", "chat"];
const NEVER = { core: "Minima Core is the node and the wallet. It cannot be frozen.", parlons: "Parlons is part of the node itself: its account runs inside it. It cannot be frozen. Hide takes it out of the drawer." };
const clean = (list) => [...new Set((Array.isArray(list) ? list : []).filter(id => FREEZABLE.includes(id)))];

/** Why Dexicon may not be frozen now: [] = nothing in flight and everything could be read. Pure. */
function dexiconBlockers(w) {
  w = w || {}; const out = [], n = (k, one, many) => (k === 1 ? "1 " + one : k + " " + (many || one + "s"));
  const ax = w.atomix;
  if (!ax) out.push("AtomiX could not be asked about its swaps");
  else {
    const swaps = Array.isArray(ax.swaps) ? ax.swaps.length : 0;
    if (swaps) out.push(n(swaps, "AtomiX swap") + " not finished");
    if (!ax.ready && ax.hasStore && !Array.isArray(ax.swaps)) out.push("AtomiX has not started, so its swaps could not be read");
    if (ax.maker) out.push("your AtomiX market is on the book (withdraw it first)");
    if (ax.otcOffer) out.push("your AtomiX OTC availability is live (withdraw it first)");
    if (ax.otcDeals) out.push(n(ax.otcDeals, "AtomiX OTC deal") + " open");
  }
  const pool = w.pools;
  if (!Array.isArray(pool)) out.push("PandaPools has not started, so its transactions could not be read");
  else { const k = pool.filter(r => r && r.type !== "STATUS" && !r.failed && !r.confirmed && (w.now || Date.now()) - Number(r.ts || 0) < 3600000).length; if (k) out.push(n(k, "pool transaction") + " not confirmed yet"); }
  if (w.ownPools == null) out.push("your pools could not be read");
  else if (w.ownPools.length) out.push(n(w.ownPools.length, "pool") + " of this wallet " + (w.ownPools.length === 1 ? "is" : "are") + " open (the app keeps " + (w.ownPools.length === 1 ? "it" : "them") + " up)");
  const dx = w.dexicon;
  if (dx == null) out.push("the Exchange could not be asked about its trades");
  else {
    if (!dx.ready && dx.hasStore && typeof dx.takes !== "number") out.push("the Exchange has not started, so its trades could not be read");
    if (dx.takes > 0) out.push(n(dx.takes, "Exchange trade") + " sent and not yet answered");
    if (dx.unknown > 0) out.push(n(dx.unknown, "Exchange fill") + " with an outcome not known yet");
    if (dx.pending > 0) out.push(n(dx.pending, "Exchange order") + " waiting for a block");
  }
  if (w.holds == null) { if (!dx || dx.ready || dx.hasStore) out.push("the Exchange's live orders could not be read"); }
  else if (w.holds.length) out.push(n(w.holds.length, "coin") + " behind live Exchange orders or trades (cancel the orders first)");
  return out;
}

/**
 * create({ load() -> saved ids, save(ids), engines: { id: { start(), stop() } }, dexiconWork() -> the object
 * dexiconBlockers reads, log(line) }). An app with no entry in `engines` has no background work.
 */
function create(o) {
  const frozen = new Set(clean(o.load()));
  const log = o.log || (() => {});
  const isFrozen = (id) => frozen.has(id);
  const list = () => [...frozen];
  /** A start site in main.js: runs the app's start unless it is frozen. → whether it ran. */
  function start(id) { if (frozen.has(id)) return false; const e = o.engines[id]; if (e && e.start) e.start(); return true; }
  /** At startup: whatever is frozen and already has something to stop is stopped (Dexicon's hold, before the node is up). */
  async function applyAtStartup() { for (const id of frozen) { const e = o.engines[id]; if (e && e.stop) { try { await e.stop(); } catch (err) {} } } if (frozen.size) log("[app] frozen at startup, no background work: " + list().join(", ")); }
  let turn = Promise.resolve();
  /** Freeze or unfreeze one app. Rejects with the reason, in plain words, when it may not be frozen. → the frozen ids. */
  function set(id, on) {
    const run = async () => {
      id = String(id); on = !!on;
      if (NEVER[id]) throw new Error(NEVER[id]);
      if (!FREEZABLE.includes(id)) throw new Error("Unknown app.");
      if (on === frozen.has(id)) return list();
      const e = o.engines[id];
      if (on) {
        if (id === "dexicon") {
          let why; try { why = dexiconBlockers(await o.dexiconWork()); } catch (err) { why = ["what is in flight could not be read"]; }
          if (why.length) throw new Error("Dexicon is still watching funds in flight. It can be frozen once they settle.\n\n" + why.map(l => "• " + l.charAt(0).toUpperCase() + l.slice(1) + ".").join("\n"));
        }
        frozen.add(id); o.save(list());             // recorded first: a crash while stopping leaves it frozen, never half running
        if (e && e.stop) await e.stop();
        log("[app] " + id + " frozen: its background work is stopped; its data is untouched");
      } else {
        frozen.delete(id); o.save(list());
        if (e && e.start) e.start();
        log("[app] " + id + " unfrozen: its background work goes on");
      }
      return list();
    };
    const p = turn.then(run, run); turn = p.then(() => {}, () => {});   // one at a time: two clicks never interleave a stop and a start
    return p;
  }
  return { isFrozen, list, start, set, applyAtStartup };
}

module.exports = { create, dexiconBlockers, clean, FREEZABLE, NEVER };
