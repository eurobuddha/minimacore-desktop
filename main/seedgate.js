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
const SEED_PHRASE = "SHOW SEED", KEY_PHRASE = "SHOW KEY", CHANGE_PHRASE = "CHANGE KEYS", PASS_MS = 60000;
const PHRASE = { seed: SEED_PHRASE, key: KEY_PHRASE, change: CHANGE_PHRASE, secret: KEY_PHRASE };
// vault actions that change the wallet's keys or their lock rather than show the seed (0.19.227, as released 0.18.196); resetkeys
// never gets here: the command channel refuses it (main/restore.js replacesKeysElsewhere)
const CHANGE_ACTIONS = new Set(["wipekeys", "restorekeys", "passwordlock", "passwordunlock", "resetkeys", "testphrase"]);

const V = require("./cmdverb");
/** The secret kind of ONE command (no ";"): "seed", "key" or "". Read the way the node reads it, over-blocking
 *  (main/cmdverb.js, 0.19.187, as the released desktop's cmdgate.js 0.18.174: `"vault"`, a control character before
 *  vault, va"ul"t, keys "action":genkey and keys action :genkey were run by the node and passed the old split on spaces). */
function kindOf(part) {
  if (V.beginsAs(part, "vault")) { const a = V.paramValue(part, "action"); return a != null && CHANGE_ACTIONS.has(V.fold(a)) ? "change" : "seed"; }
  if (V.beginsAs(part, "seedrandom")) return "key";
  if (V.beginsAs(part, "keys") && /genkey/.test(V.fold(String(part).replace(/"/g, "")))) return "key";
  // what the user asks for by name and the reply carries (0.19.292): the RPC users' passwords, the MiniHUB password (mds list,
  // mds/mds.java), a SPHINCS private key (sphincs action:generate): shown behind SHOW KEY and the system's check, never hidden
  const a = V.fold(V.paramValue(part, "action") || "");
  if ((V.is(part, "rpc") && a === "listusers") || (V.is(part, "mds") && (a === "" || a === "list")) || (V.is(part, "sphincs") && a === "generate")) return "secret";
  return "";
}
/** → { kind: "seed" | "key" | "", chain }: the strongest kind anywhere in the text (the node splits on every ";"). */
function classify(command) {
  const parts = V.parts(command);
  let kind = "";
  const rank = { "": 0, change: 1, key: 2, secret: 2, seed: 3 };
  for (const p of parts) { const k = kindOf(p); if (rank[k] > rank[kind]) kind = k; }
  return { kind, chain: parts.length > 1 };
}
/** "seed", "key", "change" or null (any command of a ";" chain counts). */
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
    : kind === "change" ? "This vault command changes this wallet's keys or their lock. Type CHANGE KEYS in the Terminal to run it."
    : kind === "secret" ? "This command shows passwords or a private key (rpc action:listusers, mds, sphincs action:generate). Type SHOW KEY in the Terminal to run it."
    : "vault, seedrandom and keys action:genkey show a seed or a private key; this one shows a private key. Type SHOW KEY in the Terminal to run it.";
}
const { N_ } = require("./lang").I18N;
/** The command as the check shows it (0.19.227, as released 0.18.196): control and bidirectional characters as spaces,
 *  white space collapsed, and the VALUES of phrase, password, confirm and seed hidden, quoted or not. */
// The secret parameters of the node's commands (core/minima-core commands, every getParam of them: phrase, password, confirm,
// seed, privatekey; 0.19.282 added privatekey: sendfrom, signfrom, consolidatefrom, createtokenfrom, txnsign, sphincs).
const SECRET_NAMES = ["phrase", "password", "confirm", "seed", "privatekey"];
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
/** The command as the node reads it, name by name, the value of every secret parameter hidden and everything else shown (0.19.293:
 *  hiding the words after a value hid the ACTION of `vault phrase: action:restorekeys`, which the node reads as phrase "" and
 *  action restorekeys). A piece the node would refuse (a word with no ":") is hidden the older way. */
function masked(c) {
  const show = (v) => (v === "" ? '""' : /\s/.test(v) && !/^[{[]/.test(v) ? '"' + v + '"' : v);
  return V.parts(String(c).replace(CTRL, " ")).map(p => {
    const r = V.read(p);
    if (r.error || !r.verb) return maskedWords(p);
    // a secret of several words says how many (0.19.299; 0.19.306 as the released 0.18.230): the user sees that password:"pw burn:500"
    // is more than a password. A count, not one ••• a word: 24 of those made a 24-word restore longer than the Touch ID prompt shows
    const hide = (v) => { const w = v.split(/\s+/).filter(Boolean); return w.length > 1 ? '"••• (' + w.length + ' words)"' : "•••"; };
    return [r.verb].concat(r.params.map(([n, v]) => n + ":" + (SECRET_NAMES.includes(V.fold(n)) && v !== "" ? hide(v) : show(v)))).join(" ");
  }).join(" ; ");
}
function maskedWords(c) {
  const words = String(c).replace(CTRL, " ")
    // hidden through the end of the node's token (0.19.266): a quote inside a value opens a quoted span the node keeps in the same
    // value (`password:my"secret` showed `"secret`; `seed:0xAB"action":"wipekeys"` is ONE seed value to the node, no action)
    .replace(new RegExp("((?:^|\\s|\")(?:" + SECRET_NAMES.join("|") + ")\"?\\s*:\\s*)((?:\"[^\"]*\"?|[^\\s\"])+)", "gi"), "$1•••")
    .replace(/\s+/g, " ").trim().split(" ");
  // the words after a hidden value up to the next name:value are hidden too (0.19.282): the node drops them or joins them to the
  // value (`phrase:spray lamp` showed `lamp`, a 24-word phrase typed unquoted showed 23 words)
  // Said as a count, as masked() says several words (0.19.311): `phrase:"••• (4 words)"`, never one ••• a word on any surface
  let hiding = false, start = -1; const follow = new Array(words.length).fill(0), out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/•••"?$/.test(w) && (w.includes(":") || words[i - 1] === ":")) { hiding = true; start = i; continue; }   // a hidden name:value starts a run; a bare ••• is one of its words
    if (hiding) { if (w.includes(":") || /^:/.test(words[i + 1] || "")) hiding = false; else { follow[start]++; words[i] = null; } }   // a name ends it, also one spaced from its ":"
  }
  for (let i = 0; i < words.length; i++) if (words[i] !== null) out.push(follow[i] ? words[i].replace(/"?•••"?$/, '"••• (' + (follow[i] + 1) + ' words)"') : words[i]);
  return out.join(" ");
}
/** The secret words a typed command carries (0.19.292): each secret parameter's value as the node reads it and its words, and the
 *  bare words after one that the node drops or joins (the ones masked() hides), three characters or more. */
function secretWords(command) {
  const out = new Set(), add = (w) => { w = String(w).replace(/"/g, ""); if (w.length >= 3) out.add(w); };
  for (const p of V.parts(command)) for (const [n, v] of V.read(p).params) if (SECRET_NAMES.includes(V.fold(n)) && v) { add(v); v.split(/\s+/).forEach(add); }
  const words = String(command).split(/[\s\u0000-\u001f]+/), name = new RegExp("^\"?(?:" + SECRET_NAMES.join("|") + ")\"?:", "i");
  let hiding = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (name.test(w)) { add(w.replace(/^[^:]*:/, "")); hiding = true; continue; }
    if (hiding) { if (w.includes(":") || /^:/.test(words[i + 1] || "")) hiding = false; else add(w); }
  }
  return [...out].sort((a, b) => b.length - a.length);
}
const wordRe = (w) => new RegExp("(^|[^A-Za-z0-9])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[^A-Za-z0-9])", "g");
/** A reply of the node with nothing secret of the typed command in it: the values of secret parameters wherever it carries its
 *  "params" (0.19.282, Command.getJSONReply echoes every parameter), every "command" string masked (0.19.292: for an invalid
 *  parameter the node answers with the whole typed text, CommandRunner.java), and each secret word of the typed command, as a
 *  whole word, in every other string (an error like "Invalid parameters for vault @ lamp" names a word of an unquoted phrase). */
function scrubReply(r, command) {
  const res = command == null ? [] : secretWords(command).map(wordRe);
  const str = (s) => res.reduce((t, re) => t.replace(re, "$1•••"), s);
  const walk = (x, depth, key) => {
    if (typeof x === "string") return key === "command" ? masked(str(x)) : str(x);
    if (!x || typeof x !== "object" || depth > 8) return x;
    if (Array.isArray(x)) return x.map(y => walk(y, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === "params" && v && typeof v === "object" && !Array.isArray(v)) { out[k] = {}; for (const [n, y] of Object.entries(v)) out[k][n] = SECRET_NAMES.includes(V.fold(n)) ? "•••" : walk(y, depth + 1); }
      else out[k] = walk(v, depth + 1, k);
    }
    return out;
  };
  return walk(r, 0);
}
/** The typed phrase, then the system's own check (main/syscheck.js, 0.19.188: Touch ID; refused while a Touch ID that
 *  worked before cannot be asked; a message box naming what is shown where there never was one). what = { reason, detail }
 *  as syscheck takes them. -> whether a Touch ID check took place. */
async function check(typed, kind, sys, what) {
  const want = PHRASE[kind];
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
    const unclear = V.unclear(c) || V.smuggled(c); if (unclear) throw new Error(unclear);
    // a secret parameter the node reads as empty (0.19.293): `vault phrase: action:restorekeys` would run with phrase ""
    for (const p of V.parts(c)) for (const [n, v] of V.read(p).params) if (SECRET_NAMES.includes(V.fold(n)) && v === "") throw new Error("This command names " + n + ": with no value, and the node would read it as empty. Write its value, or leave it out. Nothing was run.");   // read otherwise than it looks (0.19.266), an escaped ";" (0.19.291): refused before any question
    // a repeated parameter first (released 0.18.202): what the phrase is depends on the action, and the node keeps the last
    const twice = V.repeated(c);
    if (twice.length) throw new Error("This command names " + twice.join(", ") + " more than once (the node would keep only the last). Write each parameter once. Nothing was run.");
    const want = PHRASE[kind];
    if (String(typed == null ? "" : typed).trim() !== want) throw new Error("Type " + want + " exactly to continue.");
    // shown with its secret values hidden and no length cap of its own (0.19.227): a message box shows any length; only
    // the Touch ID prompt, which cannot show more than 120 characters, refuses what it cannot show whole (main/syscheck.js)
    const p = { command: masked(c) };
    const system = await check(typed, kind, sys, kind === "seed"
      ? { reason: [N_("show a seed phrase by running: {command}"), p], detail: [N_("This shows a seed phrase. This Terminal command will run once:\n\n{command}"), p] }
      : kind === "change" ? { reason: [N_("change this wallet's keys by running: {command}"), p], detail: [N_("This changes this wallet's keys or their lock. This Terminal command will run once:\n\n{command}"), p] }
      : kind === "secret" ? { reason: [N_("show passwords or a private key by running: {command}"), p], detail: [N_("This shows passwords or a private key. This Terminal command will run once:\n\n{command}"), p] }
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
/**
 * checkCommand(command, io) (0.19.327, as released 0.18.201): everything the general command channel (mcd:cmd) decides before a
 * text reaches the node, in one tested place and in this order (the order main.js had; the first refusal is the one said):
 *   1. a non-empty string;  2. no control character (tab and line end allowed);  3. a command that moves funds or keys whose text
 *   the node reads otherwise than it looks (cmdverb.unclear, 0.19.266);  4. an escaped ";" or control character (cmdverb.smuggled,
 *   0.19.291);  5. a value that would rewrite the commands a builder makes from it (cmdverb.builtProblem, 0.19.299);  6. per piece:
 *   a send naming amount, tokenid, address or fromaddress twice; a parameter named twice by a command that moves funds from a key
 *   or builds commands of its own; rpc, slavenode enable:, webhooks action:add and mds actions; a file on another computer; mds
 *   action:accept; a multisig spend;  7. keyuses: past the last one-time use of the wallet's key mode (restore.keyusesProblem, io.keyMode(),
 *   0.19.325);  8. keys replaced or a backup loaded outside Backup & Recovery (restore.replacesKeysElsewhere, which also holds the
 *   re-pasted values of 0.19.281);  9. the node running (io.running() throws if not);  10. the secret-command gate (refusal, io.take);
 *   11. a backup file (restore.loadsBackupFile);  12. a wallet replaced from a phrase while work that needs the old keys is open
 *   (io.walletWork());  13. restore.backupCommandProblem.
 * io = { take, running, walletWork, keyMode } (main.js passes secretGate.take, requireRunning, walletWork and the recorded key mode).
 * Throws the reason; returns nothing. The stop guard, the beacon-dust pin and the run stay in main.js, where the node is driven.
 */
async function checkCommand(command, io) {
  const R = require("./restore");
  if (typeof command !== "string" || !command.trim()) throw new Error("empty command");
  // control characters refused (0.19.187, released 0.18.174): the node reads them in ways no check here follows
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error("This command holds a control character. Type it again without one.");
  // a command that moves funds or keys whose text the node reads otherwise than it looks is refused, not guessed (0.19.266, main/cmdverb.js read)
  const unclear = V.unclear(command); if (unclear) throw new Error(unclear);
  // an escaped ";" (\u003b) the node decodes in a JSON value and a command it builds from it then runs as a second command (0.19.291)
  const smuggled = V.smuggled(command); if (smuggled) throw new Error(smuggled);
  // a value that would rewrite the commands a sendfrom, rawfrom, multisig … builds from it (0.19.299)
  for (const part of V.parts(command)) { const built = V.builtProblem(part); if (built) throw new Error(built); }
  for (const part of V.parts(command)) {
    // a send naming amount, tokenid, address or fromaddress twice is refused (0.19.191, released 0.18.187): the node keeps the LAST
    const twice = V.is(part, "send") ? V.repeated(part, ["amount", "tokenid", "address", "fromaddress"]) : [];
    if (twice.length) throw new Error("This send names " + twice.join(", ") + " more than once (the node would use only the last). Write each once.");
    // the commands that move funds from a key or build commands of their own: any parameter named twice (0.19.291)
    if (["sendpoll", "sendfrom", "signfrom", "consolidatefrom", "createtokenfrom", "multisig", "multisigread", "sphincs"].some(v => V.is(part, v))) {
      const again = V.repeated(part); if (again.length) throw new Error("This command names " + again.join(", ") + " more than once (the node would use only the last). Write each once. Nothing was run.");
    }
    // a MiniDapp's waiting command runs with full rights past every check here; a multisig spend copies a coin's state from the chain
    // into commands the node runs itself, where a ";" starts a second command, and this app cannot read that state first (0.19.291)
    const action = V.fold(V.paramValue(part, "action") || "");
    // what hands the node to someone else or sends its events out (0.19.298, read from core/minima-core: network/rpc.java enable:
    // (no password turns RPC authentication off), password: (replaces the app's own), action:adduser / removeuser; base/slavenode.java
    // enable: (a master node); network/webhooks.java action:add (node events to any URL); mds/mds.java every action but list):
    // refused; rpc with no parameter (its status) and the gated rpc action:listusers / mds list are not
    const names = V.paramNames(part);
    if ((V.is(part, "rpc") && !(names.length === 0 || (names.length === 1 && names[0] === "action" && action === "listusers")))
      || (V.is(part, "slavenode") && names.includes("enable")) || (V.is(part, "webhooks") && action === "add")
      || (V.is(part, "mds") && action !== "" && action !== "list" && action !== "accept"))
      throw new Error("This command would open this node to someone else or send its events out (the RPC login or password, a master node, a web hook, MiniDapps). This app never needs that, so it is not run from the Terminal. Nothing was run.");
    // a file on another computer (a UNC path, \\host\share, //host/share or a mix of the two slashes): a Windows node would connect to
    // that share (0.19.303); for EVERY command since 0.19.309 (txnimport, txnexport, txnview, hash, sphincs, multisig, the send…view
    // family and peers action:publish read files too: every MiniFile.createBaseFile / new File of a parameter is file, folder,
    // archivefile or output (0.19.317: decryptbackup writes the DECRYPTED wallet to output:), and any …file name is taken with them;
    // a name is matched folded, which over-blocks a name the node would not read as file (harmless))
    if (V.read(part).params.some(([n, v]) => /^(?:folder|output|\w*file)$/.test(V.fold(n)) && /^[\\/](?:[\\/]|\?\?[\\/])/.test(v)))   // and the NT prefix \??\ (0.19.318: \??\UNC\host\share is a share to Windows)
      throw new Error("A file on another computer (a path that starts with \\\\ or //) is not used: the node would connect to it. Copy the file to this computer first. Nothing was run.");
    if (V.is(part, "mds") && action === "accept") throw new Error("mds action:accept runs a MiniDapp's waiting command with full rights, past every check of this app. It is not run from the Terminal. Nothing was run.");
    if ((V.is(part, "multisig") || V.is(part, "multisigread")) && action === "spend") throw new Error("A multisig spend copies the coin's state from the chain into commands the node runs itself, where it could start a second command, and this app cannot read that state first. It is not run from the Terminal. Nothing was run.");
  }
  // keyuses: past a key's last one-time use for this wallet's key mode, digits only (0.19.325, main/restore.js keyusesProblem): typed, or
  // built by the restore screens (setup restore, Backup & Recovery's rebuild), which all reach the node through here
  let mode = ""; try { mode = io.keyMode(); } catch (e) { mode = ""; }
  const kuBad = R.keyusesProblem(command, mode); if (kuBad) throw new Error(kuBad);
  // archive / mysql / reset with a phrase or a backup, vault action:resetkeys: the keys change with no engine held and no key-mode check (0.19.218)
  if (R.replacesKeysElsewhere(command)) throw new Error("This command replaces this wallet's keys or loads a backup outside Backup & Recovery, which checks the key mode and stops the trading engines first. Use Backup & Recovery. Nothing was run.");
  io.running();
  // vault / seedrandom / keys genkey read as the node reads them: only with a pass; a chain is refused. The deciding check.
  const gated = refusal(command, io.take); if (gated) throw new Error(gated);
  // A backup file brings its own keys, in its own key mode: only Backup & Recovery restores one, after the mode check.
  if (R.loadsBackupFile(command)) throw new Error("Restoring a backup file replaces this wallet's keys. Use Backup & Recovery, Restore from file: it checks the backup's key mode first.");
  // Replacing the wallet from a seed phrase resets every identity made from the old one: refused while work that needs the old keys is open.
  if (R.replacesWalletFromPhrase(command)) { const open = R.activeWorkProblem(await io.walletWork()); if (open) throw new Error(open); }
  const bad = R.backupCommandProblem(command);
  if (bad) throw new Error(bad);
}
module.exports = { secretKind, classify, refusal, create, revealSeed, masked, scrubReply, checkCommand, SECRET_NAMES, SEED_PHRASE, KEY_PHRASE, CHANGE_PHRASE, PASS_MS };
