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
 * THE MARKER (config megammrImport, main/config.js setMegammrImport): what is owed after an import, at most one, never a verdict.
 *   switching  written before the node is first restarted into MegaMMR mode; nothing imported yet. Holds nothing. Next launch: the window
 *              offers "Finish the import" or "Turn MegaMMR off" (cleared by itself if MegaMMR is off).
 *   importing  written right before the import command, with the wallet's balance (confirmed per token, coin count) and the anchors. A
 *              crash, a failure after the node reset its chain, or a broken MegaMMR leave it: VERIFY FIRST. Once the node is up, the same
 *              balance and coin count clear it silently; only a different one shows the banner (Resync node, or "My balance is correct").
 *   catchup    the import's reply was good, or the node printed "All saved..". Released only when BOTH hold: a recorded block was reached
 *              and holds the same id as before the import, AND the node's tip is fresh (FRESH_MS). Freshness alone never releases (a file
 *              from another chain ends at a fresh block too). Meanwhile "block X of at least Y", with Keep after OFFER_MS, and after
 *              OFFER_MS without the block number growing a plain line that the node is not receiving blocks (Resync node), no verdict.
 *              At or past every recorded height with none of them in the node's tree (it was far behind the file: `txpow block:N` walks only
 *              the tree and the archive) it says so plainly and offers Keep at once. A read the node does not answer is said ("waiting").
 *   mismatch   a recorded height holds ANOTHER block id on the new chain (hard evidence only). Said as exactly that ("one of the two is a
 *              fork", never "the file is wrong"); the user chooses: Keep the imported chain, or Turn MegaMMR off and resync.
 * Every stage but switching holds the trading engines (holdsEngines(), main.js onEnginesRelease and launch), and so does the import while it runs.
 * A verify that awaited the node across a newly started flow sets and releases nothing (gen); keep() is refused while one runs. Every one has an exit that destroys
 * nothing: keep() (the window's "Keep" / "My balance is correct"), and any Resync node that ends well (resynced()).
 *
 * NO ANSWER IS NOT AN END (M3). The node's answer can take longer than the RPC's one-hour bound (a 1.6 GB file is unmeasured): when the
 * call ends without an answer and the node process is still there, it is not restarted. Its log is followed, the step is shown on
 * screen, and it is given up only after STALL_MS with no new step, or when the node exits.
 *
 * d = { node (state, proc, resyncing, megammrBroken, heapMbNow, kind(), start(), restart(), snapshot(), on/removeListener("line")), config
 *       (load(), save(patch), setMegammrImport(v)), status() → the node's `status` reply, call(cmd) → a node reply, imports
 *       (main/importfile.js create()), mayStop(), held(op), runResync(cmd), work() → restore.activeWorkList (asked before the hold and again
 *       after it: of an engine the flow stopped, what it had open when it stopped, main/restore.js heldRead), holdEngines(),
 *       releaseEngines(), fs, totalmem(), platform, log(line), sleep(ms), upMs, stallMs }
 */
const F = require("./importfile");

const BUSY = "A resync, an import, a restore or a MegaMMR switch is already running. Wait for it to finish. Nothing was changed.";
const STATUS_UNKNOWN = "The node's status could not be read, so it is not known whether it keeps a MegaMMR. Nothing was changed. Try again in a moment.";
const ENGINES = "The trading engines could not be stopped ({error}), so nothing was imported. Nothing was changed.";
const IMPORT_OPEN = "This import replaces the node's chain and stops the trading engines until it has finished, while work that needs them is still open:\n\n• {items}\n\nNothing was changed. Let these finish or withdraw them, then try again.";
const CHECK_FAILED = "The node read the whole file and refused it: {why}. Nothing was imported, and the node's chain was not touched. Use a complete MegaMMR file exported by a node you trust.";
const CHECK_FAILED_BACK = "The node read the whole file and refused it: {why}. Nothing was imported, and the node's chain was not touched. The node was restarted as it was before (MegaMMR off). Use a complete MegaMMR file exported by a node you trust.";
const FAILED = "The import failed part-way ({why}). The node was restarted. Your wallet and funds were not touched: your keys are in the wallet and your coins are on the chain. Until the node has resynced, its balance can show less than you hold: use Resync node to rebuild the chain from a MegaMMR node. Resync node also empties this node's MegaMMR (megammrsync clears it): import a MegaMMR file again afterwards to have it whole.";
// the node's check ended without an answer (it stopped, or showed no progress): not a refusal of the file
const CHECK_UNANSWERED = "The node did not finish checking the file ({why}). Nothing was imported, and the node's chain was not touched. The node was restarted.";
const CHECK_UNANSWERED_BACK = "The node did not finish checking the file ({why}). Nothing was imported, and the node's chain was not touched. The node was restarted as it was before (MegaMMR off).";
// the node ran out of memory reading the file, before anything was reset (an OutOfMemoryError in its reply or its log)
const OOM = /OutOfMemoryError|Java heap space|too large for this device's memory|Heap nearly exhausted/;
const OOM_SAID = "The node ran out of memory reading this MegaMMR file ({why}). Nothing was imported or reset. The node was restarted. It had {heap} MB: in Settings, set Parlons Node memory higher and press Apply and restart the node, then try again.";
const OOM_BACK = "The node ran out of memory reading this MegaMMR file ({why}). Nothing was imported or reset. The node was restarted as a light node, as it was before. It had {heap} MB: in Settings, set Parlons Node memory higher and press Apply and restart the node, then try again.";
// a failure before the node printed "Streaming IBD..": nothing was reset, so nothing is owed (no Resync)
const NOT_STARTED = "The import stopped before the node's chain was touched ({why}). Nothing was imported or reset. The node was restarted. Your wallet and funds were not touched.";
const NOT_STARTED_BACK = "The import stopped before the node's chain was touched ({why}). Nothing was imported or reset. The node was restarted as a light node, as it was before. Your wallet and funds were not touched.";
// MinimaLogger's prefix, then the steps megammr.java (import, integrity) and MegaMMR.java (loading) print
const LOGGER = /^Minima @ [\d/]+ [\d:]+ \[[^\]]*\] : /;
const STEP = /^(Loading MegaMMR size : |Load MegaMMR\.\. |Check IBD\.\.|Now check all coin proofs\.\.|Checking coins @ \d+ \/ \d+|All coins checked \d+ \/ \d+|MegaMMR import pre-flight\.\.|Loading MegaMMR portion\.\.|MegaMMR loading coins\.\. \d+\/\d+|MegaMMR loaded\.\.|Streaming IBD\.\.|IBD blocks processed\.\. \d+\/\d+|System memory clean\.\.|Current (Top Block|Tree Root|MegaMMR Tip) : |Get all your CoinProofs|Transfer your CoinProofs\.\.|All saved\.\.|Main Instance Cleared\.\.)/;
// ponytail: 30 minutes with no new step, fitted to nothing measured (the node's slowest silent stretch is reading a whole 1.6 GB file in
// the integrity check, unmeasured); raise it if a real import is given up while the node is still reading
const STALL_MS = 30 * 60 * 1000;
const SHOWN_LINES = 8;
// The anchors (recorded before the import): the tip, NEAR blocks back (a tip can be orphaned by a short reorg) and DEEP back (final). A
// file whose MegaMMR ends more than BEHIND blocks below this node's tip (30 days at Minima's 50 s target) is WARNED of before the import
// (fileAge), never refused: a node that is stuck or behind is when an import is needed. After the import the engines wait for the node's
// tip to be fresh (FRESH_MS: its tip block at most 30 minutes old) AND a recorded block to be found with the same id; after OFFER_MS of
// catching up the window offers Keep, and says so when the block number has not grown for OFFER_MS.
const DEEP = 300, NEAR = 3, BEHIND = 30 * 24 * 3600 / 50, FRESH_MS = 30 * 60 * 1000, OFFER_MS = 10 * 60 * 1000;
const STAGES = ["switching", "importing", "catchup", "mismatch"];
/** Does this marker (config megammrImport, as read) hold the trading engines? Anything but "switching" does, a damaged one too. */
const holds = (m) => !!m && !(typeof m === "object" && m.stage === "switching");
const CHANGED_WHY = "it was changed while the node checked it (choose it again)";
const TIP_REFUSED = "This file was not imported: {why}. Nothing was imported, and the node's chain was not touched.";
const TIP_REFUSED_BACK = "This file was not imported: {why}. Nothing was imported, and the node's chain was not touched. The node was restarted as it was before (MegaMMR off).";   // the node's last lines on the import's screen
// keep() when the settings file cannot be written: released for this run all the same (never stranded), said
const KEEP_UNSAVED = "Cleared for now, but the app's settings could not be saved ({error}): the import's check comes back at the next start.";
const FAILED_BACK = "The import failed part-way ({why}). The node was restarted as a light node, as it was before. Your wallet and funds were not touched: your keys are in the wallet and your coins are on the chain. Until the node has resynced, its balance can show less than you hold: use Resync node to rebuild the chain from a MegaMMR node.";

// Both recovery pages follow the same bounded stream of redacted node lines.
function watchNodeLog(node, record, publish, every = 400) {
  const lines = [];
  let last = 0, timer = null;
  const tell = () => { clearTimeout(timer); timer = null; last = Date.now(); publish(); };
  const onLine = raw => {
    const line = String(raw);
    lines.push(line);
    if (lines.length > SHOWN_LINES) lines.shift();
    const prefix = LOGGER.exec(line);
    record(lines.slice(), prefix ? line.slice(prefix[0].length) : "");
    const delay = every - (Date.now() - last);
    if (delay <= 0) tell();
    else if (!timer) timer = setTimeout(tell, delay);
  };
  if (typeof node.on === "function") node.on("line", onLine);
  return () => {
    clearTimeout(timer);
    if (typeof node.removeListener === "function") node.removeListener("line", onLine);
  };
}
function create(d) {
  const node = d.node;
  let busy = "", gen = 0, releasing = false, unwritten = null;   // gen: counts the flows started (a verify that awaited across one gives up)
  /** One of these at a time, and none during a resync the node is already running (node-manager runResync). */
  async function exclusive(what, fn) {
    if (busy || node.resyncing) throw new Error(BUSY);
    busy = what; gen++; said();
    const shown = what === "import" ? show() : null;   // the import's screen shows every step, from the first restart to the last
    try { return await fn(); } finally { if (shown) shown(); busy = ""; said(); }
  }
  /** The window disables what would stop or reset the node meanwhile (main.js refuses it anyway): the node's status carries it, the step
   *  the node is at, and the marker. */
  function said() { try { node.megafileBusy = busy; if (!busy) { node.megafileStep = ""; node.megafileLog = []; } if (typeof node.emit === "function" && typeof node.snapshot === "function") node.emit("status", node.snapshot()); } catch (e) { /* a listener's failure is not the import's */ } }
  /** For the import's screen, from its first step to its last (the owner's import, 2026-11-23: no progress was shown for 4.5 minutes): the
   *  node's last lines as the Logs show them (redacted by node-manager), and its last STEP line, or the flow's own stage ("app:<stage>",
   *  said in the window's language by renderer/app.js importStage). Said to the window at most every 400 ms, and at every stage. → stop(). */
  function show() {
    return watchNodeLog(node, (lines, text) => {
      node.megafileLog = lines;
      if (STEP.test(text)) node.megafileStep = text;
    }, said, d.showMs);
  }
  const stage = (k) => { node.megafileStep = "app:" + k; said(); };
  /** The marker, read so that anything odd (not an object, no or an unknown stage, another version's) is "importing": verify first, clearable. */
  const raw = () => { try { return d.config.load().megammrImport; } catch (e) { return null; } };
  const marker = () => { const m = raw(); if (m == null || m === false || m === "") return null;
    if (unwritten !== null && JSON.stringify(m) === unwritten) return null;   // cleared by the user, but the config could not be written: cleared for this run
    return m && typeof m === "object" && STAGES.includes(m.stage) ? m : Object.assign({}, m && typeof m === "object" ? m : {}, { stage: "importing" }); };
  /** Never throws: a marker that cannot be written is said in the log, and does not turn a good import into a failed one. A CLEAR that
   *  cannot be written is kept in memory (unwritten): the engines are not stranded behind it until the app restarts. → the error, or "". */
  const setMarker = (v) => { let err = "", was = raw();
    try { d.config.setMegammrImport(v); unwritten = null; } catch (e) { err = brief(e); if (!v) unwritten = JSON.stringify(was === undefined ? null : was); try { d.log("[app] the MegaMMR import marker could not be written (" + err + ")"); } catch (x) {} }
    if (!v) node.megafileBanner = null; said(); return err; };
  /** Does the import hold the trading engines now (main.js onEnginesRelease)? While it runs (but its own release), and while its marker holds. */
  const holdsEngines = () => (busy === "import" && !releasing) || holds(marker());
  /** What the window's banner says (renderer/app.js paintMegaBar): { kind, ... } or null. */
  const banner = (b) => { node.megafileBanner = b; said(); };
  /** What the node's log says of the command running now (STEP lines only, after the logger's prefix): the last step and when, whether
   *  it reset the chain, finished the check, finished the import. stop() ends the watch. */
  function watch(onSaved) {
    const w = { at: Date.now(), step: "", reset: false, checked: false, saved: false, oom: false };
    const on = (raw) => {
      const l = String(raw);
      if (/OutOfMemoryError|Java heap space/.test(l)) w.oom = true;   // an uncaught one is printed without the prefix
      const m = LOGGER.exec(l); if (!m) return;
      const text = l.slice(m[0].length); if (!STEP.test(text)) return;
      w.at = Date.now(); w.step = text;
      if (/^(MegaMMR loaded|Streaming IBD)/.test(text)) w.reset = true;   // megammr.java: the reset follows "MegaMMR loaded.." with nothing in between that can be told apart
      if (/^All coins checked/.test(text)) w.checked = true;
      if (/^(All saved|Main Instance Cleared)/.test(text)) { if (!w.saved && onSaved) onSaved(); w.saved = true; }
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
    try { return await importInside(shown); }
    finally { verify().catch(() => {}); }   // once the exclusive has ended, whatever its end (and at every node status from main.js)
  }
  function importInside(shown) {
    return exclusive("import", async () => {
      if (node.state !== "running") throw new Error("node not running");
      const file = d.imports.confirm("megammr", shown);
      F.megammrHeader(file, d.fs);
      const on = await keeps();
      if (on === null) throw new Error(STATUS_UNKNOWN);
      const c = d.config.load(), kind = node.kind(), ram = d.totalmem(), heapMb = F.importHeapMb(kind, c.heapMb, ram);
      const room = F.roomProblem({ kind, size: d.fs.statSync(file).size, heapMb, ramBytes: ram, freeDiskBytes: freeDisk(node.dataDir()) });
      if (room) throw new Error(room);
      // The engines are stopped for the whole import. What is open is read FIRST, while they run (0.19.417: held first, Dexicon and Future
      // Cash Next said "has not started" and every import refused itself), and refused, as a restore is, while a swap, a take or pool work
      // is open; then the stop guard, still with the engines running; then the hold; then the same read again, of the engines as held (main.js:
      // what a stopped engine had open when it stopped, main/restore.js heldRead), so what started between the first read and the hold refuses
      // too, and the hold is let go. A refusal after the guard ends its hold (held), so the retry is not refused as a stop already under way.
      const open = (items) => { if (items && items.length) throw new Error(F.say(IMPORT_OPEN, { items: items.join("\n• ") })); };
      open(await d.work());
      await d.mayStop();
      await d.held(async () => {
        try { await d.holdEngines(); } catch (e) { await release(); throw new Error(F.say(ENGINES, { error: brief(e) })); }
        try { const late = await d.work(); if (late && late.length) d.log("[app] MegaMMR file import refused: work started while the trading engines were being stopped: " + late.join(" | ")); open(late); }
        catch (e) { await release(); throw e; }
      });
      const was = (c.params || {}).megammr, prior = marker();   // a switching marker left by an earlier import: MegaMMR on and empty, kept until something is imported
      let wroteSwitching = false;
      // A MegaMMR node started before its memory setting was changed has the old heap: it is restarted first, so the room counted above is real
      const stale = on && kind !== "minima" && node.heapMbNow !== heapMb;
      try {
        setMegammr(true);   // always, before any restart: the restart after the import must keep the MegaMMR
        const turnedOn = !on;
        if (turnedOn || stale) {
          stage("restart-on");
          if (turnedOn) { setMarker({ stage: "switching", at: new Date().toISOString() }); wroteSwitching = true; }   // a quit or crash from here until the import leaves MegaMMR on and empty
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
        // M4: this node's own chain before anything is touched: its tip, a block a few back (a tip can be orphaned), and one DEEP back (final).
        // After the import the node must find these very blocks on its new chain before the engines go (verify below).
        const before = await chainAnchors();
        if (!before) { if (turnedOn) { setMegammr(was); await node.restart(); } throw new Error(STATUS_UNKNOWN); }
        let target = "";
        const print = fingerprint(d.imports.confirm("megammr", shown));   // the file as the node is about to read it: compared again right before the import
        stage("check");
        const wc = watch();
        const chk = await followed(() => d.call(F.megammrCheckCommand(d.imports.confirm("megammr", shown), d.platform)), wc, (w) => w.checked)
          .then(r => { if (r && r.status === true) target = d.imports.confirm("megammr", shown); return r; })
          .catch(e => ({ status: false, error: brief(e) })).finally(() => wc.stop());
        if (!chk || chk.status !== true || !target) {
          const why = brief(chk && chk.error).split(" @ ")[0];   // "INVALID Coin proof! @ {the coin's JSON}": the reason, not the coin
          d.log("[app] MegaMMR file import: the file was refused (" + why + "); nothing imported" + (turnedOn ? ", MegaMMR set back as it was and the node restarted" : ""));
          if (turnedOn) setMegammr(was);
          if (turnedOn || (chk && chk.unanswered) || node.state !== "running") await node.restart();
          if (wc.oom || OOM.test(why)) throw new Error(F.say(turnedOn ? OOM_BACK : OOM_SAID, { why, heap: String(heapMb) }));
          if (chk && chk.unanswered) throw new Error(F.say(turnedOn ? CHECK_UNANSWERED_BACK : CHECK_UNANSWERED, { why }));
          throw new Error(F.say(turnedOn ? CHECK_FAILED_BACK : CHECK_FAILED, { why }));
        }
        if (fingerprint(target) !== print) {   // replaced or rewritten while the node read it: what it checked is not what it would import
          d.log("[app] MegaMMR file import: refused, the file was changed while the node checked it" + (turnedOn ? "; MegaMMR set back as it was and the node restarted" : ""));
          if (turnedOn) { setMegammr(was); await node.restart(); }
          throw new Error(F.say(turnedOn ? TIP_REFUSED_BACK : TIP_REFUSED, { why: CHANGED_WHY }));
        }
        d.imports.forget("megammr");
        // THE MARKER, right before the node is given the import: a quit or a crash from here on leaves this trace (see the top of this file)
        const wallet = await balanceSummary();
        if (!wallet) { if (turnedOn) { setMegammr(was); await node.restart(); } throw new Error(STATUS_UNKNOWN); }
        setMarker({ stage: "importing", at: new Date().toISOString(), turnedOn, anchors: before.anchors, tip: before.tip, before: wallet });
        stage("import");
        const toCatchup = () => { const m = marker(); if (m && m.stage === "importing") setMarker(Object.assign({}, m, { stage: "catchup", since: Date.now() })); };
        const wi = watch(toCatchup);   // "All saved..": the import has finished, whatever happens to its answer
        const j = await followed(() => d.held(() => d.runResync(F.megammrImportCommand(target, d.platform))), wi, (w) => w.saved)
          .catch(e => ({ status: false, error: brief(e) })).finally(() => wi.stop());
        if (j && j.status === true) {
          // followed to its end: the node finished, saved and exits by itself; it is started again here (runResync's own restart had ended)
          stage("restart-end");
          if (j.followed) { for (const end = Date.now() + 60000; node.proc && Date.now() < end; await d.sleep(1000)); if (node.proc) await node.restart(); else await node.start(); }
          const up = await nodeUp(d.upMs);
          d.log("[app] MegaMMR file import finished; the node " + (up ? "is running" : "has not come back yet") + (node.megammrBroken ? "; it says its MegaMMR is BROKEN, so the trading engines stay stopped until Resync node or Turn MegaMMR off" : ""));
          // a success the node itself calls broken releases nothing; otherwise the engines wait until this node's own blocks are found on the
          // new chain and the node is at the network's tip (verify)
          // a node that says its MegaMMR is BROKEN goes back to "importing": its balance is compared before anything is released
          if (node.megammrBroken) setMarker(Object.assign({}, marker(), { stage: "importing" })); else toCatchup();
          return { status: true, broken: !!node.megammrBroken, on: true };
        }
        const why = brief(j && j.error);
        if (!wi.reset) {
          // Before "Streaming IBD..": nothing was reset, nothing is owed. Restarted all the same (an out-of-memory error may have hurt the
          // node's other threads), as a light node again when this flow turned MegaMMR on.
          d.log("[app] MegaMMR file import stopped before the node reset its chain (" + why + "); nothing imported or reset, the node is restarted" + (turnedOn ? " as a light node again" : ""));
          setMarker(prior && prior.stage === "switching" ? prior : null);   // MegaMMR still on and empty when an earlier import left it so
          if (turnedOn) setMegammr(was);
          await node.restart();
          if (wi.oom || OOM.test(why)) throw new Error(F.say(turnedOn ? OOM_BACK : OOM_SAID, { why, heap: String(heapMb) }));
          throw new Error(F.say(turnedOn ? NOT_STARTED_BACK : NOT_STARTED, { why }));
        }
        // Failed after the reset: the node answers, but its chain is gone (network, timers and miner stopped). Restarted at once, as a light
        // node again when this flow turned MegaMMR on, so nothing half-imported is kept as a MegaMMR. The marker stays: Resync node is owed.
        d.log("[app] MegaMMR file import FAILED after the node reset its chain (" + why + "): the node is restarted" + (turnedOn ? " as a light node again" : "") + "; the trading engines stay stopped until Resync node has run");
        setMarker(Object.assign({}, marker(), { stage: "importing" }));   // verify first: its balance decides whether anything is owed
        if (turnedOn) setMegammr(was);
        await node.restart();
        throw new Error(F.say(turnedOn ? FAILED_BACK : FAILED, { why }));
      } finally {
        const m = marker();
        if (m && m.stage === "switching" && wroteSwitching && (d.config.load().params || {}).megammr === was) setMarker(null);   // this flow's switch undone: nothing owed (an earlier import's is kept)
        if (!holds(marker())) await release();
      }   // with the marker set they stay held (main.js onEnginesRelease says the same)
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

  /** M4. { tip, anchors: [{ block, txpowid }] } of this node's chain now (deepest first), or null: not read. */
  async function chainAnchors() {
    const b = await Promise.resolve().then(() => d.call("block")).catch(() => null);
    const tip = b && b.status === true && b.response ? Number(b.response.block) : NaN, hash = b && b.response && String(b.response.hash || "");
    if (!(tip > 0) || !/^0x[0-9A-F]{64}$/i.test(hash)) return null;
    const anchors = [];
    for (const n of [tip - DEEP, tip - NEAR]) if (n >= 1) {
      const r = await Promise.resolve().then(() => d.call("txpow block:" + n)).catch(() => null), id = r && r.status === true && r.response ? String(r.response.txpowid || "") : "";
      if (/^0x[0-9A-F]{64}$/i.test(id)) anchors.push({ block: n, txpowid: id });
    }
    anchors.push({ block: tip, txpowid: hash });
    return { tip, anchors };
  }
  /** The wallet as the node shows it: [tokenid, confirmed, coins] per token, sorted; null when it cannot be read. */
  async function balanceSummary() {
    const r = await Promise.resolve().then(() => d.call("balance")).catch(() => null);
    if (!r || r.status !== true || !Array.isArray(r.response)) return null;
    return r.response.map(t => [String(t.tokenid), String(t.confirmed), String(t.coins)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  const sameWallet = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /** Release the trading engines, unless a seed or backup restore holds them (node-manager runResync / walletSettle releases them then). */
  async function release() {
    if (node.replacingWallet || (node.walletCheck && node.walletCheck.held)) { d.log("[app] the MegaMMR import owes nothing more; the trading engines start when the wallet restore has settled"); return; }
    releasing = true; try { await d.releaseEngines(); } finally { releasing = false; }   // its own release, inside its exclusive too (holdsEngines)
  }
  /** At every node status (main.js) and after an import: what the marker owes now (see the top of this file). Never writes a verdict
   *  but "mismatch", which is hard evidence and has its own exits. */
  let verifying = false, grow = { key: "", best: 0, at: 0 };
  async function verify() {
    const m = marker(), g = gen;
    if (!m || busy || verifying || node.state !== "running") return;
    // an import (or keep) started while this one awaited the node: what it read is not about that import, and nothing is set or released
    const gone = () => !!busy || gen !== g || JSON.stringify(marker()) !== JSON.stringify(m);
    const ask = (c) => Promise.resolve().then(() => d.call(c)).catch(() => null);   // null: no answer (said), never "not found"
    const waiting = () => banner({ kind: "waiting" });   // the engines are held: said, never held silently
    verifying = true;
    try {
      if (m.stage === "switching") { if (!(d.config.load().params || {}).megammr) setMarker(null); else banner({ kind: "switching" }); return; }
      if (m.stage === "mismatch") { banner({ kind: "mismatch", block: m.block, before: m.was, after: m.now }); return; }
      if (m.stage === "importing") {
        const now = await balanceSummary();
        if (gone()) return;
        if (now && Array.isArray(m.before) && sameWallet(now, m.before)) {
          d.log("[app] after an unfinished MegaMMR import this node shows the same balance and coin count as before it (" + now.map(t => t[0] + " " + t[1] + " in " + t[2] + " coins").join(", ") + "): nothing is owed, the trading engines start again");
          setMarker(null); await release(); return;   // gone() was asked after the last await: nothing ran in between
        }
        // an old marker (failed/foreign, no balance recorded) claims nothing about the balance
        if (now) banner(Array.isArray(m.before) ? { kind: "incomplete", less: lessThan(now, m.before), before: m.before, now } : { kind: "incomplete", unknown: true, now }); else waiting();
        return;
      }
      const b = await ask("block"), tipNow = b && b.status === true && b.response ? b.response : null;
      if (gone()) return;
      if (!tipNow) { waiting(); return; }
      const tip = Number(tipNow.block), age = Date.now() - Number(tipNow.timemilli);
      let matched = 0, asked = 0, absent = 0;
      for (const a of Array.isArray(m.anchors) ? m.anchors : []) {
        if (tip < a.block) continue;
        asked++;
        const r = await ask("txpow block:" + a.block), id = r && r.status === true && r.response ? String(r.response.txpowid || "") : "";
        if (gone()) return;
        if (!id) { if (r) absent++; continue; }   // an answer without it: not in the node's tree or archive
        if (id.toLowerCase() !== String(a.txpowid).toLowerCase()) {
          d.log("[app] MegaMMR file import: block " + a.block + " on this node before the import was " + a.txpowid + "; after the import it is " + id + ". One of the two is a fork: the trading engines stay stopped until the user chooses");
          setMarker(Object.assign({}, m, { stage: "mismatch", block: a.block, was: a.txpowid, now: id }));
          banner({ kind: "mismatch", block: a.block, before: a.txpowid, after: id }); return;
        }
        matched = a.block; break;
      }
      if (matched && age <= FRESH_MS) {
        d.log("[app] MegaMMR file import: block " + matched + " is the same block as before the import and the node's tip is fresh (block " + tip + ", " + Math.round(age / 1000) + " s old): the trading engines start again");
        setMarker(null); await release(); return;   // gone() was asked after the last await: nothing ran in between
      }
      if (!matched && asked && absent < asked) { waiting(); return; }   // a recorded block could not be asked: nothing concluded
      // growth of the block number, per import (keyed by its marker's since): none for OFFER_MS is said, never concluded on
      const key = String(m.since || m.at || ""), offerMs = d.offerMs || OFFER_MS;
      if (grow.key !== key) grow = { key, best: tip, at: Date.now() }; else if (tip > grow.best) { grow.best = tip; grow.at = Date.now(); }
      const target = Math.min(...(Array.isArray(m.anchors) && m.anchors.length ? m.anchors.map(a => Number(a.block)) : [Number(m.tip) || 0]));
      // at or past every height that could be compared, and the node holds none of them (txpow block:N walks only its tree and archive: a
      // node that was far behind the file has none of its earlier blocks any more): said plainly, Keep offered at once
      if (!matched && asked && absent === asked && tip >= target) { banner({ kind: "catchup", block: tip, target, offer: true, stalled: false, unseen: true }); return; }
      banner({ kind: "catchup", block: tip, target, offer: Date.now() - Number(m.since || 0) >= offerMs, stalled: Date.now() - grow.at >= offerMs });
    } catch (e) { /* asked again at the next status */ } finally { verifying = false; }
  }
  const lessThan = (now, before) => { if (!Array.isArray(before)) return true; const g = (w, i) => w.reduce((n, t) => n + (t[0] === "0x00" ? Number(t[i]) : 0), 0), c = (w) => w.reduce((n, t) => n + Number(t[2]), 0);
    return g(now, 1) < g(before, 1) || c(now) < c(before); };
  /** The window's way out that destroys nothing ("Keep the imported chain", "My balance is correct", Keep while it catches up): the marker
   *  goes and the engines are released. The user has seen what the node shows. */
  async function keep() {
    if (busy) throw new Error(BUSY);   // an import (or a restore) running now: what was on screen is not about it
    const m = marker(); if (!m) return { kept: false };
    d.log("[app] the user kept the node's chain as it is after the MegaMMR import (" + m.stage + "): the marker is cleared and the trading engines start again");
    const err = setMarker(null); await release();
    return err ? { kept: true, warning: F.say(KEEP_UNSAVED, { error: err }) } : { kept: true };
  }
  /** Before the question: how far behind this node's tip the file's MegaMMR ends (its header), for a warning, never a refusal. */
  async function fileAge(shown) {
    const head = F.megammrHeader(d.imports.confirm("megammr", shown), d.fs), b = await Promise.resolve().then(() => d.call("block")).catch(() => null);
    const nodeTip = b && b.status === true && b.response ? Number(b.response.block) : NaN, fileTip = Number(head.tip);
    return { fileTip: head.tip, nodeTip: Number.isFinite(nodeTip) ? String(nodeTip) : "", old: Number.isFinite(nodeTip) && nodeTip - fileTip > BEHIND };
  }

  /** A Resync node (megammrsync action:resync) ended well (main.js runResync): the chain is rebuilt, so the marker owes nothing. */
  async function resynced() {
    if (!marker()) return;
    d.log("[app] Resync node finished: the MegaMMR import's marker is cleared and the trading engines start again");
    setMarker(null); await release();
  }

  /** size, modification time and inode: a file replaced or rewritten between the check and the import differs in one of them */
  const fingerprint = (p) => { try { const st = d.fs.statSync(p); return [st.size, st.mtimeMs, st.ino].join(":"); } catch (e) { return "unreadable"; } };
  const freeDisk = (dir) => { try { const st = d.fs.statfsSync(dir); return st.bavail * st.bsize; } catch (e) { return null; } };
  return { importMegammr, megammrOff, resynced, verify, keep, fileAge, marker, exclusive, holdsEngines, busy: () => !!busy, busyWhat: () => busy };
}

module.exports = { create, watchNodeLog, BUSY, STATUS_UNKNOWN, ENGINES, IMPORT_OPEN, CHECK_FAILED, CHECK_FAILED_BACK, FAILED, FAILED_BACK, NOT_STARTED, NOT_STARTED_BACK, STEP, LOGGER, STALL_MS,
  CHECK_UNANSWERED, CHECK_UNANSWERED_BACK, CHANGED_WHY, OOM_SAID, OOM_BACK, KEEP_UNSAVED, TIP_REFUSED, TIP_REFUSED_BACK, DEEP, NEAR, BEHIND, FRESH_MS, OFFER_MS, holds };
