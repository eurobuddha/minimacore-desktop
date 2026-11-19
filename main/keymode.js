/*
 * keymode.js — the wallet's key mode: "classic" (Winternitz keys counted by use) or "block" (block-as-key-uses,
 * minima-core 1.1.2.31+, started with -blockaskeyuses -lowram).
 *
 * The same seed gives DIFFERENT keys in the two modes, and a node started in the other mode adds keys of the
 * other kind to the wallet for good (docs/JAR_PROOF.md). So the mode is recorded once, when the wallet is
 * created or restored (main/config.js recordKeyMode), nothing may change it, and the node is refused a start
 * whenever the recorded mode cannot be honoured exactly. No electron here: scripts/keymode-test.cjs runs it.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const PARAMS = require("../renderer/params.js");

const MARKER = "minimacore-keymode.txt";   // in the node's data folder, written for a block wallet only
const PARAM_KEYS = "org/minima/system/params/ParamConfigurer$ParamKeys.class";

/** One entry of a zip/jar, inflated, or null. Reads the central directory and that entry only. */
function readZipEntry(file, name) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(Math.min(size, 65557));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return null;
    const cd = Buffer.alloc(tail.readUInt32LE(eocd + 12));
    fs.readSync(fd, cd, 0, cd.length, tail.readUInt32LE(eocd + 16));
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const n = cd.readUInt16LE(p + 28);
      if (cd.toString("utf8", p + 46, p + 46 + n) === name) {
        const off = cd.readUInt32LE(p + 42), local = Buffer.alloc(30), data = Buffer.alloc(cd.readUInt32LE(p + 20));
        fs.readSync(fd, local, 0, 30, off);
        fs.readSync(fd, data, 0, data.length, off + 30 + local.readUInt16LE(26) + local.readUInt16LE(28));
        return cd.readUInt16LE(p + 10) === 0 ? data : zlib.inflateRawSync(data);
      }
      p += 46 + n + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return null;
  } finally { fs.closeSync(fd); }
}

const seen = new Map();   // jar path → boolean, read once per run
/**
 * Does this node jar know -blockaskeyuses? Read from the jar itself: the flag's name is a constant of the
 * node's own parameter list (ParamConfigurer.ParamKeys). A jar that is missing, unreadable or of another
 * shape does not support it. Both node jars keep that class at the same path.
 */
function jarSupportsBlock(jarPath) {
  if (seen.has(jarPath)) return seen.get(jarPath);
  let ok = false;
  try { const c = readZipEntry(jarPath, PARAM_KEYS); ok = !!c && c.includes("blockaskeyuses"); } catch (e) { ok = false; }
  seen.set(jarPath, ok);
  return ok;
}

/** What a data folder already holds: "block" (its marker says so), "classic" (node data, no marker) or "" (nothing yet). */
function folderKeyMode(dir) {
  try { if (fs.readFileSync(path.join(dir, MARKER), "utf8").trim() === "block") return "block"; } catch (e) { /* no marker */ }
  try { return fs.readdirSync(dir).some(n => !n.startsWith(".") && n !== MARKER) ? "classic" : ""; } catch (e) { return ""; }
}
function markBlockFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MARKER), "block\n");
}

/**
 * The flags of block mode, each with its value spelled out. Classic passes neither. A bare -lowram took the
 * next free-text token as its value ("false" switched it off); "-lowram true" cannot be captured that way.
 * The node reads a boolean parameter as on only when its value is exactly "true" (ParamConfigurer).
 */
function startFlags(mode) { return mode === "block" ? ["-blockaskeyuses", "true", "-lowram", "true"] : []; }

const KEY_FLAGS = PARAMS.KEY_MODE_FLAGS;
const APP_OWNED = PARAMS.MANAGED.concat(["conf"]);   // set by the app (conf: by its own parameter only), never by hand
/** "-Name", "--name", "-name=x" → "name"; anything that does not start with a dash → "". */
const flagName = (tok) => (String(tok).charAt(0) === "-" ? String(tok).replace(/^-+/, "").split("=")[0].toLowerCase() : "");

/** MinimaFlags.tokenise of the Parlons Node, ported: what the jar makes of its one -Dparlons.node.args string. */
function tokeniseParlons(raw) {
  const out = []; let cur = "", quote = "", have = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && i + 1 < raw.length && quote === '"') cur += raw[++i];
      else cur += c;
      have = true;
    } else if (c === "'" || c === '"') { quote = c; have = true; }
    else if (c === "\\" && i + 1 < raw.length) { cur += raw[++i]; have = true; }
    else if (/\s/.test(c)) { if (have) { out.push(cur); cur = ""; have = false; } }
    else { cur += c; have = true; }
  }
  if (have) out.push(cur);
  return out;
}
/** Every token the node's own parser is handed by a finished java argv, for either node kind. */
function nodeTokens(argv) {
  const out = [];
  for (const a of argv.map(String)) {
    if (a.startsWith("-Dparlons.node.args=")) out.push(...tokeniseParlons(a.slice("-Dparlons.node.args=".length)));
    else out.push(a);
  }
  return out;
}

