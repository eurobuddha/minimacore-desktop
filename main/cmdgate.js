/*
 * cmdgate.js — the general command channel (mcd:cmd: the Terminal, and anything else in the window) and the commands that
 * print a seed or a private key (0.18.173, owner decision: the Terminal GATES them).
 *
 *   vault        every action (the default prints the seed phrase and seed; the others wipe, restore or lock the keys)
 *   seedrandom   every modifier (a value derived from the seed: AtomiX derives its Ethereum private key this way)
 *   keys action:genkey   (prints a new private key)
 *
 * Such a command runs only when a fresh gate was passed in the main process FOR THAT EXACT COMMAND: the typed phrase
 * (SHOW SEED for vault, SHOW KEY for the others) and the system's own prompt where there is one (Touch ID on a Mac that
 * has it). A pass is good for ONE run within 60 seconds and is then gone. A chain (;) that holds one of them is refused:
 * it must be run on its own. Every other command passes unchanged.
 */
const PASS_MS = 60000;
const SHOW_MAX = 80;   // what the Touch ID prompt shows of a command after its fixed words (its reason is cut at 120)
const PHRASE = { seed: "SHOW SEED", key: "SHOW KEY" };
const NAMES = "vault, seedrandom and keys action:genkey";

const V = require("./cmdverb");
/** The secret kind of ONE command (no ";"): "seed", "key" or "". Read the way the node reads it, over-blocking
 *  (main/cmdverb.js, 0.18.174: `"vault"`, U+0001 + vault, va"ul"t, keys action :genkey were run by the node and passed). */
function kindOf(part) {
  if (V.beginsAs(part, "vault")) return "seed";
  if (V.beginsAs(part, "seedrandom")) return "key";
  if (V.beginsAs(part, "keys") && /genkey/.test(V.fold(String(part).replace(/"/g, "")))) return "key";
  return "";
}
/** → { kind: "seed"|"key"|"", chain: bool }: the strongest kind anywhere in the text (the node splits on every ";"). */
function classify(command) {
  const parts = V.parts(command);
  let kind = "";
  for (const p of parts) { const k = kindOf(p); if (k === "seed" || (k && !kind)) kind = k; }
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
    if (String(typed == null ? "" : typed).trim() !== PHRASE[kind]) throw new Error("Type " + PHRASE[kind] + " exactly to continue.");
    if (!sys || typeof sys.check !== "function") throw new Error("No system check is available. Nothing was run.");
    // What the check shows is the WHOLE command (0.18.184): it used to show the first 80 / 600 characters and approve the
    // rest, and the node keeps the LAST repeated parameter, so "keys action:list" + spaces + "action:genkey" read harmless.
    // Control and bidirectional characters become spaces and runs of white space one space; a command that cannot be
    // shown whole in the Touch ID prompt is refused, and so is one that repeats a parameter. The pass is bound to the
    // exact text that was asked about.
    const shown = c.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
    if (shown.length > SHOW_MAX) throw new Error("This command is longer than the check can show in full (" + SHOW_MAX + " characters). Shorten it and run it again. Nothing was run.");
    const twice = V.repeated(c);
    if (twice.length) throw new Error("This command names " + twice.join(", ") + " more than once (the node would keep only the last). Write each parameter once. Nothing was run.");
    const what = kind === "seed" ? "a seed phrase" : "a private key";
    const s = await sys.check("show " + what + " by running: " + shown, "This shows " + what + ". This Terminal command will run once:\n\n" + shown);
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

/** Why mcd:cmd refuses this command ("" = it may run). take: the gate's take. */
function refusal(command, take) {
  const { kind, chain } = classify(command);
  if (!kind) return "";
  if (chain) return "GATED: this chain holds " + NAMES + ", which show a seed or a private key. Run that command on its own.";
  if (take(command)) return "";
  return "GATED:" + kind + ": " + NAMES + " show a seed or a private key; this one shows " + (kind === "seed" ? "the seed phrase" : "a private key") + ". Type " + PHRASE[kind] + " to run it.";
}

module.exports = { classify, create, refusal, PHRASE, PASS_MS };
