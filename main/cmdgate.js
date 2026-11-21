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
const P = require("./phrases");
const PHRASE = { seed: P.SHOW_SEED, key: P.SHOW_KEY, change: P.CHANGE_KEYS, secret: P.SHOW_KEY };
// vault actions that change the wallet's keys or their lock rather than show the seed (the node's vault help, and the
// Terminal's completion list: wipekeys, restorekeys, passwordlock, passwordunlock, resetkeys, testphrase)
const CHANGE_ACTIONS = new Set(["wipekeys", "restorekeys", "passwordlock", "passwordunlock", "resetkeys", "testphrase"]);
const WHAT = { seed: "a seed phrase", key: "a private key", change: "changes to this wallet's keys", secret: "passwords or a private key" };
const NAMES = "vault, seedrandom and keys action:genkey";

const V = require("./cmdverb");
/** The secret kind of ONE command (no ";"): "seed", "key" or "". Read the way the node reads it, over-blocking
 *  (main/cmdverb.js, 0.18.174: `"vault"`, U+0001 + vault, va"ul"t, keys action :genkey were run by the node and passed). */
function kindOf(part) {
  if (V.beginsAs(part, "vault")) { const a = V.paramValue(part, "action"); return a != null && CHANGE_ACTIONS.has(V.fold(a)) ? "change" : "seed"; }
  if (V.beginsAs(part, "seedrandom")) return "key";
  if (V.beginsAs(part, "keys") && /genkey/.test(V.fold(String(part).replace(/"/g, "")))) return "key";
  // what the user asks for by name and the reply carries (0.18.222, as Pandamonium Desktop 0.19.292): the RPC users' passwords, the
  // MiniHUB password (mds list, mds/mds.java), a SPHINCS private key (sphincs action:generate): shown behind SHOW KEY and the system's
  // check, never hidden from the one who asked
  const a = V.fold(V.paramValue(part, "action") || "");
  if ((V.is(part, "rpc") && a === "listusers") || (V.is(part, "mds") && (a === "" || a === "list")) || (V.is(part, "sphincs") && a === "generate")) return "secret";
  return "";
}
/** → { kind: "seed"|"key"|"", chain: bool }: the strongest kind anywhere in the text (the node splits on every ";"). */
function classify(command) {
  const parts = V.parts(command);
  let kind = "";
  const rank = { "": 0, change: 1, key: 2, secret: 2, seed: 3 };
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
    const unclear = V.unclear(c) || V.smuggled(c); if (unclear) throw new Error(unclear);   // read otherwise than it looks (0.18.219), an escaped ";" (0.18.221): refused before any question
    // a secret parameter the node reads as empty (0.18.222): `vault phrase: action:restorekeys` would run with phrase ""
    for (const p of V.parts(c)) for (const [n, v] of V.read(p).params) if (SECRET_NAMES.includes(V.fold(n)) && v === "") throw new Error("This command names " + n + ": with no value, and the node would read it as empty. Write its value, or leave it out. Nothing was run.");
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
    const s = await sys.check((kind === "change" ? "make " : "show ") + what + " by running: " + shown, (kind === "change" ? "This makes " : "This shows ") + what + ". This Terminal command will run once:\n\n" + shown);   // what = WHAT[kind], "secret" included (0.18.222)
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

// The secret parameters of the node's commands (core/minima-core commands, every getParam of them: phrase, password, confirm, seed,
// privatekey; 0.18.222, as Pandamonium Desktop 0.19.282, added privatekey: sendfrom, signfrom, consolidatefrom, createtokenfrom,
// txnsign, sphincs).
const SECRET_NAMES = ["phrase", "password", "confirm", "seed", "privatekey"];
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
/** The command as the check, the Touch ID text and the Terminal echo show it (0.18.222, as Pandamonium Desktop 0.19.293): as the
 *  node reads it, name by name (main/cmdverb.js read), the value of every secret parameter hidden and everything else shown, an
 *  empty value shown as "" (hiding the words after a value hid the ACTION of `vault phrase: action:restorekeys`, which the node
 *  reads as phrase "" and action restorekeys). A piece the node would refuse (a word with no ":") is hidden the older way. */
function masked(c) {
  const show = (v) => (v === "" ? '""' : /\s/.test(v) && !/^[{[]/.test(v) ? '"' + v + '"' : v);
  return V.parts(String(c).replace(CTRL, " ")).map(p => {
    const r = V.read(p);
    if (r.error || !r.verb) return maskedWords(p);
    // a secret of several words says how many (0.18.230): the user sees that password:"pw burn:500" is more than a password. Said as a
    // count, not one ••• a word as Pandamonium Desktop 0.19.299 does: 24 of those made a restore with a 24-word phrase longer than the
    // Touch ID prompt can show (120 characters), so it could no longer be armed on a Mac with Touch ID (0.18.196 requires it)
    const hide = (v) => { const w = v.split(/\s+/).filter(Boolean); return w.length > 1 ? '"••• (' + w.length + ' words)"' : "•••"; };
    return [r.verb].concat(r.params.map(([n, v]) => n + ":" + (SECRET_NAMES.includes(V.fold(n)) && v !== "" ? hide(v) : show(v)))).join(" ");
  }).join(" ; ");
}
function maskedWords(c) {
  const words = String(c).replace(CTRL, " ")
    // hidden through the end of the node's token (0.18.219): a quote inside a value opens a quoted span the node keeps in the same
    // value (`password:my"secret` showed `"secret`; `seed:0xAB"action":"wipekeys"` is ONE seed value to the node, no action)
    .replace(new RegExp("((?:^|\\s|\")(?:" + SECRET_NAMES.join("|") + ")\"?\\s*:\\s*)((?:\"[^\"]*\"?|[^\\s\"])+)", "gi"), "$1•••")
    .replace(/\s+/g, " ").trim().split(" ");
  // the words after a hidden value up to the next name:value are hidden too (0.18.222): the node drops them or joins them to the
  // value (`phrase:spray lamp` showed `lamp`, a 24-word phrase typed unquoted showed 23 words)
  // Said as a count, as masked() says several words (0.18.246, as Pandamonium Desktop 0.19.311): `phrase:"••• (4 words)"`, never one
  // ••• a word on any surface (a 24-word phrase typed unquoted no longer overruns the Touch ID prompt either)
  let hiding = false, start = -1; const follow = new Array(words.length).fill(0), out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/•••"?$/.test(w) && (w.includes(":") || words[i - 1] === ":")) { hiding = true; start = i; continue; }   // a hidden name:value starts a run; a bare ••• is one of its words
    if (hiding) { if (w.includes(":") || /^:/.test(words[i + 1] || "")) hiding = false; else { follow[start]++; words[i] = null; } }   // a name ends it, also one spaced from its ":"
  }
  for (let i = 0; i < words.length; i++) if (words[i] !== null) out.push(follow[i] ? words[i].replace(/"?•••"?$/, '"••• (' + (follow[i] + 1) + ' words)"') : words[i]);
  return out.join(" ");
}
/** The secret words a typed command carries (0.18.222): each secret parameter's value as the node reads it and its words, and the
 *  bare words after one that the node drops or joins (the ones maskedWords() hides), three characters or more. */
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
/** A reply of the node with nothing secret of the typed command in it (0.18.222, as Pandamonium Desktop 0.19.282 / 0.19.292): the
 *  values of secret parameters wherever it carries its "params" (Command.getJSONReply echoes every parameter, so a megammrsync
 *  phrase:, a backup password: or a sendfrom privatekey: came back whole to the window), every "command" string masked (for an
 *  invalid parameter the node answers with the whole typed text, CommandRunner.java), and each secret word of the typed command,
 *  as a whole word, in every other string (an error like "Invalid parameters for vault @ lamp" names a word of an unquoted phrase). */
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
/** Why mcd:cmd refuses this command ("" = it may run). take: the gate's take. */
function refusal(command, take) {
  const { kind, chain } = classify(command);
  if (!kind) return "";
  if (chain) return "GATED: this chain holds " + NAMES + ", which show a seed or a private key. Run that command on its own.";
  if (take(command)) return "";
  if (kind === "secret") return "GATED:secret: this command shows passwords or a private key (rpc action:listusers, mds, sphincs action:generate). Type " + PHRASE[kind] + " to run it.";
  return "GATED:" + kind + ": " + NAMES + " show a seed or a private key or change the keys; this one " + (kind === "seed" ? "shows the seed phrase" : kind === "key" ? "shows a private key" : "changes this wallet's keys or their lock") + ". Type " + PHRASE[kind] + " to run it.";
}

// Commands whose VALUES the node pastes, unquoted, into a second command it then runs itself (0.18.220, as Pandamonium Desktop
// 0.19.281 / 0.19.291 / 0.19.296, read from core/minima-core commands): backup/reset.java chainsync / seedsync / restore ->
// "archive action:import file:" + archivefile …; backup/archive.java import / importold / importraw -> "archive action:resync
// host:… keys:" + keys + " keyuses:" … " anyphrase:" …; backup/mysql.java reset -> "mysql action:rawimport file:" + file;
// search/txpow.java -> "mysql action:findtxpow txpowid:" + txpowid; mysql setlogin stores host, user, password and database,
// which the node's autobackup pastes into "mysql host:" + host + " … password:" + password + " action:update" (there a ":"
// stays inside its own token, so only white space, a quote or ";" count). A value holding white space, ":", a quote or ";"
// there becomes more parameters of that second command (phrase: among them), so it is refused. A Windows path in a file
// parameter (C:\backup\a.gz: a drive letter, ":\" and no white space, ":", quote, ";" or bracket after it) adds none.
const WIN_PATH = /^[A-Za-z]:\\[^\s:";{}[\]]*$/;
const REPASTED = { reset: () => /[\s:";]/, archive: (a) => (/^(import|importold|importraw)$/.test(a) ? /[\s:";]/ : null),
  mysql: (a) => (a === "reset" ? /[\s:";]/ : a === "setlogin" ? /[\s";]/ : null), txpow: () => /[\s:";]/ };
const REPASTED_WHY = "The node pastes this command's values, unquoted, into a second command it runs itself, where white space, a colon, a quote or a semicolon in a value become more parameters of that command (a seed phrase among them). Write each value without them. Nothing was run.";
// keyuses: (0.18.269; two bounds since 0.18.273). Read from each command in core/minima-core:
//   SET every key's uses (wallet.updateAllKeyUses(getAsInt())): megammrsync resync (megammrsync.java:175/217, default 1000), archive
//     resync / import (archive.java:349/408, default 1000), mysql resync (mysql.java:474/512, default 1000), reset (reset.java:99 hands it
//     on to archive import), vault resetkeys (vault.java:231/263, default 100), keys createallkeys (keys.java:226, Main.java LOAD_ALL_KEYS)
//   ADD to every key's uses from the backup (wallet.updateIncrementAllKeyUses): restoresync (restoresync.java:214/224/364, default 256)
//   SINGLE signature at that leaf (TreeKey.createDefault, setUses): txnsign publickey:custom (txnsign.java:153), and sendfrom, signfrom,
//     consolidatefrom, createtokenfrom, which run that txnsign
// Every key here is a 64 x 64 x 64 tree (this desktop never runs the node with -blockaskeyuses): leaves 0 to 262143; at 262144 or more the
// node signs at leaf 0 again (getAsInt keeps only the low 32 bits, so 4294967296 is 0). A single signature may name the last leaf, 262143.
// A figure that SETS or ADDS the wallet's uses must leave room for the signatures that follow it: the shipped node's Wallet.signData
// checks no capacity, so after a restore at 262143 every key signs once and then starts again at leaf 0. So 250000 for SET (12,144 more
// signatures per key before the node's limit) and 10000 for restoresync's ADD; neither is presented as a target.
const KEYUSES_MAX = 262143, KEYUSES_SET_MAX = 250000, KEYUSES_ADD_MAX = 10000;
// the five single-signature verbs by name (0.18.278); restoresync adds; EVERY other verb that names keyuses gets the setting bound, the lower
// one (an unknown verb defaulted to 262143); the higher bound only when EVERY reading of the verb is a single-signature one (0.18.284: one
// loose reading was enough), so a loose reading can only lower the bound
const SINGLE_VERBS = ["txnsign", "sendfrom", "signfrom", "consolidatefrom", "createtokenfrom"];
const KEYUSES_WHY = "keyuses: must be a whole number from 0 to " + KEYUSES_MAX + ": a key of this wallet has 262144 one-time uses, numbered 0 to " + KEYUSES_MAX + ", and a higher figure would make the wallet sign with one-time keys it has already used, which can lose funds. Nothing was run.";
// uses is the NEXT leaf to sign at, so the number of times a key has already signed is itself a safe figure: "at least", not "above" (0.18.278);
// the node's defaults are 100 (vault resetkeys) to 1000 (the resyncs), and keys createallkeys has none
const KEYUSES_SET_WHY = "keyuses: sets how many times every key of this wallet has already signed, so it must be at least that number; a small figure is usual (the node's defaults are 100 to 1000). It can be at most " + KEYUSES_SET_MAX + ": a figure near a key's limit of 262144 one-time uses would leave the wallet with keys that run out and then sign with one-time keys they have already used, which can lose funds. Nothing was run.";
const KEYUSES_ADD_WHY = "keyuses: on restoresync is added to how many times every key in the backup has signed; the usual figure is small (the node's own default is 256). It can be at most " + KEYUSES_ADD_MAX + ": a large figure would bring the wallet's keys near their limit of 262144 one-time uses, after which they sign with one-time keys they have already used, which can lose funds. Nothing was run.";
/** Why a keyuses: value is refused ("" = it is not, or there is none): plain digits, at most the bound of what the command does with it. */
function keyusesProblem(command) {
  for (const part of V.parts(command)) {
    const [max, why] = V.is(part, "restoresync") ? [KEYUSES_ADD_MAX, KEYUSES_ADD_WHY] : V.verbs(part).every(v => SINGLE_VERBS.includes(v)) ? [KEYUSES_MAX, KEYUSES_WHY] : [KEYUSES_SET_MAX, KEYUSES_SET_WHY];
    if (V.read(part).params.some(([n, v]) => V.fold(n) === "keyuses" && !(/^\d{1,15}$/.test(v) && Number(v) <= max))) return why;
  }
  return "";
}
const FROM_KEY = ["sendpoll", "sendfrom", "signfrom", "consolidatefrom", "createtokenfrom", "multisig", "multisigread", "sphincs"];
/** Why mcd:cmd refuses a command whose pasted values would become parameters of the node's own second command ("" = it does not). */
function repasted(command) {
  return V.parts(command).some(part => {
    const action = V.fold(V.paramValue(part, "action") || "");
    return Object.keys(REPASTED).some(v => {
      const bad = V.is(part, v) && REPASTED[v](action);
      return !!bad && V.read(part).params.some(([name, val]) => bad.test(val) && !(/^(file|archivefile)$/i.test(name) && WIN_PATH.test(val)));
    });
  }) ? REPASTED_WHY : "";
}

/**
 * checkCommand(command, io) (0.18.201): everything mcd:cmd decides before a text reaches the node, in order:
 *   1. a non-empty string;  2. no control character (tab and line end allowed; the node trims and reads the others in
 *   ways no check here can follow);  2b. a command that moves funds or keys whose text the node reads otherwise than it looks
 *   (main/cmdverb.js unclear, 0.18.219);  2c. a value the node would paste into a second command of its own as more parameters
 *   (repasted, 0.18.220);  2d. an escaped ";" or control character (cmdverb.smuggled), mds action:accept, a multisig spend, and a
 *   repeated parameter of a command that moves funds from a key or builds commands of its own (0.18.221); rpc (but its status and the
 *   gated listusers), slavenode enable:, webhooks action:add and mds actions (0.18.228); a value that would rewrite the commands a
 *   builder (sendfrom, rawfrom, multisig …) makes from it (cmdverb.builtProblem, 0.18.230); a file parameter on another computer (0.18.237);  3. a send that names amount, tokenid, address or fromaddress twice is refused (the
 *   node keeps the last; the pin and every review read one);  4. the secret-command gate (refusal);  5. the node running
 *   (io.running() throws if not);  6. the beacon-dust pin of a MINIMA send (io.pin). → the text to run; throws the reason.
 */
async function checkCommand(command, io) {
  if (typeof command !== "string" || !command.trim()) throw new Error("empty command");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error("This command holds a control character. Type it again without one.");
  const unclear = V.unclear(command); if (unclear) throw new Error(unclear);   // refused, not guessed (0.18.219, main/cmdverb.js read)
  const pasted = repasted(command); if (pasted) throw new Error(pasted);
  const esc = V.smuggled(command); if (esc) throw new Error(esc);
  const ku = keyusesProblem(command); if (ku) throw new Error(ku);   // the restore screens send their megammrsync through here too (0.18.269)
  // a value that would rewrite the commands a sendfrom, rawfrom, multisig … builds from it (0.18.230)
  for (const part of V.parts(command)) { const built = V.builtProblem(part); if (built) throw new Error(built); }
  for (const part of V.parts(command)) {
    const twice = V.is(part, "send") ? V.repeated(part, ["amount", "tokenid", "address", "fromaddress"]) : [];
    if (twice.length) throw new Error("This send names " + twice.join(", ") + " more than once (the node would use only the last). Write each once.");
    // the commands that move funds from a key or build commands of their own: any parameter named twice (0.18.221)
    if (FROM_KEY.some(v => V.is(part, v))) { const again = V.repeated(part); if (again.length) throw new Error("This command names " + again.join(", ") + " more than once (the node would use only the last). Write each once. Nothing was run."); }
    // a MiniDapp's waiting command runs with full rights past every check here; a multisig spend copies a coin's state from the chain
    // into commands the node runs itself, where a ";" starts a second command, and this app cannot read that state first (0.18.221)
    const action = V.fold(V.paramValue(part, "action") || "");
    // what hands the node to someone else or sends its events out (0.18.228, as Pandamonium Desktop 0.19.298, read from core/minima-core:
    // network/rpc.java enable: (no password turns RPC authentication off on every interface), password: (replaces the app's own),
    // action:adduser / removeuser, ssl; base/slavenode.java enable: (a master node); network/webhooks.java action:add (node events to
    // any URL); mds/mds.java every action but list): refused; rpc with no parameter (its status) and the gated rpc action:listusers /
    // mds list are not
    const names = V.paramNames(part);
    if ((V.is(part, "rpc") && !(names.length === 0 || (names.length === 1 && names[0] === "action" && action === "listusers")))
      || (V.is(part, "slavenode") && names.includes("enable")) || (V.is(part, "webhooks") && action === "add")
      || (V.is(part, "mds") && action !== "" && action !== "list" && action !== "accept"))
      throw new Error("This command would open this node to someone else or send its events out (the RPC login or password, a master node, a web hook, MiniDapps). This app never needs that, so it is not run from the Terminal. Nothing was run.");
    // a file on another computer (a UNC path, \\host\share, //host/share or a mix of the two slashes): a Windows node would connect to
    // that share (0.18.237); for EVERY command since 0.18.244, as Pandamonium Desktop 0.19.309 (txnimport, txnexport, txnview, hash,
    // sphincs, multisig, the send…view family and peers action:publish read files too: every MiniFile.createBaseFile / new File of a
    // parameter is file, folder or archivefile, and any …file name is taken with them; 0.18.255: and output, where decryptbackup writes
    // the DECRYPTED backup, the wallet in plain text, decryptbackup.java getParam("output"))
    // ... and a Windows NT path to a share (0.18.256): \??\UNC\host\share or /??/UNC/host/share, which Windows treats as UNC
    if (V.read(part).params.some(([n, v]) => /^(?:folder|output|\w*file)$/i.test(n) && /^[\\/](?:[\\/]|\?\?[\\/])/.test(v)))
      throw new Error("A file on another computer (a path that starts with \\\\ or //) is not used: the node would connect to it. Copy the file to this computer first. Nothing was run.");
    if (V.is(part, "mds") && action === "accept") throw new Error("mds action:accept runs a MiniDapp's waiting command with full rights, past every check of this app. It is not run from the Terminal. Nothing was run.");
    if ((V.is(part, "multisig") || V.is(part, "multisigread")) && action === "spend") throw new Error("A multisig spend copies the coin's state from the chain into commands the node runs itself, where it could start a second command, and this app cannot read that state first. It is not run from the Terminal. Nothing was run.");
  }
  const gated = refusal(command, io.take); if (gated) throw new Error(gated);
  io.running();
  return io.pin ? await io.pin(command) : command;
}

module.exports = { classify, create, refusal, masked, scrubReply, SECRET_NAMES, repasted, keyusesProblem, KEYUSES_MAX, KEYUSES_SET_MAX, KEYUSES_ADD_MAX, checkCommand, PHRASE, PASS_MS };
