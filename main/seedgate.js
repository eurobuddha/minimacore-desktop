/*
 * seedgate.js — the commands that show what controls the funds (0.19.176, owner decision 20 Nov 2026). `vault` answers
 * with the wallet's seed phrase (and its other actions handle the keys), `seedrandom` with a key made from the seed.
 * Neither runs from a window on a bare call any more: the main process first checks the phrase the user typed (SHOW SEED
 * for `vault`, SHOW KEY for `seedrandom`), then asks the system's own "is it you" prompt where there is one (Touch ID on a
 * Mac that has it), and only then lets that one command through, once, within PASS_MS. The same gate as the ETH key
 * (main/ethwallet.js exportKeyGated) and the released desktop's seed reveal (its main/seedgate.js, 0.18.165).
 * Which commands those are is read the way the node reads a command (main/cmdverb.js, 0.19.187), and a chain (;) holding
 * one is refused: the check names one command.
 * sys = main/syscheck.js (check(reason, detail) -> { biometric }); run(command) -> the node's reply.
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
const { N_ } = require("./lang").I18N;
const SHOW_MAX = 80;   // what a Touch ID prompt can show of a command after its fixed words (the system cuts its reason at 120)
/** The typed phrase, then the system's own check (main/syscheck.js, 0.19.188: Touch ID; refused while a Touch ID that
 *  worked before cannot be asked; a message box naming what is shown where there never was one). what = { reason, detail }
 *  as syscheck takes them. -> whether a Touch ID check took place. */
async function check(typed, kind, sys, what) {
  const want = kind === "seed" ? SEED_PHRASE : KEY_PHRASE;
  if (String(typed == null ? "" : typed).trim() !== want) throw new Error("Type " + want + " exactly to continue.");
  return (await sys.check(what.reason, what.detail)).biometric === true;
}
/** The gate of the general command channel: open(command, typed) passes the checks for that exact command; take(command)
 *  is true once, for that exact command, within PASS_MS of open(). Any open() or take() ends an earlier pass.
 *  What the check shows is the WHOLE command (0.19.188, as released 0.18.184): control and bidirectional characters as
 *  spaces, runs of white space as one. A command that cannot be shown whole (over SHOW_MAX) is refused, and so is one that
 *  names a parameter twice: the node keeps the LAST, so "keys action:list" + spaces + "action:genkey" read harmless. */
function create(sys, now) {
  const clock = now || Date.now; let pass = null;
  async function open(command, typed) {
    pass = null;
    const c = String(command == null ? "" : command), { kind, chain } = classify(c); if (!kind) throw new Error("This command needs no check.");
    if (chain) throw new Error(CHAIN);
    const shown = c.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
    const want = kind === "seed" ? SEED_PHRASE : KEY_PHRASE;
    if (String(typed == null ? "" : typed).trim() !== want) throw new Error("Type " + want + " exactly to continue.");
    if (shown.length > SHOW_MAX) throw new Error("This command is longer than the check can show in full (80 characters). Shorten it and run it again. Nothing was run.");
    const twice = V.repeated(c);
    if (twice.length) throw new Error("This command names " + twice.join(", ") + " more than once (the node would keep only the last). Write each parameter once. Nothing was run.");
    const p = { command: shown };
    const system = await check(typed, kind, sys, kind === "seed"
      ? { reason: [N_("show a seed phrase by running: {command}"), p], detail: [N_("This shows a seed phrase. This Terminal command will run once:\n\n{command}"), p] }
      : { reason: [N_("show a private key by running: {command}"), p], detail: [N_("This shows a private key. This Terminal command will run once:\n\n{command}"), p] });
    pass = { command: c, until: clock() + PASS_MS };
    return { system };
  }
  function take(command) { const p = pass; pass = null; return !!p && p.command === String(command) && clock() <= p.until; }
  return { open, take };
}
/** Backup & Recovery's "Show seed phrase": the same checks, then the node's seed. → { phrase, system }. */
async function revealSeed(typed, sys, run) {
  const system = await check(typed, "seed", sys, { reason: N_("show the wallet's seed phrase"), detail: N_("The seed phrase of this wallet will be shown.") });
  const v = ((await run("vault")) || {}).response || {};
  const phrase = v.phrase || v.seedphrase || v.seed || v.mnemonic || "";
  if (typeof phrase !== "string" || !phrase) throw new Error("Couldn't read the seed.");
  return { phrase, system };
}
module.exports = { secretKind, classify, refusal, create, revealSeed, SEED_PHRASE, KEY_PHRASE, PASS_MS, SHOW_MAX };
