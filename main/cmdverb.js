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
const SENSITIVE = /^(?:vault|seedrandom|keys|megammrsync|archive|mysql|reset|backup|restore\w*|send\w*|txn\w*|consolidate|tokencreate|multisig|sign\w*)$/;
const UNCLEAR = "The node would read this command differently from how it is written (a quote inside a word or glued to the next one, a colon inside quotes, or a { or [ outside a JSON value). Write it without them. Nothing was run.";
/** Why a text whose reading is odd (read().odd) is refused for a command that moves funds or keys ("" = it is not). */
function unclear(command) { return parts(command).some(p => read(p).odd && verbs(p).some(v => SENSITIVE.test(v))) ? UNCLEAR : ""; }

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
  return command;
}
module.exports = { jtrim, fold, parts, read, verbs, is, beginsAs, paramNames, repeated, paramValue, unclear, oneCommand };
