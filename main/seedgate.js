/*
 * seedgate.js — the Settings "Reveal seed phrase" (0.18.165). The seed was put on the screen with one click. Now the
 * phrase the user typed is checked here, in the main process, then the system's own "is it you" prompt is asked where
 * there is one (Touch ID on a Mac that has it), and only then is the node asked for its seed. Same gate as the ETH key
 * (main/ethwallet.js exportKeyGated). → { phrase, system } (system: the system's prompt took place).
 * os = { can() -> bool, prompt(reason) -> Promise }; run(command) -> the node's reply.
 */
const PHRASE = "SHOW SEED";
async function revealSeedGated(typed, os, run) {
  if (String(typed == null ? "" : typed).trim() !== PHRASE) throw new Error("Type " + PHRASE + " exactly to continue.");
  let ask = false; try { ask = !!(os && os.can()); } catch (e) { ask = false; }
  if (ask) { try { await os.prompt("show the wallet's seed phrase"); } catch (e) { throw new Error("Cancelled"); } }
  const r = await run("vault");
  const v = (r && r.response) || {};
  const phrase = v.phrase || v.seedphrase || v.seed || v.mnemonic || "";
  if (typeof phrase !== "string" || !phrase) throw new Error("Couldn't read the seed.");
  return { phrase, system: ask };
}
module.exports = { revealSeedGated, PHRASE };
