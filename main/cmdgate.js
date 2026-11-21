/*
 * cmdgate.js — the general command channel (mcd:cmd: the Terminal, and anything else in the window) and the commands that
 * print a seed or a private key (0.18.173, owner decision: the Terminal GATES them).
 *
 *   vault        every action (the default prints the seed phrase and seed; the others wipe, restore or lock the keys)
 *   seedrandom   every modifier (a value derived from the seed: AtomiX derives its Ethereum private key this way)
 *   keys action:genkey   (prints a new private key)
 *
 * Such a command runs only when a fresh gate was passed in the main process FOR THAT EXACT COMMAND: the typed phrase
 * (SHOW SEED for vault, SHOW KEY for the others, CHANGE KEYS for the vault actions that change the keys: 0.18.196) and the
 * system's own prompt where there is one (Touch ID on a Mac that has it). The check shows the command with the VALUES of
 * phrase, password, confirm and seed hidden (0.18.196: it printed them, and an 80-character cap made a restore with a
 * 24-word phrase impossible); only the Touch ID prompt, which cannot show more, refuses a command too long for it. A pass is good for ONE run within 60 seconds and is then gone. A chain (;) that holds one of them is refused:
 * it must be run on its own. Every other command passes unchanged.
 */
const PASS_MS = 60000;
const PHRASE = { seed: "SHOW SEED", key: "SHOW KEY", change: "CHANGE KEYS" };
// vault actions that change the wallet's keys or their lock rather than show the seed (the node's vault help, and the
// Terminal's completion list: wipekeys, restorekeys, passwordlock, passwordunlock, resetkeys, testphrase)
const CHANGE_ACTIONS = new Set(["wipekeys", "restorekeys", "passwordlock", "passwordunlock", "resetkeys", "testphrase"]);
const WHAT = { seed: "a seed phrase", key: "a private key", change: "changes to this wallet's keys" };
const NAMES = "vault, seedrandom and keys action:genkey";

const V = require("./cmdverb");
/** The secret kind of ONE command (no ";"): "seed", "key" or "". Read the way the node reads it, over-blocking
 *  (main/cmdverb.js, 0.18.174: `"vault"`, U+0001 + vault, va"ul"t, keys action :genkey were run by the node and passed). */
function kindOf(part) {
  if (V.beginsAs(part, "vault")) { const a = V.paramValue(part, "action"); return a != null && CHANGE_ACTIONS.has(V.fold(a)) ? "change" : "seed"; }
  if (V.beginsAs(part, "seedrandom")) return "key";
  if (V.beginsAs(part, "keys") && /genkey/.test(V.fold(String(part).replace(/"/g, "")))) return "key";
  return "";
}
/** → { kind: "seed"|"key"|"", chain: bool }: the strongest kind anywhere in the text (the node splits on every ";"). */
function classify(command) {
  const parts = V.parts(command);
  let kind = "";
  const rank = { "": 0, change: 1, key: 2, seed: 3 };
  for (const p of parts) { const k = kindOf(p); if (rank[k] > rank[kind]) kind = k; }
  return { kind, chain: parts.length > 1 };
}

/** gate(sys, now?) → { arm(command, typed) → { system, kind }, take(command) → bool }. sys: main/syscheck.js. */
function create(sys, now) {
  const clock = now || Date.now;
  let pass = null;   // { command, until }
  async function arm(command, typed) {
    pass = null;   // any try, passed or not, clears an earlier pass (0.18.174)
    const c = String(command == null ? "" : command), { kind, chain } = classify(c);
    if (!kind) throw new Error("This command needs no check.");
    if (chain) throw new Error("Run this command on its own, not in a chain with ;.");
    const twice = V.repeated(c);   // before the phrase: what the phrase is depends on the action, and the node keeps the last one
    if (twice.length) throw new Error("This command names " + twice.join(", ") + " more than once (the node would keep only the last). Write each parameter once. Nothing was run.");
    if (String(typed == null ? "" : typed).trim() !== PHRASE[kind]) throw new Error("Type " + PHRASE[kind] + " exactly to continue.");
    if (!sys || typeof sys.check !== "function") throw new Error("No system check is available. Nothing was run.");
    // What the check shows is the WHOLE command (0.18.184): it used to show the first 80 / 600 characters and approve the
    // rest, and the node keeps the LAST repeated parameter, so "keys action:list" + spaces + "action:genkey" read harmless.
    // Control and bidirectional characters become spaces and runs of white space one space; a command that cannot be
    // shown whole in the Touch ID prompt is refused, and so is one that repeats a parameter. The pass is bound to the
    // exact text that was asked about.
    const shown = masked(c);
    const what = WHAT[kind];
    const s = await sys.check((kind === "change" ? "make " : "show ") + what + " by running: " + shown, (kind === "change" ? "This makes " : "This shows ") + what + ". This Terminal command will run once:\n\n" + shown);
    pass = { command: c, until: clock() + PASS_MS };
    return { system: s.biometric === true, kind };
  }
  /** Used up by the one command it was passed for; a different command, a second run or a late one finds nothing. */
  function take(command) {
    const p = pass; pass = null;
    return !!(p && p.command === String(command) && clock() <= p.until);
  }
  return { arm, take };
}

/** The command as the check shows it: control and bidirectional characters as spaces, white space collapsed, and the
 *  values of phrase, password, confirm and seed hidden (quoted or not). */
function masked(c) {
  return String(c).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/((?:^|\s|")(?:phrase|password|confirm|seed)"?\s*:\s*)("[^"]*"|\S+)/gi, "$1•••")
    .replace(/\s+/g, " ").trim();
}
/** Why mcd:cmd refuses this command ("" = it may run). take: the gate's take. */
function refusal(command, take) {
  const { kind, chain } = classify(command);
  if (!kind) return "";
  if (chain) return "GATED: this chain holds " + NAMES + ", which show a seed or a private key. Run that command on its own.";
  if (take(command)) return "";
  return "GATED:" + kind + ": " + NAMES + " show a seed or a private key or change the keys; this one " + (kind === "seed" ? "shows the seed phrase" : kind === "key" ? "shows a private key" : "changes this wallet's keys or their lock") + ". Type " + PHRASE[kind] + " to run it.";
}

/**
 * checkCommand(command, io) (0.18.201): everything mcd:cmd decides before a text reaches the node, in order:
 *   1. a non-empty string;  2. no control character (tab and line end allowed; the node trims and reads the others in
 *   ways no check here can follow);  3. a send that names amount, tokenid, address or fromaddress twice is refused (the
 *   node keeps the last; the pin and every review read one);  4. the secret-command gate (refusal);  5. the node running
 *   (io.running() throws if not);  6. the beacon-dust pin of a MINIMA send (io.pin). → the text to run; throws the reason.
 */
async function checkCommand(command, io) {
  if (typeof command !== "string" || !command.trim()) throw new Error("empty command");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error("This command holds a control character. Type it again without one.");
  for (const part of V.parts(command)) {
    if (!V.is(part, "send")) continue;
    const twice = V.repeated(part, ["amount", "tokenid", "address", "fromaddress"]);
    if (twice.length) throw new Error("This send names " + twice.join(", ") + " more than once (the node would use only the last). Write each once.");
  }
  const gated = refusal(command, io.take); if (gated) throw new Error(gated);
  io.running();
  return io.pin ? await io.pin(command) : command;
}

module.exports = { classify, create, refusal, masked, checkCommand, PHRASE, PASS_MS };
