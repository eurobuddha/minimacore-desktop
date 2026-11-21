/*
 * cmdverb.js: which command the node runs for a piece of command text. Ported unchanged (below this header) from the
 * released desktop's main/cmdverb.js (0.18.174 and 0.18.184, security/backport-2026-11-20 d0260c91ea325f6c442ef77646372a066993af24)
 * in 0.19.187. Every verb check in the main process goes through here: the secret-command gate (main/seedgate.js), and
 * the readers of command text after it (the signing queue, the send pin, the coin guard, the RPC timeout, the restore
 * checks, the Dexicon bridge).
 *
 * The node does not read a command the way a /^send\s/ test does. CMDHandler trims the text the Java way (every char
 * U+0000 to U+0020 at both ends), runMultiCommand splits on every ";", and getCommand reads the first token two ways:
 * a fast path where ":" is a token of its own and a "quoted" first word is the command, and a slow path that drops
 * quotes. So `"vault"`, U+0001 + `vault`, `va"ul"t`, `"send" amount:1 …` and `keys action :genkey` are all run as written
 * by the node, and slipped past the old checks. verbs() OVER-approximates both readings (lower-cased the way Java's
 * equalsIgnoreCase folds, JS whitespace wider than Java's); a gate built on it may block a text the node would refuse
 * anyway, never the reverse.
 */
const jtrim = (s) => String(s).replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");   // Java String.trim()
const fold = (s) => String(s).replace(/\u0130/g, "i").toUpperCase().toLowerCase();   // Kelvin sign → k, long s → s; İ → i (0.19.223: a Turkish JVM folds it so)

/** The commands of a text, as the node splits them (every ";", empty pieces dropped). */
function parts(command) { return String(command == null ? "" : command).split(";").map(jtrim).filter(Boolean); }

/*
 * read(part): ONE command as the node reads it (0.19.266), ported from CommandRunner.getCommand and its two splitters
 * (core/minima-core src/org/minima/system/commands/CommandRunner.java): with no "{", "[" or ":\" in the text, the FAST
 * splitter (every ":" made " : ", tokens by "([^"]*)"|\S+ (Java's \s), then name : value glued back; a ":" where a name
 * should be falls back to the slow one); else the SLOW splitter (only " " splits; a quote outside {…}/[…] toggles and is
 * dropped; "{" and "[" count even inside quotes; a quote inside them is kept). Each token after the verb is name:value at
 * its first ":" (no ":" is an error: nothing runs), both Java-trimmed, a value not {…}/[…] loses one leading and one
 * trailing quote. The node keeps the LAST value of a repeated name.
 * odd: the text is read in a way it does not look (a quote inside a word or glued to the next one, a ":" inside quotes,
 * a "{" or "[" inside quotes or outside a value that is JSON, unbalanced quotes or brackets). unclear() refuses those for
 * the commands that move funds or keys, rather than trust that this reading is the node's.
 */
