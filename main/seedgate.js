/*
 * seedgate.js — the commands that show what controls the funds (0.19.176, owner decision 20 Nov 2026). `vault` answers
 * with the wallet's seed phrase (and its other actions handle the keys), `seedrandom` with a key made from the seed.
 * Neither runs from a window on a bare call any more: the main process first checks the phrase the user typed (SHOW SEED
 * for `vault`, SHOW KEY for `seedrandom`), then asks the system's own "is it you" prompt where there is one (Touch ID on a
 * Mac that has it), and only then lets that one command through, once, within PASS_MS. The same gate as the ETH key
 * (main/ethwallet.js exportKeyGated) and the released desktop's seed reveal (its main/seedgate.js, 0.18.165).
 * os = { can() -> bool, prompt(reason) -> Promise }; run(command) -> the node's reply.
 */
"use strict";
const SEED_PHRASE = "SHOW SEED", KEY_PHRASE = "SHOW KEY", PASS_MS = 60000;

/** "seed" when any command of a `;` chain is `vault` (any action, any case), "key" when one is `seedrandom` or
 *  `keys action:genkey` (it prints a new private key; 0.19.177, as the released desktop's cmdgate.js), else null. */
function secretKind(command) {
  let kind = null;
  for (const part of String(command == null ? "" : command).split(";")) {
    const p = part.trim(), verb = (p.split(/\s+/)[0] || "").toLowerCase();
    if (verb === "vault") return "seed";
    if (verb === "seedrandom" || (verb === "keys" && /(^|\s)action:\s*"?genkey\b/i.test(p))) kind = "key";
  }
  return kind;
}
/** The typed phrase, then the system's prompt where there is one. → whether the system's prompt took place. */
async function check(typed, kind, os) {
  const want = kind === "seed" ? SEED_PHRASE : KEY_PHRASE;
  if (String(typed == null ? "" : typed).trim() !== want) throw new Error("Type " + want + " exactly to continue.");
  let ask = false; try { ask = !!(os && os.can()); } catch (e) { ask = false; }
  if (ask) { try { await os.prompt(kind === "seed" ? "show the wallet's seed phrase" : "show a key made from the wallet's seed"); } catch (e) { throw new Error("Cancelled"); } }
  return ask;
}
/** The gate of the general command channel: open(command, typed) passes the checks for that exact command; take(command)
 *  is true once, for that exact command, within PASS_MS of open(). Any take() ends the pass. */
function create(os, now) {
  const clock = now || Date.now; let pass = null;
  async function open(command, typed) {
    pass = null;
    const kind = secretKind(command); if (!kind) throw new Error("This command needs no check.");
    const system = await check(typed, kind, os);
    pass = { command: String(command), until: clock() + PASS_MS };
    return { system };
  }
  function take(command) { const p = pass; pass = null; return !!p && p.command === String(command) && clock() <= p.until; }
  return { open, take };
}
/** Backup & Recovery's "Show seed phrase": the same checks, then the node's seed. → { phrase, system }. */
async function revealSeed(typed, os, run) {
  const system = await check(typed, "seed", os);
  const v = ((await run("vault")) || {}).response || {};
  const phrase = v.phrase || v.seedphrase || v.seed || v.mnemonic || "";
  if (typeof phrase !== "string" || !phrase) throw new Error("Couldn't read the seed.");
  return { phrase, system };
}
module.exports = { secretKind, create, revealSeed, SEED_PHRASE, KEY_PHRASE, PASS_MS };
