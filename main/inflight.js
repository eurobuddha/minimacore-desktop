/*
 * inflight.js — what stopping would interrupt, in plain words. ONE source for the Shutdown warning (the node stops,
 * the app stays: renderer, through mcd:inFlight) and the Quit warning (the app goes: main.js before-quit), so the
 * two cannot disagree (0.18.142). Pure: it is handed what the engines' own activeWork() answered, and decides nothing
 * about them. null always means "could not be asked", and is SAID, never read as idle.
 *
 *   work = { atomix: main/atomix.js activeWork() | null,
 *            pools:  main/pandapools.js activeWork() (the activity rows) | null,
 *            dexicon: main/dexicon.js activeWork() | null,
 *            futurecash: main/futurecash.js activeWork() | null (absent: not asked) }
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

  // ---- Future Cash Next: collects and sweeps posted or owed (undefined = not asked: no line) ----
  const fc = work.futurecash;
  if (fc === null) unread.push(t("Future Cash Next collects and sweeps (Future Cash Next could not be asked)"));
  else if (fc && !fc.ready) { if (fc.hasStore) unread.push(t("Future Cash Next collects and sweeps (Future Cash Next has not started)")); }
  else if (fc && fc.posted > 0) busy.push(t("{n} Future Cash Next collects or sweeps are under way. {off} the app cannot follow them to their end, and a coin collected onto an at-risk address is not moved to your safe address.", { n: fc.posted, off: quit ? t("While the app is closed") : t("While the node is stopped") }));

  // ---- miniMall: a payment at the node in this process (0.19.288): stopped now, whether it went through is not known ----
  if (work.shop > 0) busy.push(t("A miniMall payment is being sent to the node. Stopped now, it may or may not go through: wait for its answer, then look at the order."));

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
/** gather() within ms, or null; a throw is null; the timer is cleared once it answers (0.19.334: it was left to run out). */
async function bounded(gather, ms) {
  let t = null;
  try { return await Promise.race([Promise.resolve().then(gather), new Promise(r => { t = setTimeout(() => r(null), ms); })]); } catch (e) { return null; } finally { clearTimeout(t); }
}
async function decideQuit(d) {
  let work = null;
  work = await bounded(d.gather, d.waitMs || 5000);
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
 * One guard in MAIN in front of every node stop or restart (0.19.268): the tray's Restart node, Shutdown, Restart, the node
 * kind, Reclaim, the Web Wallet's MegaMMR switch, a Chat backup restore and a Terminal resync. The checks were in the window
 * only, and four paths had none. With the node running and anything in flight or not checkable (inFlight's any), a stop goes
 * on only with a one-time acknowledgement main issued with the warning the window showed (issue(), from mcd:inFlight; used
 * once, for ACK_MS), or after main's own question (d.ask(w), a message box). d = { running(), gather(), ask(w), log(line),
 * t() → the translator of the app's language, now(), waitMs }. pass(ack, action) → true: go on.
 */
const ACK_MS = 120000;
const STOP_BUSY = "The node is already being stopped or restarted, or the question about it is still open. Nothing more was done.", HOLD_MS = 30000;   // the words and the hold of the 0.18 branch (0.18.253)
function stopGuard(d) {
  const acks = new Map(), now = d.now || Date.now; let pending = false, wentAt = 0, holdId = 0, holds = 0;
  const guard = {
    // an ack is for ONE action, named when the warning was asked for (0.19.287: restart, stop, kind): it opens no other stop
    issue(action) { const a = require("crypto").randomBytes(16).toString("hex"); acks.set(a, { until: now() + ACK_MS, action: String(action || "") }); return a; },
    // one at a time (0.19.313): a second stop asked while one is being decided (its check or its question still open) is refused,
    // so two requests at once show one question and give one stop; and after a yes until the node has stopped (0.19.316, as
    // 0.18.253: at most 30 s, ended by the node's status through seen()), so one that comes between the yes and the stop is refused too
    seen(state) { if (state !== "running") wentAt = 0; },
    // what the yes let go failed with the node still running (0.19.319): a retry is asked, not refused. A release names the hold it
    // is for (0.19.322: holding(), read right after the yes): a failure that comes after the hold ran out and ANOTHER request's yes
    // opened a new one no longer ends that one, which would let a third stop through between that yes and its stop
    holding() { return wentAt ? holdId : 0; },
    release(id) { if (id && id === holdId) wentAt = 0; },
    async pass(ack, action) {
      if (!d.running()) return true;
      if (pending || (wentAt && now() - wentAt < HOLD_MS)) throw new Error(STOP_BUSY);
      pending = true;
      try { const go = await decide(ack, action); if (go && d.running()) { wentAt = now(); holdId = ++holds; } return go; } finally { pending = false; }
    }
  };
  async function decide(ack, action) {
      const got = typeof ack === "string" ? acks.get(ack) : undefined; if (got !== undefined) acks.delete(ack);
      for (const [a, e] of acks) if (e.until < now()) acks.delete(a);
      if (!d.running()) return true;
      if (got && got.until >= now() && got.action && got.action === String(action || "")) return true;   // the user saw main's warning for this action and chose to go on
      let work = null;
      work = await bounded(d.gather, d.waitMs || 5000);
      const at = now(), w = inFlight(work || {}, "shutdown", at, d.t ? d.t() : undefined);
      if (!w.any) return true;
      const en = inFlight(work || {}, "shutdown", at), go = !!(await d.ask(w));
      d.log("[app] node stop asked with work in flight (" + en.busy.concat(en.unread.length ? ["could not be checked: " + en.unread.join("; ")] : []).join(" | ") + "): the user chose to " + (go ? "stop it" : "keep it running"));
      return go;
  }
  return guard;
}

/**
 * "The system asked this app to quit" (logout, restart, power off), true for a while after the system said so and
 * then no longer (0.19.103). It used to be a flag that stayed set for the rest of the session: a shutdown the user
 * CANCELLED (macOS asks every app first, and any app may refuse) left it set, and every later Quit went through with
 * no question, whatever was in flight. A real shutdown ends the app well inside the minute.
 */
function recently(ms = 60000, now = Date.now) { let at = 0; return { mark() { at = now(); }, on: () => at > 0 && now() - at < ms }; }

module.exports = { inFlight, decideQuit, stopGuard, clock, recently, ACK_MS };
