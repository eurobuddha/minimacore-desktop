/*
 * stopguard.js — one guard in the main process in front of every node stop or restart (0.18.223, as Pandamonium Desktop
 * 0.19.268 / 0.19.283 / 0.19.287 / 0.19.294, adapted): the tray's Restart node, the Node tab's Restart and Reclaim, the node
 * kind (both switches), Save & Restart from the setup screen, Contribute, the Web Wallet's "Enable MegaMMR & restart node",
 * a Chat backup restore, and the Terminal commands that end by stopping the node. None of them asked anything before.
 *
 * This desktop shows no in-flight warning in the window, so there is no acknowledgement to hand on: with the node running and
 * anything in flight or not checkable, main asks its own question (a message box: Stop the node anyway / Keep it running),
 * logs the answer, and on a no the stop is refused ("The node keeps running: nothing was stopped."). What is in flight comes
 * from the engines' own read models (main/atomix.js activeWork, main/pandapools.js activeWork); null always means "could not
 * be asked", and is SAID, never read as idle. Pure: no electron; scripts/stopguard-test.cjs runs it.
 *
 *   work = { atomix: activeWork() | null, pools: activity rows | null, shop: payments at the node }
 */
"use strict";
const V = require("./cmdverb");
const HOUR = 3600000;

/** "14:05", or "14:05 on 21 Nov" when that is not today. Local time, 24 h. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function clock(ms, nowMs) {
  const d = new Date(ms), n = new Date(nowMs), two = (x) => String(x).padStart(2, "0"), hm = two(d.getHours()) + ":" + two(d.getMinutes());
  return d.toDateString() === n.toDateString() ? hm : hm + " on " + d.getDate() + " " + MONTHS[d.getMonth()];
}

/** What stopping the node now would interrupt, in plain words. → { busy, unread, any, title, message }. */
function inFlight(work, nowMs) {
  work = work || {}; nowMs = nowMs || Date.now();
  const busy = [], unread = [];
  const ax = work.atomix;
  if (!ax) unread.push("AtomiX swaps, market and OTC (AtomiX could not be asked)");
  else if (!ax.ready) { if (ax.hasStore) unread.push("AtomiX swaps, market and OTC (AtomiX has not started)"); }
  else {
    const k = (ax.swaps || []).length;
    if (k) {
      const at = Number(ax.nearestMs) || 0;
      const when = !at ? "can time out"
        : at <= nowMs ? "can time out: the time limit of " + (k === 1 ? "its lock" : "the first lock") + " has already passed and its refund is waiting to be made"
        : "can time out at " + (ax.nearestApprox ? "about " : "") + clock(at, nowMs) + (k === 1 ? "" : " (the first of them)");
      busy.push((k === 1 ? "1 AtomiX swap is" : k + " AtomiX swaps are") + " not finished. A swap in progress cannot settle while the node is stopped and " + when + ". Start the node again well before then: if the other side completes its part in the meantime, this app must be running to claim yours.");
    }
    if (ax.maker) busy.push("Your AtomiX market is on the book. Its orders stay there, but a swap someone starts against them is not answered while the node is stopped.");
    if (ax.otcOffer) busy.push("Your AtomiX OTC availability is live. A proposal sent to you is not answered while the node is stopped.");
    if (ax.otcDeals) busy.push((ax.otcDeals === 1 ? "1 AtomiX OTC deal is" : ax.otcDeals + " AtomiX OTC deals are") + " open and cannot go on while the node is stopped.");
  }
  const pool = work.pools;
  if (!Array.isArray(pool)) unread.push("pool operations (PandaPools could not be asked)");   // not started, failed or late: all the same to the question (0.18.268)
  else {
    // ponytail: "recent and not confirmed" stands for pending; an old transaction this node never found stays unconfirmed for good
    const k = pool.filter(r => r && r.type !== "STATUS" && !r.failed && !r.confirmed && nowMs - Number(r.ts || 0) < HOUR).length;
    if (k) busy.push((k === 1 ? "1 pool transaction" : k + " pool transactions") + " sent in the last hour " + (k === 1 ? "is" : "are") + " not confirmed yet. The app cannot check or finish them while the node is stopped.");
  }
  if (work.shop > 0) busy.push("A miniMall payment is being sent to the node. Stopped now, it may or may not go through: wait for its answer, then look at the order.");
  const lines = busy.slice();
  if (unread.length) lines.push("Could not be checked: " + unread.join("; ") + ".");
  return { busy, unread, any: lines.length > 0,
    title: busy.length ? "Stop the node with work in flight?" : "Stop the node without the check?",
    message: lines.concat("The node stops and this wallet goes offline. Swaps, pools, mail and chat stop being served until it runs again.").join("\n\n") };
}

