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
    // the Touch ID reason and the confirmation name the exact command (0.18.176), cut to what the prompt can show
    const one = c.replace(/[\u0000-\u001f\u007f]/g, " ");
    const s = await sys.check("run the Terminal command " + one.slice(0, 80), "This Terminal command will run once and its answer will be shown:\n\n" + one.slice(0, 600));
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
