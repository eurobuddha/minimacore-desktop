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
 *                           ethwallet, explorer, entropy, keyuses, faucet, webwallet   nothing: they do no work while closed (the switch only
 *                                     puts them away)
 *   never frozen            core (the node and the wallet), parlons (the account is part of the node itself)
 *
 * REFUSED WHILE MONEY IS IN FLIGHT. Dexicon is not frozen while a swap, a live market or OTC offer, an unanswered or
 * unsettled Exchange trade, an order with coins behind it, an unconfirmed pool transaction or an open pool of this
 * wallet exists, or while any of that cannot be read: each needs the engine running to be claimed, refunded, voided
 * or kept up. What could not be asked is refused too, and said. (P2P Chance, removed in 0.18.68, has no row: its
 * settle-only loop runs only while a bet is open and is not something to freeze.)
 *
 * FREEZING DEXICON, IN ORDER (0.19.119): the engines are held first (`gate`: nothing new can start), THEN what is in
 * flight is read, within five seconds; anything in flight, unreadable or late releases the hold and refuses. A swap
 * started a moment before the click is therefore either seen or never started. An engine that has a store and has
 * not started is "could not be read", as main/inflight.js has it. If stopping fails, the freeze is undone (not frozen,
 * not saved, hold released) and the failure is thrown, so the screen and the saved state agree.
 *
 * A WALLET REPLACEMENT HOLDS THE SAME ENGINES. While one runs (`replacing()`), Dexicon is not frozen (refused, with the
 * reason), and unfreezing does not release the engines: the replacement's own settle does (node-manager walletSettle
 * and runResync call onEnginesRelease, which no longer finds Dexicon frozen), and `settle()`, asked at every node status,
 * releases them when the replacement let go before the unfreeze reached it.
 *
 * ONE START AT A TIME. A start site may be asked on every node status: a start still running is not started again,
 * a freeze waits for it to end (its timer is then there to be stopped), and a start that FAILED (a locked
 * node) is not tried again until the node next starts (`nodeStopped()`) or the app is unfrozen by hand.
 *
 * The list is kept in the app's config (frozenApps) and honoured at startup: a frozen app's loop is never started
 * (every start site in main.js goes through start(id)), and Dexicon's engines are held before the node is up.
 */
const FREEZABLE = ["mail", "ethwallet", "explorer", "vestr", "entropy", "keyuses", "faucet", "minimall", "webwallet", "dexicon", "chat"];
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
    if (!ax.ready && ax.hasStore) out.push("AtomiX has not started, so its " + (Array.isArray(ax.swaps) ? "market and OTC offers" : "swaps") + " could not be read");   // fail closed: the store may hold what only the running engine can say
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
    if (!dx.ready && dx.hasStore) out.push("the Exchange has not started, so its " + (typeof dx.takes === "number" ? "orders" : "trades") + " could not be read");
    if (dx.takes > 0) out.push(n(dx.takes, "Exchange trade") + " sent and not yet answered");
    if (dx.unknown > 0) out.push(n(dx.unknown, "Exchange fill") + " with an outcome not known yet");
    if (dx.pending > 0) out.push(n(dx.pending, "Exchange order") + " waiting for a block");
  }
  if (w.holds == null) { if (!dx || dx.ready || dx.hasStore) out.push("the Exchange's live orders could not be read"); }
  else if (w.holds.length) out.push(n(w.holds.length, "coin") + " behind live Exchange orders or trades (cancel the orders first)");
  return out;
}

const READ_MS = 5000, LATE = new Error("late");
/** p, or a rejection with LATE after ms. The read itself is left to end by itself: it holds nothing. */
function timed(p, ms) { let t; return Promise.race([Promise.resolve(p), new Promise((_, no) => { t = setTimeout(() => no(LATE), ms); })]).finally(() => clearTimeout(t)); }
const plural = (l) => l.map(x => "• " + x.charAt(0).toUpperCase() + x.slice(1) + ".").join("\n");

