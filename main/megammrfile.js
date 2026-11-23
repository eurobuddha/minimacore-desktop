/*
 * megammrfile.js — Backup & Recovery's "Resync from a MegaMMR file" and "Turn MegaMMR off". No electron: main.js gives it the node, the
 * config and the guards (create(d)); scripts/importfile-test.cjs drives it over stand-ins, and it was driven over a real private node.
 *
 * What the node does (core/minima-core, block line 1.1.2.31-euro14):
 *  - `megammr action:import` runs only with -megammr ("MegaMMR not enabled"), and a start WITHOUT -megammr deletes
 *    databases/megammr.mmr (MinimaDB.java loadAllDB). So the setting is saved before every restart of this flow.
 *  - the import reads the file's MegaMMR and the head of its block list, then RESETS the chain (archiveResetReady: the cascade, the
 *    chain tree, the archive and txpow databases; the network, timers and miner stopped) and only then reads the blocks (megammr.java).
 *    A failure after that leaves the node answering but gutted: it is restarted at once, as a light node again when this flow turned
 *    MegaMMR on. The wallet database is never touched (archiveResetReady(false)).
 *  - `megammr action:integrity` reads the WHOLE file with the node's own reader and checks it, changing nothing: the blocks must
 *    follow the MegaMMR (a file whose MegaMMR is newer than its blocks makes a node that says "Your MEGAMMR is BROKEN" at every
 *    start; an export made while the node's block cache was up to 100 s old is one: IBDStore.createComplete), and a truncated file
 *    fails it. It runs before the import, so such a file is refused before anything is reset.
 *  - both print their progress in the node's log (MinimaLogger: "Minima @ <date> <time> [<memory>] : <text>"): STEP below. The import prints
 *    "Streaming IBD.. blocks:n" right before it resets the chain: a failure before that line changed nothing; after it, the chain is gone
 *    until a resync. A finished import prints "All saved.." and "Main Instance Cleared.." and its process exits by itself.
 *
 * THE MARKER (config megammrImport, main/config.js setMegammrImport). Written right before the node is given the import, so a quit or a
 * crash in the middle leaves a trace; cleared only when the import ended well, or stopped before the reset. While it is there (at
 * launch too) the trading engines stay held (main.js onEnginesRelease) and the window shows a banner with Resync node, one press, never
 * by itself. A successful Resync node clears it and releases the engines (resynced()).
 *
 * NO ANSWER IS NOT AN END (M3). The node's answer can take longer than the RPC's one-hour bound (a 1.6 GB file is unmeasured): when the
 * call ends without an answer and the node process is still there, it is not restarted. Its log is followed, the step is shown on
 * screen, and it is given up only after STALL_MS with no new step, or when the node exits.
 *
 * d = { node (state, proc, resyncing, megammrBroken, heapMbNow, kind(), start(), restart(), snapshot(), on/removeListener("line")), config
 *       (load(), save(patch), setMegammrImport(v)), status() → the node's `status` reply, call(cmd) → a node reply, imports
 *       (main/importfile.js create()), mayStop(), held(op), runResync(cmd), work() → restore.activeWorkList, holdEngines(),
 *       releaseEngines(), fs, totalmem(), platform, log(line), sleep(ms), upMs, stallMs }
 */
const F = require("./importfile");

