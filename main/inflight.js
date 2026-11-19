/*
 * inflight.js — what stopping would interrupt, in plain words. ONE source for the Shutdown warning (the node stops,
 * the app stays: renderer, through mcd:inFlight) and the Quit warning (the app goes: main.js before-quit), so the
 * two cannot disagree (0.18.142). Pure: it is handed what the engines' own activeWork() answered, and decides nothing
 * about them. null always means "could not be asked", and is SAID, never read as idle.
 *
 *   work = { atomix: main/atomix.js activeWork() | null,
 *            pools:  main/pandapools.js activeWork() (the activity rows) | null,
 *            dexicon: main/dexicon.js activeWork() | null,
 *            casino: { offers, bets } | null, casinoOn: is the settle-only loop switched on for this install }
 */
const HOUR = 3600000;

/** "at 14:05", or "at 14:05 on 21 Nov" when that is not today. Local time, 24 h. */
function clock(ms, nowMs) {
  const d = new Date(ms), n = new Date(nowMs), two = (x) => String(x).padStart(2, "0");
  const t = two(d.getHours()) + ":" + two(d.getMinutes());
  return d.toDateString() === n.toDateString() ? t : t + " on " + d.getDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
}

/** how: "quit" (the app closes, and the node with it) or "shutdown" (the node stops, the app stays open). */
function inFlight(work, how, nowMs) {
  work = work || {}; nowMs = nowMs || Date.now();
  const quit = how === "quit", off = quit ? "while the app is closed" : "while the node is stopped", back = quit ? "Open the app again" : "Start the node again";
  const busy = [], unread = [], n = (k, one, many) => (k === 1 ? "1 " + one : k + " " + (many || one + "s"));

  // ---- AtomiX (room 1): swaps, the maker order, OTC ----
  const ax = work.atomix;
  if (!ax) unread.push("AtomiX swaps, market and OTC (AtomiX could not be asked)");
  else if (!ax.ready) { if (ax.hasStore) unread.push("AtomiX swaps, market and OTC (AtomiX has not started" + (ax.error ? ": " + ax.error : "") + ")"); }
  else {
    const k = (ax.swaps || []).length;
    if (k) {
      const at = Number(ax.nearestMs) || 0;
      const when = !at ? "can time out"
        : at <= nowMs ? "can time out: the time limit of " + (k === 1 ? "its lock" : "the first lock") + " has already passed and its refund is waiting to be made"
        : "can time out " + (ax.nearestApprox ? "at about " : "at ") + clock(at, nowMs) + (k === 1 ? "" : " (the first of them)");
      busy.push((k === 1 ? "1 AtomiX swap is" : k + " AtomiX swaps are") + " not finished. A swap in progress cannot settle " + off + " and " + when + ". " + back + " well before then: if the other side completes its part in the meantime, this app must be running to claim yours.");
    }
    if (ax.maker) busy.push("Your AtomiX market is on the book. Its orders stay there, but a swap someone starts against them is not answered " + off + ".");
    if (ax.otcOffer) busy.push("Your AtomiX OTC availability is live. A proposal sent to you is not answered " + off + ".");
    if (ax.otcDeals) busy.push(n(ax.otcDeals, "AtomiX OTC deal") + (ax.otcDeals === 1 ? " is" : " are") + " open and cannot go on " + off + ".");
  }

  // ---- PandaPools (room 2): transactions sent and not confirmed ----
  const pool = work.pools;
  if (!Array.isArray(pool)) unread.push("pool operations (PandaPools has not started)");
  else {
    // ponytail: "recent and not confirmed" stands for pending; an old transaction this node never found stays unconfirmed for good
    const k = pool.filter(r => r && r.type !== "STATUS" && !r.failed && !r.confirmed && nowMs - Number(r.ts || 0) < HOUR).length;
    if (k) busy.push(n(k, "pool transaction") + " sent in the last hour " + (k === 1 ? "is" : "are") + " not confirmed yet. The app cannot check or finish " + (k === 1 ? "it" : "them") + " " + off + ".");
  }

  // ---- Dexicon Exchange (room 3): takes awaiting an answer, fills whose outcome is not known, placements waiting ----
  const dx = work.dexicon;
  if (dx == null) unread.push("Exchange trades waiting for an answer (Dexicon could not be asked)");
  else {
    if (!dx.ready && dx.hasStore && typeof dx.takes !== "number") unread.push("Exchange trades waiting for an answer (Dexicon has not started)");
    if (dx.takes > 0) busy.push((dx.takes === 1 ? "1 Exchange trade is" : dx.takes + " Exchange trades are") + " sent and not yet answered. " + (quit ? "While the app is closed" : "While the node is stopped") + " " + (dx.takes === 1 ? "it" : "they")
      + " cannot be voided, so the other side could still complete " + (dx.takes === 1 ? "it" : "them") + " later at the price you signed. Wait a few minutes until Dexicon, Orders shows no trade waiting.");
    if (dx.unknown > 0) busy.push(n(dx.unknown, "fill") + " of your Exchange orders " + (dx.unknown === 1 ? "has" : "have") + " an outcome that is not known yet (the node did not answer when " + (dx.unknown === 1 ? "it was" : "they were")
      + " posted). The chain decides; the app can only read the answer while it runs.");
    if (dx.pending > 0) busy.push(n(dx.pending, "Exchange order") + (dx.pending === 1 ? " is" : " are") + " still waiting for a block.");
  }

  // ---- P2P Chance (removed in 0.18.68; bets already on the chain are still settled by this app) ----
  const c = work.casino;
  if (c && (c.offers || c.bets)) busy.push("P2P Chance: " + n(c.bets || 0, "bet") + " and " + n(c.offers || 0, "offer") + " still open. They are revealed and paid out only while the app and its node run; a bet that is not settled before its deadline can be claimed by the other side.");
  else if (!c && work.casinoOn) unread.push("P2P Chance bets (not read yet)");

  const lines = busy.slice();
  if (unread.length) lines.push("Could not be checked: " + unread.join("; ") + ". " + (quit ? "If you are not sure nothing is in flight, stay open and look at the Dexicon tab first." : "Look at the Dexicon tab before you shut down."));
  const base = quit ? "The app closes and its node stops. Swaps, pools, orders, mail and chat stop being served until you open it again."
    : "The node stops and this wallet goes offline. Swaps, pools, mail and chat stop being served until you start it again.";
  return { busy, unread, any: lines.length > 0,
    title: busy.length ? (quit ? "Quit with work in flight?" : "Shut down with trades in flight?") : unread.length ? (quit ? "Quit without the check?" : "Shut down the node?") : (quit ? "Quit?" : "Shut down the node?"),
    message: lines.concat(base).join("\n\n") };
}

