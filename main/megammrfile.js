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
 *
 * d = { node (state, resyncing, megammrBroken, heapMbNow, kind(), restart(), snapshot()), config (load(), save(patch)), status() → the
 *       node's `status` reply, call(cmd) → a node reply, imports (main/importfile.js create()), mayStop(), held(op), runResync(cmd),
 *       work() → restore.activeWorkList, holdEngines(), releaseEngines(), fs, totalmem(), platform, log(line), sleep(ms), upMs }
 */
const F = require("./importfile");

const BUSY = "A resync, an import, a restore or a MegaMMR switch is already running. Wait for it to finish. Nothing was changed.";
const STATUS_UNKNOWN = "The node's status could not be read, so it is not known whether it keeps a MegaMMR. Nothing was changed. Try again in a moment.";
const ENGINES = "The trading engines could not be stopped ({error}), so nothing was imported. Nothing was changed.";
const IMPORT_OPEN = "This import replaces the node's chain and stops the trading engines until it has finished, while work that needs them is still open:\n\n• {items}\n\nNothing was changed. Let these finish or withdraw them, then try again.";
const CHECK_FAILED = "The node read the whole file and refused it: {why}. Nothing was imported, and the node's chain was not touched. Use a complete MegaMMR file exported by a node you trust.";
const CHECK_FAILED_BACK = "The node read the whole file and refused it: {why}. Nothing was imported, and the node's chain was not touched. The node was restarted as it was before (MegaMMR off). Use a complete MegaMMR file exported by a node you trust.";
const FAILED = "The import failed part-way ({why}). The node was restarted. Your wallet and funds were not touched: your keys are in the wallet and your coins are on the chain. Until the node has resynced, its balance can show less than you hold: use Resync node to rebuild the chain from a MegaMMR node.";
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
  /** The window disables what would stop or reset the node meanwhile (main.js refuses it anyway): the node's status carries it. */
  function said() { node.megafileBusy = busy; if (typeof node.emit === "function" && typeof node.snapshot === "function") node.emit("status", node.snapshot()); }
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
        const chk = await Promise.resolve().then(() => d.call(F.megammrCheckCommand(d.imports.confirm("megammr", shown), d.platform)))
          .then(r => { if (r && r.status === true) target = d.imports.confirm("megammr", shown); return r; })
          .catch(e => ({ status: false, error: brief(e), unanswered: true }));
        if (!chk || chk.status !== true || !target) {
          const why = brief(chk && chk.error);
          d.log("[app] MegaMMR file import: the file was refused (" + why + "); nothing imported" + (turnedOn ? ", MegaMMR set back as it was and the node restarted" : ""));
          if (turnedOn) setMegammr(was);
          if (turnedOn || (chk && chk.unanswered) || node.state !== "running") await node.restart();
          throw new Error(F.say(turnedOn ? CHECK_FAILED_BACK : CHECK_FAILED, { why }));
        }
        d.imports.forget("megammr");
        const j = await d.held(() => d.runResync(F.megammrImportCommand(target, d.platform))).catch(e => ({ status: false, error: brief(e) }));
        if (j && j.status === true) {
          const up = await nodeUp(d.upMs);
          d.log("[app] MegaMMR file import finished; the node " + (up ? "is running" : "has not come back yet") + (node.megammrBroken ? "; it says its MegaMMR is BROKEN" : ""));
          return { status: true, broken: !!node.megammrBroken, on: true };
        }
        // Failed: the chain may already be reset (the node answers, but has stopped its network, timers and miner). Restarted at once,
        // as a light node again when this flow turned MegaMMR on, so nothing half-imported is kept as a MegaMMR.
        const why = brief(j && j.error);
        d.log("[app] MegaMMR file import FAILED (" + why + "): the node is restarted" + (turnedOn ? " as a light node again" : ""));
        if (turnedOn) setMegammr(was);
        await node.restart();
        throw new Error(F.say(turnedOn ? FAILED_BACK : FAILED, { why }));
      } finally { await d.releaseEngines(); }
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

  const freeDisk = (dir) => { try { const st = d.fs.statfsSync(dir); return st.bavail * st.bsize; } catch (e) { return null; } };
  return { importMegammr, megammrOff, exclusive, busy: () => !!busy, busyWhat: () => busy };
}

module.exports = { create, BUSY, STATUS_UNKNOWN, ENGINES, IMPORT_OPEN, CHECK_FAILED, CHECK_FAILED_BACK, FAILED, FAILED_BACK };