const BUSY = "A resync, an import, a restore or a MegaMMR switch is already running. Wait for it to finish. Nothing was changed.";
const STATUS_UNKNOWN = "The node's status could not be read, so it is not known whether it keeps a MegaMMR. Nothing was changed. Try again in a moment.";
const ENGINES = "The trading engines could not be stopped ({error}), so nothing was imported. Nothing was changed.";
const IMPORT_OPEN = "This import replaces the node's chain and stops the trading engines until it has finished, while work that needs them is still open:\n\n• {items}\n\nNothing was changed. Let these finish or withdraw them, then try again.";
const CHECK_FAILED = "The node read the whole file and refused it: {why}. Nothing was imported, and the node's chain was not touched. Use a complete MegaMMR file exported by a node you trust.";
const CHECK_FAILED_BACK = "The node read the whole file and refused it: {why}. Nothing was imported, and the node's chain was not touched. The node was restarted as it was before (MegaMMR off). Use a complete MegaMMR file exported by a node you trust.";
const FAILED = "The import failed part-way ({why}). The node was restarted. Your wallet and funds were not touched: your keys are in the wallet and your coins are on the chain. Until the node has resynced, its balance can show less than you hold: use Resync node to rebuild the chain from a MegaMMR node.";
// a failure before the node printed "Streaming IBD..": nothing was reset, so nothing is owed (no Resync)
const NOT_STARTED = "The import stopped before the node's chain was touched ({why}). Nothing was imported or reset. The node was restarted. Your wallet and funds were not touched.";
const NOT_STARTED_BACK = "The import stopped before the node's chain was touched ({why}). Nothing was imported or reset. The node was restarted as a light node, as it was before. Your wallet and funds were not touched.";
// MinimaLogger's prefix, then the steps megammr.java (import, integrity) and MegaMMR.java (loading) print
const LOGGER = /^Minima @ [\d/]+ [\d:]+ \[[^\]]*\] : /;
const STEP = /^(Load MegaMMR\.\. |Check IBD\.\.|Now check all coin proofs\.\.|Checking coins @ \d+ \/ \d+|All coins checked \d+ \/ \d+|MegaMMR import pre-flight\.\.|Loading MegaMMR portion\.\.|MegaMMR loading coins\.\. \d+\/\d+|MegaMMR loaded\.\.|Streaming IBD\.\.|IBD blocks processed\.\. \d+\/\d+|System memory clean\.\.|Current (Top Block|Tree Root|MegaMMR Tip) : |Get all your CoinProofs|Transfer your CoinProofs\.\.|All saved\.\.|Main Instance Cleared\.\.)/;
// ponytail: 30 minutes with no new step, fitted to nothing measured (the node's slowest silent stretch is reading a whole 1.6 GB file in
// the integrity check, unmeasured); raise it if a real import is given up while the node is still reading
const STALL_MS = 30 * 60 * 1000;
const FAILED_BACK = "The import failed part-way ({why}). The node was restarted as a light node, as it was before. Your wallet and funds were not touched: your keys are in the wallet and your coins are on the chain. Until the node has resynced, its balance can show less than you hold: use Resync node to rebuild the chain from a MegaMMR node.";