const JWS = /[ \t\n\x0B\f\r]/;   // Java's \s
function fastSplit(text) {
  const s = text.replace(/:/g, " : "), re = /"([^"]*)"|([^ \t\n\x0B\f\r]+)/g, toks = []; let m, odd = false;
  while ((m = re.exec(s))) {
    if (m[1] != null) {
      const b = s[m.index - 1], a = s[m.index + m[0].length];
      if ((b !== undefined && !JWS.test(b)) || (a !== undefined && !JWS.test(a)) || m[1].includes(":")) odd = true;
      toks.push(m[1]);
    } else { if (m[2].includes('"')) odd = true; toks.push(m[2]); }
  }
  const out = []; let named = false, nv = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (i === 0) { out.push(t); continue; }
    if (!named) { if (jtrim(t) === ":") return null; named = true; nv = t; }
    else if (jtrim(t) === ":") nv += ":";
    else { named = false; nv += t; out.push(nv); }
  }
  return { toks: out, odd };
}
function slowSplit(text) {
  const s = jtrim(text), toks = []; let cur = "", js = 0, q = false, odd = false, qbr = false;   // qbr: a { or [ inside quotes
  for (let i = 0; i < s.length; i++) {
    const cc = s[i];
    if (cc === " ") { if (!q && js === 0) { if (cur !== "") toks.push(jtrim(cur)); cur = ""; } else cur += cc; }
    else if (cc === "{" || cc === "[") { if (q) qbr = true; js++; cur += cc; }
    else if (cc === "}" || cc === "]") { if (q) qbr = true; js--; if (js < 0) odd = true; cur += cc; }
    else if (cc === '"') {
      if (js > 0) cur += cc;
      else { if (!q ? cur !== "" && !cur.endsWith(":") : s[i + 1] !== undefined && s[i + 1] !== " ") odd = true; q = !q; }
    } else cur += cc;
  }
  if (cur !== "") toks.push(jtrim(cur));
  if (q || js !== 0) odd = true;
  toks.forEach((t, i) => {
    if (!/[{}[\]]/.test(t)) return;
    const ix = t.indexOf(":"), v = jtrim(t.slice(ix + 1));
    if (i === 0 || ix < 1 || /[{}[\]]/.test(t.slice(0, ix)) || !((v[0] === "{" && v.endsWith("}")) || (v[0] === "[" && v.endsWith("]")))) odd = true;
  });
  return { toks, odd, qbr };
}
let readOf = null, readIs = null;   // the last command read: every look at one command reads the same parse
/** → { verb (folded), params: [[name, value], …] in order, repeats kept, error ("" = the node runs it), odd }. */
function read(part) {
  const s = jtrim(String(part == null ? "" : part));
  if (s === readOf) return readIs;
  let sp = null;
  if (!s.includes(":\\") && !s.includes("{") && !s.includes("[")) sp = fastSplit(s);
  if (!sp) sp = slowSplit(s);
  const verb = fold(sp.toks[0] || ""), params = []; let error = "";
  for (let i = 1; i < sp.toks.length; i++) {
    const t = sp.toks[i], ix = t.indexOf(":");
    if (ix === -1) { error = "Invalid parameters for " + verb + " @ " + t; break; }
    const name = jtrim(t.slice(0, ix)); let v = jtrim(t.slice(ix + 1));
    if (!((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]")))) { if (v.startsWith('"')) v = v.slice(1); if (v.endsWith('"')) v = v.slice(0, -1); }
    params.push([name, v]);
  }
  // a [..] value in quotes is plain text to txnstate (getCommand keeps it a string there, 0.19.290); elsewhere a bracket in quotes is odd
  readOf = s; readIs = { verb, params, error, odd: sp.odd || (!!sp.qbr && verb !== "txnstate") };
  return readIs;
}
/** Every verb the node may read for ONE command (no ";"): the node's own reading, plus the two looser readings this file
 *  used before 0.19.266 (a gate built on it may block a text the node would refuse anyway, never the reverse). */
function verbs(part) {
  const p = jtrim(part), out = new Set([read(p).verb]);
  const f = /"([^"]*)"|([^\s"]+)/.exec(p.replace(/:/g, " : "));            // a quoted first word
  if (f) out.add(fold(jtrim(f[1] != null ? f[1] : f[2])));
  const slow = jtrim(p.replace(/"/g, ""));                                   // quotes dropped
  out.add(fold(slow.split(/[\u0000- \s:]/)[0] || ""));
  out.delete("");
  return [...out];
}
/** Is this ONE command run as `verb`? */
function is(part, verb) { return verbs(part).includes(verb); }
/** Does this ONE command begin with `prefix`, however it is quoted or trimmed (for gates: over-blocks on purpose)? */
function beginsAs(part, prefix) { return verbs(part).some(v => v.startsWith(prefix)) || fold(jtrim(String(part).replace(/"/g, ""))).startsWith(prefix); }
/** The parameter names of ONE command as the node reads them, in order, repeats kept, lower-cased (the node's names are). */
function paramNames(part) { return read(part).params.map(([n]) => fold(n)); }
/** The LAST value of `name` in ONE command (as the node keeps it), or null. */
function paramValue(part, name) {
  const want = fold(name), ps = read(part).params;
  for (let i = ps.length - 1; i >= 0; i--) if (fold(ps[i][0]) === want) return ps[i][1];
  return null;
}
/** The names that appear more than once in ONE command (lower-cased). */
function repeated(part, only) {
  const seen = new Set(), twice = new Set();
  for (const n of paramNames(part)) { if (only && !only.includes(n)) continue; if (seen.has(n)) twice.add(n); seen.add(n); }
  return [...twice];
}
const SENSITIVE = /^(?:vault|seedrandom|keys|megammrsync|archive|mysql|reset|backup|restore\w*|send\w*|txn\w*|consolidate\w*|tokencreate|createtokenfrom|multisig\w*|sign\w*|sphincs)$/;   // 0.19.291: sendpoll, sendfrom, signfrom, consolidatefrom, createtokenfrom, multisig, multisigread, sphincs
const UNCLEAR = "The node would read this command differently from how it is written (a quote inside a word or glued to the next one, a colon inside quotes, or a { or [ outside a JSON value). Write it without them. Nothing was run.";
/** Why a text whose reading is odd (read().odd) is refused for a command that moves funds or keys ("" = it is not). */
function unclear(command) { return parts(command).some(p => read(p).odd && verbs(p).some(v => SENSITIVE.test(v) || BUILDERS.test(v))) ? UNCLEAR : ""; }   // every builder too (0.19.308: rawfrom, rawtxnfrom …)

// A \u escape in a JSON value is decoded by the node's own parser (utils/json/parser/Yylex.java: \uXXXX besides \" \\ \/ \b \f
// \n \r \t), and some commands paste the decoded text into a command they run themselves, which splits on every ";" and runs each
// piece with full rights (0.19.291, read from core/minima-core: sendfrom, rawfrom, rawtxnfrom "txnstate … value:" + state; multisig
// create publickeys; createtokenfrom; sendpoll's stored commands; mysql setlogin's stored login, pasted by Main's autobackup). A raw
// ";" can never be a value (both sides split on it first), so "\u003b" is the only way to carry one: refused for every verb, and so
// is an escape that decodes to a control character.
const SMUGGLED = "This command holds a character written as an escape code (a semicolon or a control character), which the node would decode and could run as a second command. Nothing was run.";
/** Why this text is refused for a \u escape that decodes to ";" or a control character ("" = it is not). Only a real escape counts
 *  (0.19.300): a "\" before it that is itself escaped ("\\u003b", an even run of backslashes) leaves plain text to the node. */
function smuggled(command) {
  for (const m of String(command).matchAll(/(?<!\\)(?:\\\\)*\\u([0-9a-fA-F]{4})/g)) { const c = parseInt(m[1], 16); if (c === 0x3b || c < 0x20) return SMUGGLED; }
  return "";
}

// The commands that build further commands from their values and run them (0.19.299, read from core/minima-core: send/wallet
// sendfrom, rawfrom, rawtxnfrom, createtokenfrom, consolidatefrom, constructfrom, createfrom, signfrom, postfrom; send/multisig,
// multisigread; txn/txnauto; base/sphincs). Their values are pasted, unquoted or inside "…", into those commands, so a value with
// white space, ":" or a quote, or a JSON value with a backslash escape or a decoded quote, rewrites them (a multisig public key
// carrying '","2":"0' made the multisig's state "0 of n": anyone could spend it; password:"pw burn:500" became burn:500).
const BUILDERS = /^(?:sendfrom|rawfrom|rawtxnfrom|createtokenfrom|consolidatefrom|constructfrom|createfrom|signfrom|postfrom|multisig|multisigread|txnauto|sphincs)$/;
// Read, hashed or parsed by the command itself, never pasted (0.19.310): action, seed (sphincs hashes it), data (signfrom / postfrom:
// checked by txnBlobId), name (createtokenfrom builds its JSON), and for multisig / multisigread id (hashed). file is pasted by
// multisig / multisigread sign, post and view ("txnimport id:… file:" + file) and is checked there; no other builder pastes it.
const NOT_PASTED = new Set(["action", "seed", "data", "name"]);
const fileBad = (v) => /[\s"]/.test(v) || (v.includes(":") && !/^[A-Za-z]:[\\/][^:]*$/.test(v));   // a drive letter's ":" is fine, with either slash (0.19.320: C:/dir/x.txn)
const BUILT = "This command builds further commands from its values, and one of them holds white space, a colon, a quote or a backslash escape that would change those commands. Nothing was run.";
const MSKEY = "Each multisig public key, and the root key, must be 0x followed by 64 hexadecimal digits. Nothing was run.";
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
// signfrom / postfrom read a whole transaction from data: (TxnRow.convertMiniDataVersion: its first field is the id, a 4-byte length
// then UTF-8) and paste that id, unquoted, into "txnsign id:" / "txnpost id:" / "txnexport id:" / "txndelete id:" + id, run through
// runMultiCommand: an id holding ";" was a second command with full rights (0.19.307). The id must be plain; data must be 0x hex the
// app can read (the Mx form is refused: the app does not decode it), with a length that stays inside the blob.
const TXNDATA = "The data: of this command must be 0x hex holding a transaction whose id is plain letters, digits, \".\", \"-\" or \"_\": the node pastes that id into the commands it runs itself. Nothing was run.";
const TXID = /^[0-9A-Za-z_.\-]{1,256}$/;
/** The id a TxnRow blob carries, or null when it is not 0x hex or its length runs past the blob. */
function txnBlobId(hex) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(String(hex))) return null;
  const b = Buffer.from(String(hex).slice(2), "hex"); if (b.length < 4) return null;
  const len = b.readInt32BE(0); if (len < 0 || 4 + len > b.length) return null;
  return b.subarray(4, 4 + len).toString("utf8");
}
function strings(x, out = []) { if (typeof x === "string") out.push(x); else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { out.push(k); strings(v, out); } return out; }
/** Why this ONE command, one that builds further commands, is refused ("" = it is not). */
function builtProblem(part) {
  const r = read(part); if (!verbs(part).some(v => BUILDERS.test(v))) return "";
  const action = fold(paramValue(part, "action") || ""), ms = verbs(part).some(v => v === "multisig" || v === "multisigread");
  if (verbs(part).some(v => v === "signfrom" || v === "postfrom")) {
    const data = paramValue(part, "data"), id = data == null ? null : txnBlobId(data), own = paramValue(part, "id");
    if ((data != null && (id === null || !TXID.test(id))) || (own != null && !TXID.test(own))) return TXNDATA;
  }
  for (const [n0, v] of r.params) {
    const n = fold(n0);
    if (/^[{[]/.test(v)) {
      if (v.includes("\\")) return BUILT;
      let j; try { j = JSON.parse(v); } catch (e) { return BUILT; }
      const ss = strings(j);
      if (ss.some(s => s.includes('"'))) return BUILT;
      // a state value is pasted inside value:"…" as its own text (state.get(key)+""): an array or object there serialises with quotes
      // of its own and rewrites the txnstate it goes into (0.19.308): strings, numbers and true / false only
      if (n === "state" && j && typeof j === "object" && Object.values(j).some(x => x !== null && typeof x === "object")) return BUILT;
      // rawfrom / rawtxnfrom paste coinid, address, amount, tokenid raw: no white space or ":"; a script goes inside {"…":""} like script:
      if (/^(inputs|outputs)$/.test(n) && (Array.isArray(j) ? j : [j]).some(e => (e && typeof e === "object" ? Object.entries(e) : [["", e]]).some(([k, x]) => typeof x === "string" && fold(k) !== "script" && /[\s:]/.test(x)))) return BUILT;
      if (n === "publickeys" && verbs(part).includes("multisig") && action === "create" && !(Array.isArray(j) && j.every(k => typeof k === "string" && HEX64.test(k)))) return MSKEY;
    } else if (n === "script") { if (v.includes('"')) return BUILT; }   // pasted inside scripts:{"…":""}: a space is fine there
    else if (n === "file") { if (ms && fileBad(v)) return BUILT; }
    else if (n === "id" && ms) { /* hashed */ }
    else if (!NOT_PASTED.has(n) && /[\s:"]/.test(v)) return BUILT;
    if (n === "root" && v !== "0x21" && !HEX64.test(v)) return MSKEY;
  }
  return "";
}

/**
 * oneCommand(text) (0.19.194, released 0.18.177): a command the APP builds is one command. The node splits a text on EVERY
 * ";", even inside quotes and JSON, so a ";" carried in by a pasted seed, a peer's media ref, a password or a coin's state on
 * the chain started a second command of the sender's choosing. Every builder outside the Terminal and the vendored engines
 * (Mail, miniMall, Chat, Vestr, the Web Wallet, Future Cash Next) sends through this; it throws, and nothing is sent.
 * It lives here, not in main/rpc.js as in the released desktop, so that a module whose tests stand in for rpc.js keeps it. The
 * Terminal's own chains go through mcd:cmd; the AtomiX, PandaPools, Dexicon and casino engines chain txnbasics;txnpost
 * of their own making.
 */
function oneCommand(command) {
  if (String(command).includes(";")) throw new Error("This command holds \";\", which would start a second command. Nothing was sent.");
  if (smuggled(command)) throw new Error(SMUGGLED);   // an escaped one too (0.19.291)
  for (const p of parts(command)) { const built = builtProblem(p); if (built) throw new Error(built); }   // and what a builder would paste (0.19.307: the Web Wallet's sendfrom)
  return command;
}
module.exports = { jtrim, fold, parts, read, verbs, is, beginsAs, paramNames, repeated, paramValue, unclear, smuggled, builtProblem, oneCommand };