/**
 * The guard. d = { running(), gather() → work, ask(w) → true to stop, log(line), now(), waitMs }. pass() → true: go on; false: the
 * user kept it running; "busy": another stop is being asked about or was let go and the node has not stopped yet (0.18.253: two
 * requests at once showed two questions and gave two stops). seen(state): the node's state, so a stop that happened ends the hold;
 * release(): the caller's operation failed without stopping the node, so the hold ends too (0.18.257).
 * With the node not running nothing is asked; with nothing in flight and everything checked nothing is asked.
 */
const HOLD_MS = 30000;
function stopGuard(d) {
  const now = d.now || Date.now;
  let asking = false, wentAt = 0, holder = 0, stamps = 0;
  return {
    seen(state) { if (state !== "running") wentAt = 0; },
    // what the yes was for failed without stopping the node (0.18.257): a retry is asked again. Only the stop that took the hold
    // can end it (0.18.266): release(stamp) with the stamp pass() gave it; any other stamp, or none, changes nothing
    release(stamp) { if (stamp && stamp === holder) wentAt = 0; },
    /** → a stamp (a number above 0: go on, and this call holds the guard), true (go on, no hold: the node is not running), false
     *  (the user kept it running) or "busy". */
    async pass() {
      if (!d.running()) return true;
      if (asking || (wentAt && now() - wentAt < HOLD_MS)) return "busy";
      asking = true;
      try { const go = await this.ask(); if (!go) return false; wentAt = now(); holder = ++stamps; return holder; } finally { asking = false; }
    },
    async ask() {
      let work = null;
      try { work = await Promise.race([d.gather(), new Promise(r => setTimeout(() => r(null), d.waitMs || 5000))]); } catch (e) { work = null; }
      const w = inFlight(work || {}, now());
      if (!w.any) return true;
      const go = !!(await d.ask(w));
      d.log("[app] node stop asked with work in flight (" + w.busy.concat(w.unread.length ? ["could not be checked: " + w.unread.join("; ")] : []).join(" | ") + "): the user chose to " + (go ? "stop it" : "keep it running"));
      return go;
    }
  };
}

// The Terminal commands that end by stopping the node (read from core/minima-core commands: every shutdownFinalProcs /
// NotifyMainListenerOfShutDown / Main.shutdown): quit; archive resync, and import / importold / importraw (they run a resync);
// reset chainsync / seedsync / restore (they run an archive import); mysql resync, and reset (it runs a resync); megammr import;
// megammrsync resync; restore and restoresync; vault resetkeys. The verb and the action are read as the node reads them
// (main/cmdverb.js), the action folded (over-guards).
const STOPS = { quit: () => true, archive: (a) => /^(resync|import|importold|importraw)$/.test(a), reset: (a) => /^(chainsync|seedsync|restore)$/.test(a),
  mysql: (a) => /^(resync|reset)$/.test(a), megammr: (a) => a === "import", megammrsync: (a) => a === "resync", restore: () => true, restoresync: () => true, vault: (a) => a === "resetkeys" };
/** Does this node command (or any ;-separated part of it) stop the node? */
function stopsNode(command) {
  return V.parts(command).some(part => { const a = V.fold(V.paramValue(part, "action") || ""); return Object.keys(STOPS).some(v => V.is(part, v) && STOPS[v](a)); });
}

module.exports = { inFlight, stopGuard, stopsNode, clock };