/** Why a -conf file may not be used ("" = it may). It is read here because the node applies every line of it. */
function confProblem(file) {
  let text;
  try { text = fs.readFileSync(String(file), "utf8"); }
  catch (e) { return "The config file given with -conf could not be read, so it could not be checked: " + file + ". The node was not started."; }
  if (/blockaskeyuses|lowram/i.test(text))
    return "The config file given with -conf sets -blockaskeyuses or -lowram. The wallet's key mode sets them, so they cannot be passed by hand. Remove them from that file.";
  for (const line of text.split(/\r?\n/)) {
    const key = line.split("=")[0].trim().replace(/^-+/, "").toLowerCase();
    if (APP_OWNED.includes(key)) return "The config file given with -conf sets " + key + ", which the app sets itself. Remove that line from the file.";
  }
  return "";
}

/**
 * THE gate: why this finished java argv must not be run ("" = it may). It looks at what the node will really
 * be handed, for either kind (the Parlons Node's flags are inside one -D string), so it does not matter which
 * field a token came from: a parameter value, the extra arguments, a quoted string. The key-mode tokens present
 * must be exactly the ones the recorded mode needs, every -data / -basefolder must be this install's own
 * folder, and every -conf file is read and checked.
 */
function argvProblem(argv, mode, dataDir) {
  const toks = nodeTokens(argv), found = [];
  for (let i = 0; i < toks.length; i++) {
    const name = flagName(toks[i]);
    if (KEY_FLAGS.includes(name)) found.push(toks[i] + " " + (i + 1 < toks.length ? toks[i + 1] : ""));
    else if (name === "data" || name === "basefolder") {
      if (toks[i].replace(/^-+/, "") !== name || toks[i + 1] !== dataDir) return "The node was not started: -" + name + " would point it at a folder other than this install's data folder. Remove it from the extra arguments in Startup Params.";
    } else if (name === "dparlons.node.data") {
      if (toks[i] !== "-Dparlons.node.data=" + dataDir) return "The node was not started: it would be pointed at a folder other than this install's data folder.";
    } else if (name === "dparlons.node.conf") return "The node was not started: a config file was given outside the app's own -conf parameter.";
    else if (name === "conf") { const why = confProblem(toks[i + 1] == null ? "" : toks[i + 1]); if (why) return why; }
  }
  const want = mode === "block" ? ["-blockaskeyuses true", "-lowram true"] : [];
  if (found.join("\n") !== want.join("\n"))
    return "The node was not started: its start command " + (found.length ? "holds " + found.map(f => f.trim()).join(", ") : "does not hold the block key flags") + ", and this wallet uses " + mode + " keys, which needs " + (want.length ? "exactly " + want.join(" ") : "neither -blockaskeyuses nor -lowram") + ". Check the parameter values and extra arguments in Startup Params.";
  return "";
}

/**
 * The environment the node is started with. The node reads any MINIMA_<parameter> variable as that parameter
 * (MINIMA_BLOCKASKEYUSES=true), the Parlons Node reads PARLONS_NODE_ARGS when it is given no argument string,
 * and the JVM reads its own option variables (which could carry -Dparlons.node.conf=). None of them reaches it.
 */
function childEnv(env) {
  const out = {};
  for (const k of Object.keys(env || {})) if (!/^(minima_|parlons_)/i.test(k) && !/^(java_tool_options|_java_options|jdk_java_options)$/i.test(k)) out[k] = env[k];
  return out;
}

/**
 * Why the node must NOT be started ("" = it may). o = { mode, supported, folderMode, extraArgs, params, confFile }.
 * Every refusal is the same rule: never start a wallet in a mode other than the one it was made in.
 */
function startProblem(o) {
  if (o.mode !== "classic" && o.mode !== "block")
    return "No wallet has been set up yet. Choose New Wallet or Restore Wallet first.";
  if (o.folderMode && o.folderMode !== o.mode)
    return "The data folder holds a " + o.folderMode + " key wallet, but this install is set up for " + o.mode + " keys. The node was not started, because that would add keys of the other kind to the wallet for good. Set the data folder back in Startup Params.";
  if (o.mode === "block" && !o.supported)
    return "This wallet uses block key uses, and the node in this version of the app cannot run it. The node was not started, because starting it here would add classic keys to the wallet for good. Install the newer version of the app this wallet was made with.";
  const arg = PARAMS.keyModeArg(o.extraArgs);
  if (arg) return arg + " is in the extra arguments. The wallet's key mode sets it, so it cannot be passed by hand. Remove it in Startup Params.";
  const owned = PARAMS.reservedArg(o.extraArgs);
  if (owned) return owned + " is in the extra arguments. The app sets it itself, and a second one would override the app's. Remove it in Startup Params.";
  // The node reads any token that starts with a dash as a parameter NAME, wherever it stands.
  for (const [k, v] of Object.entries(o.params || {}))
    if (typeof v === "string" && /^\s*["']?-/.test(v)) return "The value of -" + k + " starts with a dash. The node would read it as another parameter, so it was not started. Correct it in Startup Params.";
  if (o.confFile) return confProblem(o.confFile);
  return "";
}

module.exports = { jarSupportsBlock, folderKeyMode, markBlockFolder, startFlags, startProblem, argvProblem, nodeTokens, childEnv, readZipEntry, MARKER };