function create(d) {
  const node = d.node;
  let busy = "";
  /** One of these at a time, and none during a resync the node is already running (node-manager runResync). */
  async function exclusive(what, fn) {
    if (busy || node.resyncing) throw new Error(BUSY);
    busy = what; said();
    try { return await fn(); } finally { busy = ""; said(); }
  }
  /** The window disables what would stop or reset the node meanwhile (main.js refuses it anyway): the node's status carries it, the step
   *  the node is at, and the marker. */
  function said() { node.megafileBusy = busy; if (!busy) node.megafileStep = ""; if (typeof node.emit === "function" && typeof node.snapshot === "function") node.emit("status", node.snapshot()); }
  const marker = () => { const m = d.config.load().megammrImport; return m && typeof m === "object" ? m : null; };
  const setMarker = (v) => { d.config.setMegammrImport(v); said(); };
  /** What the node's log says of the command running now (STEP lines only, after the logger's prefix): the last step and when, whether
   *  it reset the chain, finished the check, finished the import. stop() ends the watch. */
  function watch() {
    const w = { at: Date.now(), step: "", reset: false, checked: false, saved: false, oom: false };
    const on = (raw) => {
      const l = String(raw);
      if (/OutOfMemoryError|Java heap space/.test(l)) w.oom = true;   // an uncaught one is printed without the prefix
      const m = LOGGER.exec(l); if (!m) return;
      const text = l.slice(m[0].length); if (!STEP.test(text)) return;
      w.at = Date.now(); w.step = text.slice(0, 160);
      if (/^Streaming IBD/.test(text)) w.reset = true;
      if (/^All coins checked/.test(text)) w.checked = true;
      if (/^(All saved|Main Instance Cleared)/.test(text)) w.saved = true;
      node.megafileStep = w.step; said();
    };
    if (typeof node.on === "function") node.on("line", on);
    w.stop = () => { if (typeof node.removeListener === "function") node.removeListener("line", on); };
    return w;
  }
  /** call(), and when it ends without an answer while the node process is still there: its log is followed until done(w), the node's exit,
   *  or STALL_MS with no new step. Never restarts anything. → the node's reply, or { status, followed | unanswered, exited, stalled, error }. */
  async function followed(call, w, done) {
    const proc = node.proc;   // the process given the command: one started since (node-manager runResync starts one when it found the node gone) is not it
    try { return await call(); }
    catch (e) {
      if (!node.proc || node.proc !== proc) return { status: false, error: brief(e), unanswered: true, exited: true };
      const stall = d.stallMs || STALL_MS;
      d.log("[app] MegaMMR file import: no answer from the node (" + brief(e) + "), but it is still running: following its log, never restarting it while it works");
      for (;;) {
        if (done(w)) return { status: true, followed: true };
        if (node.proc !== proc) return done(w) ? { status: true, followed: true } : { status: false, error: "the node stopped before it finished", unanswered: true, exited: true };
        if (Date.now() - w.at > stall) return { status: false, error: "the node showed no progress for " + Math.round(stall / 60000) + " minutes", unanswered: true, stalled: true };
        await d.sleep(5000);
      }
    }
  }
  /** true / false, or null: the status could not be read, and nothing is decided on an unknown. */
  const keeps = async () => { const st = await Promise.resolve().then(d.status).catch(() => null); return st && st.status === true && st.response ? !!st.response.megammr : null; };
  async function nodeUp(ms) { for (const end = Date.now() + ms; Date.now() < end; await d.sleep(1000)) { if (node.state === "running") return true; if (node.state === "error") return false; } return false; }
  const brief = (e) => String((e && (e.error || e.message)) || e || "no answer").replace(/\s+/g, " ").trim().slice(0, 300);
  // Only the one setting: config.save merges params (main/config.js), so nothing else the user saved meanwhile is written over.
  const setMegammr = (v) => d.config.save({ params: { megammr: v } });

  async function importMegammr(shown) {
    return exclusive("import", async () => {
      if (node.state !== "running") throw new Error("node not running");
      const file = d.imports.confirm("megammr", shown);
      F.megammrHeader(file, d.fs);
      const on = await keeps();
      if (on === null) throw new Error(STATUS_UNKNOWN);
      const c = d.config.load(), kind = node.kind(), ram = d.totalmem(), heapMb = F.importHeapMb(kind, c.heapMb, ram);
      const room = F.roomProblem({ kind, size: d.fs.statSync(file).size, heapMb, ramBytes: ram, freeDiskBytes: freeDisk(node.dataDir()) });
      if (room) throw new Error(room);
      // The engines are stopped for the whole import (up to an hour): refused, as a restore is, while a swap, a take or pool work is open
      const items = await d.work();
      if (items && items.length) throw new Error(F.say(IMPORT_OPEN, { items: items.join("\n• ") }));
      await d.mayStop();
      const was = (c.params || {}).megammr;
      // A MegaMMR node started before its memory setting was changed has the old heap: it is restarted first, so the room counted above is real
      const stale = on && kind !== "minima" && node.heapMbNow !== heapMb;
      try { await d.holdEngines(); } catch (e) { await d.releaseEngines(); throw new Error(F.say(ENGINES, { error: brief(e) })); }
      try {
        setMegammr(true);   // always, before any restart: the restart after the import must keep the MegaMMR
        const turnedOn = !on;
        if (turnedOn || stale) {
          d.log("[app] MegaMMR file import: restarting the node in MegaMMR mode" + (stale ? " with its memory setting (" + heapMb + " MB)" : "") + " first (saved before the restart)");
          await d.held(() => node.restart());
          const now = (await nodeUp(d.upMs)) ? await keeps() : null;
          if (now !== true) {
            setMegammr(was);   // put back as it was, never a guess
            d.log("[app] MegaMMR file import: the node did not come back in MegaMMR mode (" + (now === null ? "not known" : "light") + "); the setting is as before" + (now === null ? ", the node is restarted" : ""));
            if (now === null) await node.restart();
            throw new Error(F.ON_FAILED);
          }
          await d.mayStop();
        }
        // The node's own reader over the whole file, before anything is reset (see the top of this file). The file is checked again
        // here and right before the import (it may have been changed while the node restarted or read it).
        let target = "";
        const wc = watch();
        const chk = await followed(() => d.call(F.megammrCheckCommand(d.imports.confirm("megammr", shown), d.platform)), wc, (w) => w.checked)
          .then(r => { if (r && r.status === true) target = d.imports.confirm("megammr", shown); return r; })
          .catch(e => ({ status: false, error: brief(e) })).finally(() => wc.stop());
        if (!chk || chk.status !== true || !target) {
          const why = brief(chk && chk.error);
          d.log("[app] MegaMMR file import: the file was refused (" + why + "); nothing imported" + (turnedOn ? ", MegaMMR set back as it was and the node restarted" : ""));
          if (turnedOn) setMegammr(was);
          if (turnedOn || (chk && chk.unanswered) || node.state !== "running") await node.restart();
          throw new Error(F.say(turnedOn ? CHECK_FAILED_BACK : CHECK_FAILED, { why }));
        }
        d.imports.forget("megammr");
        // THE MARKER, right before the node is given the import: a quit or a crash from here on leaves this trace (see the top of this file)
        setMarker({ stage: "importing", at: new Date().toISOString(), turnedOn });
        const wi = watch();
        const j = await followed(() => d.held(() => d.runResync(F.megammrImportCommand(target, d.platform))), wi, (w) => w.saved)
          .catch(e => ({ status: false, error: brief(e) })).finally(() => wi.stop());
        if (j && j.status === true) {
          // followed to its end: the node finished, saved and exits by itself; it is started again here (runResync's own restart had ended)
          if (j.followed) { for (const end = Date.now() + 60000; node.proc && Date.now() < end; await d.sleep(1000)); if (node.proc) await node.restart(); else await node.start(); }
          const up = await nodeUp(d.upMs);
          d.log("[app] MegaMMR file import finished; the node " + (up ? "is running" : "has not come back yet") + (node.megammrBroken ? "; it says its MegaMMR is BROKEN, so the trading engines stay stopped until Resync node or Turn MegaMMR off" : ""));
          if (node.megammrBroken) setMarker(Object.assign({}, marker(), { stage: "failed" }));   // a success the node itself calls broken releases nothing
          else setMarker(null);
          return { status: true, broken: !!node.megammrBroken, on: true };
        }
        const why = brief(j && j.error);
        if (!wi.reset) {
          // Before "Streaming IBD..": nothing was reset, nothing is owed. Restarted all the same (an out-of-memory error may have hurt the
          // node's other threads), as a light node again when this flow turned MegaMMR on.
          d.log("[app] MegaMMR file import stopped before the node reset its chain (" + why + "); nothing imported or reset, the node is restarted" + (turnedOn ? " as a light node again" : ""));
          setMarker(null);
          if (turnedOn) setMegammr(was);
          await node.restart();
          throw new Error(F.say(turnedOn ? NOT_STARTED_BACK : NOT_STARTED, { why }));
        }
        // Failed after the reset: the node answers, but its chain is gone (network, timers and miner stopped). Restarted at once, as a light
        // node again when this flow turned MegaMMR on, so nothing half-imported is kept as a MegaMMR. The marker stays: Resync node is owed.
        d.log("[app] MegaMMR file import FAILED after the node reset its chain (" + why + "): the node is restarted" + (turnedOn ? " as a light node again" : "") + "; the trading engines stay stopped until Resync node has run");
        setMarker(Object.assign({}, marker(), { stage: "failed" }));
        if (turnedOn) setMegammr(was);
        await node.restart();
        throw new Error(F.say(turnedOn ? FAILED_BACK : FAILED, { why }));
      } finally { if (!marker()) await d.releaseEngines(); }   // with the marker set they stay held (main.js onEnginesRelease says the same)
    });
  }

  /** Turn MegaMMR off: the setting saved, then the restart, at which the node DELETES its megammr.mmr. Works with the node stopped too
   *  (a node whose MegaMMR does not fit its chain may stop at every start). The wallet is not touched. */
  function megammrOff() {
    return exclusive("off", async () => {
      await d.mayStop();
      return d.held(async () => { setMegammr(false); d.log("[app] MegaMMR turned off: the node deletes its MegaMMR file at this restart"); await node.restart(); return node.snapshot(); });
    });
  }

  /** A Resync node (megammrsync action:resync) ended well (main.js runResync): the chain is rebuilt, so an unfinished import owes nothing
   *  any more; the marker goes and the engines are released. */
  async function resynced() {
    if (!marker()) return;
    d.log("[app] Resync node finished: the unfinished MegaMMR import is cleared and the trading engines start again");
    setMarker(null); await d.releaseEngines();
  }

  const freeDisk = (dir) => { try { const st = d.fs.statfsSync(dir); return st.bavail * st.bsize; } catch (e) { return null; } };
  return { importMegammr, megammrOff, resynced, marker, exclusive, busy: () => !!busy, busyWhat: () => busy };
}

module.exports = { create, BUSY, STATUS_UNKNOWN, ENGINES, IMPORT_OPEN, CHECK_FAILED, CHECK_FAILED_BACK, FAILED, FAILED_BACK, NOT_STARTED, NOT_STARTED_BACK, STEP, LOGGER, STALL_MS };
