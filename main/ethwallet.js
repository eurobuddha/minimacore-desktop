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
const setRpc      = (url) => atomix.ethSetRpc(url);

module.exports = {
  emitter, status, balances, tokens, addToken, removeToken,
  sendMax, sendReview, sendExecute, exportKey, setRpc
};
