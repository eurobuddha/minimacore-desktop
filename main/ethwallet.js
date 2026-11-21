/*
 * ethwallet.js — the desktop "ETH Wallet" tab orchestrator. It is a THIN delegator over the AtomiX module: the
 * ETH wallet lives on the SAME seed-derived ethbridge address AtomiX derives (`seedrandom modifier:ethbridge`),
 * so rather than boot a SECOND engine this module reuses AtomiX's already-booted vm (main/atomix.js). ALL ETH
 * crypto / RPC / signing stays in the AtomiX byte-identical donor set — this file only re-exposes it under its
 * own IPC namespace and forwards engine updates. Lifecycle (init / block-poll / seed-restore invalidate) is
 * owned entirely by main/atomix.js; nothing to duplicate here. See [[native-eth-wallet]] [[minimacore-desktop]].
 */
const { EventEmitter } = require("events");
const atomix = require("./atomix");

const emitter = new EventEmitter();
// The wallet reflects the same node/seed AtomiX drives; forward its update pulses so the tab refreshes on new
// blocks, balance changes, sends, and seed-restore invalidation (atomix.invalidate emits "update").
atomix.emitter.on("update", () => emitter.emit("update"));

/** Header status — safe before the engine boots (atomix.status never throws). */
async function status() {
  const s = atomix.status();
  let address = s.eth || null, rpc = null;
  if (s.ready) { try { const w = await atomix.ethWallet(); address = w.address; rpc = w.rpc; } catch (e) {} }
  return { ready: !!s.ready, address, rpc, block: s.block, halt: !!s.halt, frozen: !!dexiconFrozen() };   // frozen: Dexicon is (Apps tab), so the engine this wallet uses is held
}

// The reads/actions below delegate straight to the AtomiX glue. Each throws "AtomiX engine not booted yet" until
// the engine is ready (node write-enabled + vault unlocked) — the renderer gates on status().ready first.
const balances    = () => atomix.ethBalances();
const tokens      = () => atomix.ethTokens();
const addToken    = (addr) => atomix.ethAddToken(addr);
const removeToken = (addr) => atomix.ethRemoveToken(addr);
const sendMax     = (asset) => atomix.ethSendMax(asset);
const sendReview  = (asset, to, amt) => atomix.ethSendReview(asset, to, amt);
// A frozen Dexicon (Apps tab, main/freeze.js) holds the engine this wallet signs with: a send says so in its own words.
let dexiconFrozen = () => false;
const sendExecute = (asset, to, amt, tier) => (dexiconFrozen() ? Promise.reject(new Error("Dexicon is frozen, and this wallet sends through its Ethereum engine. Unfreeze Dexicon on the Apps tab, then send again. Nothing was sent."))
  : atomix.ethSendExecute(asset, to, amt, tier));
const exportKey   = () => atomix.exportKey();

/**
 * The key for the screen (0.19.108). Never handed over on a bare call: the caller must pass the phrase the user typed,
 * and where the system can ask "is it you" (os.can(): Touch ID on a Mac that has it) it is asked here, in the main
 * process, and a refusal ends it. The phone's ETH Wallet does the same with the device's lock screen before it shows
 * the key. sys = main/syscheck.js (main.js passes the one system check of every gate, 0.19.188).
 * This is the ONLY way a key reaches a window: Dexicon room 1's "Export key" uses it too (0.19.120; its own ungated
 * mcd:axExportKey is gone). → { key, system }.
 */
const EXPORT_PHRASE = "SHOW KEY";
async function exportKeyGated(typed, sys) {
  if (String(typed == null ? "" : typed).trim() !== EXPORT_PHRASE) throw new Error("Type " + EXPORT_PHRASE + " exactly to continue.");
  // the system's own check (main/syscheck.js, 0.19.188): Touch ID; refused while a Touch ID that worked before cannot be
  // asked; a message box naming what is shown where there never was one
  const { N_ } = require("./lang").I18N;
  const ask = (await sys.check(N_("show the ETH private key"), N_("The ETH private key of this wallet (the key Dexicon ① MxUSD swaps sign with) will be shown."))).biometric === true;
  return { key: atomix.exportKey(), system: ask };   // system: the system's own check took place. false is SAID on the screen (0.19.120): the typed phrase was then the only check
}

/**
 * Swaps of AtomiX (Dexicon room 1) that are not finished: they sign with THIS address and pay their gas from its ETH.
 * { known, swaps: [hash, …] }; known false = could not be asked (said on the send review, never read as "none").
 */
async function swapsInFlight() {
  const w = await atomix.activeWork().catch(() => null);
  if (!w) return { known: false, swaps: [] };
  if (Array.isArray(w.swaps)) return { known: true, swaps: w.swaps.slice() };
  return { known: !w.ready && !w.hasStore, swaps: [] };   // not started and no store on disk: there is no swap to have
}
const setRpc      = (url) => atomix.ethSetRpc(url);

module.exports = {
  emitter, status, balances, tokens, addToken, removeToken,
  sendMax, sendReview, sendExecute, setFrozen: (fn) => { dexiconFrozen = fn; }, exportKey, exportKeyGated, swapsInFlight, EXPORT_PHRASE, setRpc
};
