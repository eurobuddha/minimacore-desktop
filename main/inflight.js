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

/** "at 14:05", or "at 14:05 on 21 Nov" when that is not today. Local time, 24 h. t: the translator of the warning (English when none). */
function clock(ms, nowMs, t) {
  const d = new Date(ms), n = new Date(nowMs), two = (x) => String(x).padStart(2, "0"), say = t || EN;
  const hm = two(d.getHours()) + ":" + two(d.getMinutes());
  return d.toDateString() === n.toDateString() ? hm : say("{time} on {day} {month}", { time: hm, day: d.getDate(), month: say(I18N.MONTHS[d.getMonth()]) });
}

// The words come from the shared catalog (renderer/i18n.js). EN says them in English whatever the app's language: for
// the log on disk, and when no translator is passed. The counts are plural keys (renderer/i18n/en.js holds "1 … is").
const I18N = require("../renderer/i18n.js"); require("../renderer/i18n/en.js");
const EN = I18N.tIn("en");

/** how: "quit" (the app closes, and the node with it) or "shutdown" (the node stops, the app stays open). */
function inFlight(work, how, nowMs, t) {
  work = work || {}; nowMs = nowMs || Date.now(); t = t || EN;   // t: the translator of the language to say it in (English when none is given: the log, the tests)
  const quit = how === "quit", off = quit ? t("while the app is closed") : t("while the node is stopped"), back = quit ? t("Open the app again") : t("Start the node again");
  const busy = [], unread = [];

  // ---- AtomiX (room 1): swaps, the maker order, OTC ----
  const ax = work.atomix;
  if (!ax) unread.push(t("AtomiX swaps, market and OTC (AtomiX could not be asked)"));
  else if (!ax.ready) { if (ax.hasStore) unread.push(t("AtomiX swaps, market and OTC (AtomiX has not started{why})", { why: ax.error ? ": " + ax.error : "" })); }
  else {
    const k = (ax.swaps || []).length;
    if (k) {
      const at = Number(ax.nearestMs) || 0;
      const when = !at ? t("can time out")
        : at <= nowMs ? (k === 1 ? t("can time out: the time limit of its lock has already passed and its refund is waiting to be made") : t("can time out: the time limit of the first lock has already passed and its refund is waiting to be made"))
        : (ax.nearestApprox ? t("can time out at about {time}", { time: clock(at, nowMs, t) }) : t("can time out at {time}", { time: clock(at, nowMs, t) })) + (k === 1 ? "" : " " + t("(the first of them)"));
      busy.push(t("{n} AtomiX swaps are not finished. A swap in progress cannot settle {off} and {when}. {back} well before then: if the other side completes its part in the meantime, this app must be running to claim yours.", { n: k, off, when, back }));
    }
    if (ax.maker) busy.push(t("Your AtomiX market is on the book. Its orders stay there, but a swap someone starts against them is not answered {off}.", { off }));
    if (ax.otcOffer) busy.push(t("Your AtomiX OTC availability is live. A proposal sent to you is not answered {off}.", { off }));
    if (ax.otcDeals) busy.push(t("{n} AtomiX OTC deals are open and cannot go on {off}.", { n: ax.otcDeals, off }));
  }

  // ---- PandaPools (room 2): transactions sent and not confirmed ----
  const pool = work.pools;
  if (!Array.isArray(pool)) unread.push(t("pool operations (PandaPools has not started)"));
  else {
    // ponytail: "recent and not confirmed" stands for pending; an old transaction this node never found stays unconfirmed for good
    const k = pool.filter(r => r && r.type !== "STATUS" && !r.failed && !r.confirmed && nowMs - Number(r.ts || 0) < HOUR).length;
    if (k) busy.push(t("{n} pool transactions sent in the last hour are not confirmed yet. The app cannot check or finish them {off}.", { n: k, off }));
  }

  // ---- Dexicon Exchange (room 3): takes awaiting an answer, fills whose outcome is not known, placements waiting ----
  const dx = work.dexicon;
  if (dx == null) unread.push(t("Exchange trades waiting for an answer (Dexicon could not be asked)"));
  else {
    if (!dx.ready && dx.hasStore && typeof dx.takes !== "number") unread.push(t("Exchange trades waiting for an answer (Dexicon has not started)"));
    if (dx.takes > 0) busy.push(quit
      ? t("{n} Exchange trades are sent and not yet answered. While the app is closed they cannot be voided, so the other side could still complete them later at the price you signed. Wait a few minutes until Dexicon, Orders shows no trade waiting.", { n: dx.takes })
      : t("{n} Exchange trades are sent and not yet answered. While the node is stopped they cannot be voided, so the other side could still complete them later at the price you signed. Wait a few minutes until Dexicon, Orders shows no trade waiting.", { n: dx.takes }));
    if (dx.unknown > 0) busy.push(t("{n} fills of your Exchange orders have an outcome that is not known yet (the node did not answer when they were posted). The chain decides; the app can only read the answer while it runs.", { n: dx.unknown }));
    if (dx.pending > 0) busy.push(t("{n} Exchange orders are still waiting for a block.", { n: dx.pending }));
  }

  // ---- P2P Chance (removed in 0.18.68; bets already on the chain are still settled by this app) ----
  const c = work.casino;
  if (c && (c.offers || c.bets)) busy.push(t("P2P Chance: {bets} and {offers} still open. They are revealed and paid out only while the app and its node run; a bet that is not settled before its deadline can be claimed by the other side.", { bets: t("{n} bets", { n: c.bets || 0 }), offers: t("{n} offers", { n: c.offers || 0 }) }));
  else if (!c && work.casinoOn) unread.push(t("P2P Chance bets (not read yet)"));

  const lines = busy.slice();
  if (unread.length) lines.push(t("Could not be checked: {what}. {advice}", { what: unread.join("; "), advice: quit ? t("If you are not sure nothing is in flight, stay open and look at the Dexicon tab first.") : t("Look at the Dexicon tab before you shut down.") }));
  const base = quit ? t("The app closes and its node stops. Swaps, pools, orders, mail and chat stop being served until you open it again.")
    : t("The node stops and this wallet goes offline. Swaps, pools, mail and chat stop being served until you start it again.");
  return { busy, unread, any: lines.length > 0,
    title: busy.length ? (quit ? t("Quit with work in flight?") : t("Shut down with trades in flight?")) : unread.length ? (quit ? t("Quit without the check?") : t("Shut down the node?")) : (quit ? t("Quit?") : t("Shut down the node?")),
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
  const at = d.now ? d.now() : Date.now(), w = inFlight(work || {}, "quit", at, d.t), en = d.t ? inFlight(work || {}, "quit", at) : w;   // w: what is asked, in the user's language; en: the same facts in English, for the log
  const said = en.busy.concat(en.unread.length ? ["could not be checked: " + en.unread.join("; ")] : []);
  if (d.stopped) { d.log("[app] quit with the node already stopped: no question was shown. " + (said.length ? "Not finished: " + said.join(" | ") : "Nothing was in flight.")); return true; }
  if (d.os) { d.log("[app] quit asked by the system: no question was shown. " + (said.length ? "In flight: " + said.join(" | ") : "Nothing was in flight.")); return true; }
  if (!w.any) return true;
  const go = !!(await d.ask(w));
  d.log("[app] quit asked with work in flight (" + said.join(" | ") + "): the user chose to " + (go ? "quit" : "stay open"));
  return go;
}

/**
 * "The system asked this app to quit" (logout, restart, power off), true for a while after the system said so and
 * then no longer (0.19.103). It used to be a flag that stayed set for the rest of the session: a shutdown the user
 * CANCELLED (macOS asks every app first, and any app may refuse) left it set, and every later Quit went through with
 * no question, whatever was in flight. A real shutdown ends the app well inside the minute.
 */
function recently(ms = 60000, now = Date.now) { let at = 0; return { mark() { at = now(); }, on: () => at > 0 && now() - at < ms }; }

module.exports = { inFlight, decideQuit, clock, recently };
