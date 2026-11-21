/*
 * seedgate.js — the Settings "Reveal seed phrase" (0.18.165). The seed was put on the screen with one click. Now the
 * phrase the user typed is checked here, in the main process, then the system's own "is it you" prompt is asked where
 * there is one (Touch ID on a Mac that has it), and only then is the node asked for its seed. Same gate as the ETH key
 * (main/ethwallet.js exportKeyGated). → { phrase, system } (system: the system's prompt took place).
 * sys = main/syscheck.js (check(reason, detail) → { biometric }); run(command) -> the node's reply.
 */
const PHRASE = require("./phrases").SHOW_SEED;
async function revealSeedGated(typed, sys, run) {
  if (String(typed == null ? "" : typed).trim() !== PHRASE) throw new Error("Type " + PHRASE + " exactly to continue.");
  if (!sys || typeof sys.check !== "function") throw new Error("No system check is available. Nothing was shown.");
  const ask = (await sys.check("show the wallet's seed phrase", "The seed phrase of this wallet will be shown.")).biometric === true;   // main/syscheck.js (0.18.176)
  const r = await run("vault");
  const v = (r && r.response) || {};
  const phrase = v.phrase || v.seedphrase || v.seed || v.mnemonic || "";
  if (typeof phrase !== "string" || !phrase) throw new Error("Couldn't read the seed.");
  return { phrase, system: ask };
}
module.exports = { revealSeedGated, PHRASE };