/**
 * The quit, once. d = { os: the system asked (logout, restart, power off), stopped: the user already shut the node
 * down (that question was asked then; closing the app interrupts nothing more), gather() → work, ask(warning) → true
 * to quit, log(line) }. → true: go on and quit; false: stay open.
 * A user's quit with anything in flight (or anything that could not be checked) is asked first. A quit the SYSTEM
 * asked for is never held behind a question nobody may be there to answer: it goes on, and what was in flight is
 * written to the log. Either way the caller then stops the node through node.stop(), which lets every engine finish
 * what it has at the node within a bound (0.18.117).
 */
async function decideQuit(d) {
  let work = null;
  try { work = await Promise.race([d.gather(), new Promise(r => setTimeout(() => r(null), d.waitMs || 5000))]); } catch (e) { work = null; }
  const w = inFlight(work || {}, "quit", d.now ? d.now() : Date.now()), said = w.busy.concat(w.unread.length ? ["could not be checked: " + w.unread.join("; ")] : []);
  if (d.stopped) { d.log("[app] quit with the node already stopped: no question was shown. " + (said.length ? "Not finished: " + said.join(" | ") : "Nothing was in flight.")); return true; }
  if (d.os) { d.log("[app] quit asked by the system: no question was shown. " + (said.length ? "In flight: " + said.join(" | ") : "Nothing was in flight.")); return true; }
  if (!w.any) return true;
  const go = !!(await d.ask(w));
  d.log("[app] quit asked with work in flight (" + said.join(" | ") + "): the user chose to " + (go ? "quit" : "stay open"));
  return go;
}

module.exports = { inFlight, decideQuit, clock };
