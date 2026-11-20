/*
 * seedgate.js — the commands that show what controls the funds (0.19.176, owner decision 20 Nov 2026). `vault` answers
 * with the wallet's seed phrase (and its other actions handle the keys), `seedrandom` with a key made from the seed.
 * Neither runs from a window on a bare call any more: the main process first checks the phrase the user typed (SHOW SEED
 * for `vault`, SHOW KEY for `seedrandom`), then asks the system's own "is it you" prompt where there is one (Touch ID on a
 * Mac that has it), and only then lets that one command through, once, within PASS_MS. The same gate as the ETH key
 * (main/ethwallet.js exportKeyGated) and the released desktop's seed reveal (its main/seedgate.js, 0.18.165).
 * Which commands those are is read the way the node reads a command (main/cmdverb.js, 0.19.187), and a chain (;) holding
 * one is refused: the check names one command.
 * os = { can() -> bool, prompt(reason) -> Promise }; run(command) -> the node's reply.
 */
"use strict";
const SEED_PHRASE = "SHOW SEED", KEY_PHRASE = "SHOW KEY", PASS_MS = 60000;

const V = require("./cmdverb");
/** The secret kind of ONE command (no ";"): "seed", "key" or "". Read the way the node reads it, over-blocking
 *  (main/cmdverb.js, 0.19.187, as the released desktop's cmdgate.js 0.18.174: `"vault"`, a control character before
 *  vault, va"ul"t, keys "action":genkey and keys action :genkey were run by the node and passed the old split on spaces). */
function kindOf(part) {
  if (V.beginsAs(part, "vault")) return "seed";
  if (V.beginsAs(part, "seedrandom")) return "key";
  if (V.beginsAs(part, "keys") && /genkey/.test(V.fold(String(part).replace(/"/g, "")))) return "key";
  return "";
}
/** → { kind: "seed" | "key" | "", chain }: the strongest kind anywhere in the text (the node splits on every ";"). */
function classify(command) {
  const parts = V.parts(command);
  let kind = "";
  for (const p of parts) { const k = kindOf(p); if (k === "seed" || (k && !kind)) kind = k; }
  return { kind, chain: parts.length > 1 };
}
/** "seed", "key" or null (any command of a ";" chain counts). */
function secretKind(command) { return classify(command).kind || null; }
const CHAIN = "vault, seedrandom and keys action:genkey show a seed or a private key, and this chain of commands holds one. Run that command on its own, not in a chain with ;.";
/** Why the general command channel refuses this command ("" = it may run). take: the gate's take. A chain that holds a
 *  gated command is REFUSED (0.19.187, as released 0.18.174), never gated as a whole: the check shows one command. */
function refusal(command, take) {
  const { kind, chain } = classify(command);
  if (!kind) return "";
  if (chain) return CHAIN;
  if (take(command)) return "";
  return kind === "seed" ? "vault, seedrandom and keys action:genkey show a seed or a private key; this one shows the seed phrase. Type SHOW SEED in the Terminal to run it."
    : "vault, seedrandom and keys action:genkey show a seed or a private key; this one shows a private key. Type SHOW KEY in the Terminal to run it.";
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
    const { kind, chain } = classify(command); if (!kind) throw new Error("This command needs no check.");
    if (chain) throw new Error(CHAIN);
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
module.exports = { secretKind, classify, refusal, create, revealSeed, SEED_PHRASE, KEY_PHRASE, PASS_MS };