/**
 * create({ load() -> saved ids, save(ids), engines: { id: { start(), stop()[, gate()] } }, dexiconWork() -> the object
 * dexiconBlockers reads, replacing() -> a wallet replacement is holding the trading engines, readMs, log(line) }).
 * An app with no entry in `engines` has no background work. start() may return a promise; gate() takes the hold that
 * stops anything new from starting while what is in flight is read.
 */
function create(o) {
  const frozen = new Set(clean(o.load()));
  const log = o.log || (() => {});
  const isFrozen = (id) => frozen.has(id);
  const list = () => [...frozen];
  const replacing = () => { try { return !!(o.replacing && o.replacing()); } catch (e) { return true; } };
  const starting = {}, failed = new Set();   // id -> a start still running; ids whose last start failed
  /** Run the app's start, once at a time (a freeze waits for it, below). Failed: remembered. */
  function begin(id) {
    const e = o.engines[id]; if (!e || !e.start) return;
    if (starting[id]) return starting[id];
    let p; try { p = Promise.resolve(e.start()); } catch (err) { p = Promise.reject(err); }
    return (starting[id] = p.then(() => {},
      (err) => { failed.add(id); log("[app] " + id + " could not start its background work (" + ((err && err.message) || err) + "); it is tried again when the node next starts"); })
      .catch(() => {}).finally(() => { delete starting[id]; }));
  }
  /** Unfreeze, or undo a hold: start again. Not Dexicon's engines while a wallet replacement holds them: its settle releases them. */
  let owed = false;   // Dexicon was unfrozen while a wallet replacement held its engines
  function thaw(id) { failed.delete(id); if (id === "dexicon" && replacing()) { owed = true; log("[app] dexicon: the wallet is being replaced, so its engines start when that has settled"); return; } begin(id); }
  /** Asked at every node status: the replacement has let go. Its own settle has released the engines, unless it did so
   *  while Dexicon was still frozen, or held nothing (a plain resync): then they are released here. Releasing twice does nothing. */
  function settle() { if (!owed || replacing()) return; owed = false; if (!frozen.has("dexicon")) begin("dexicon"); }
  /** A start site in main.js: runs the app's start unless it is frozen, already starting, or failed since the node started. → whether it was asked. */
  function start(id) { if (frozen.has(id) || failed.has(id)) return false; begin(id); return true; }
  /** The node stopped: a start that failed is tried again with the next node. */
  function nodeStopped() { failed.clear(); }
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
        if (starting[id]) await starting[id];       // a start still running ends first: its timer is then there to be stopped
        if (id === "dexicon") {
          if (replacing()) throw new Error("The wallet is being replaced, and Dexicon's engines are stopped for it. Dexicon can be frozen once that has finished.");
          let why, gated = false;
          try { if (e && e.gate) { gated = true; await e.gate(); } why = dexiconBlockers(await timed(o.dexiconWork(), o.readMs || READ_MS)); }
          catch (err) { why = [err === LATE ? "what is in flight could not be read in time" : "what is in flight could not be read"]; }
          if (why.length) { if (gated) thaw(id); throw new Error("Dexicon is still watching funds in flight. It can be frozen once they settle.\n\n" + plural(why)); }
        }
        frozen.add(id); o.save(list());             // recorded first: a crash while stopping leaves it frozen, never half running
        try { if (e && e.stop) await e.stop(); }
        catch (err) {                               // not stopped: not frozen, not saved, the hold released
          frozen.delete(id); o.save(list()); thaw(id);
          log("[app] " + id + " could not be stopped, so it is not frozen: " + ((err && err.message) || err));
          throw new Error("It could not be stopped, so it is not frozen (" + ((err && err.message) || err) + "). It is running as before.");
        }
        log("[app] " + id + " frozen: its background work is stopped; its data is untouched");
      } else {
        frozen.delete(id); o.save(list());
        thaw(id);
        log("[app] " + id + " unfrozen: its background work goes on");
      }
      return list();
    };
    const p = turn.then(run, run); turn = p.then(() => {}, () => {});   // one at a time: two clicks never interleave a stop and a start
    return p;
  }
  return { isFrozen, list, start, set, applyAtStartup, nodeStopped, settle };
}

module.exports = { create, dexiconBlockers, clean, FREEZABLE, NEVER };
