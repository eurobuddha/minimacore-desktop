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
  return { ready: !!s.ready, address, rpc, block: s.block };
}

// The reads/actions below delegate straight to the AtomiX glue. Each throws "AtomiX engine not booted yet" until
// the engine is ready (node write-enabled + vault unlocked) — the renderer gates on status().ready first.
const balances    = () => atomix.ethBalances();
const tokens      = () => atomix.ethTokens();
const addToken    = (addr) => atomix.ethAddToken(addr);
const removeToken = (addr) => atomix.ethRemoveToken(addr);
const sendMax     = (asset) => atomix.ethSendMax(asset);
const sendReview  = (asset, to, amt) => atomix.ethSendReview(asset, to, amt);
const sendExecute = (asset, to, amt, tier) => atomix.ethSendExecute(asset, to, amt, tier);
const exportKey   = () => atomix.exportKey();

/**
 * The key for the screen (0.18.152, from 0.19.108 / 0.19.120). Never handed over on a bare call: the caller must pass
 * the phrase the user typed, and where the system can ask "is it you" (os.can(): Touch ID on a Mac that has it) it is
 * asked here, in the main process, and a refusal ends it. This is the ONLY way a key reaches a window: the AtomiX
 * panel's "Export key" uses it too (its own ungated mcd:axExportKey is gone). → { key, system }.
 * os = { can() -> bool, prompt(reason) -> Promise } (main.js passes Electron's systemPreferences).
 */
const EXPORT_PHRASE = "SHOW KEY";
async function exportKeyGated(typed, sys) {
  if (String(typed == null ? "" : typed).trim() !== EXPORT_PHRASE) throw new Error("Type " + EXPORT_PHRASE + " exactly to continue.");
  if (!sys || typeof sys.check !== "function") throw new Error("No system check is available. Nothing was shown.");
  // the system's own check (main/syscheck.js, 0.18.176): Touch ID; refused while Touch ID that worked before cannot be asked;
  // a confirmation naming what is shown where Touch ID was never available
  const s = await sys.check("show the ETH private key", "The ETH private key of this wallet (the key AtomiX swaps sign with) will be shown.");
  return { key: atomix.exportKey(), system: s.biometric === true };   // system: Touch ID took place; false is said on the screen
}
const setRpc      = (url) => atomix.ethSetRpc(url);

module.exports = {
  emitter, status, balances, tokens, addToken, removeToken,
  sendMax, sendReview, sendExecute, exportKey, exportKeyGated, EXPORT_PHRASE, setRpc
};
