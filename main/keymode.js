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

/** The two flags of block mode. Classic passes neither. Only ever called after startProblem() returned "". */
function startFlags(mode) { return mode === "block" ? ["-blockaskeyuses", "-lowram"] : []; }

/**
 * Why the node must NOT be started ("" = it may). o = { mode, supported, folderMode, extraArgs, confText }.
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
  if (/blockaskeyuses|lowram/i.test(String(o.confText || "")))
    return "The config file given with -conf sets -blockaskeyuses or -lowram. The wallet's key mode sets them, so they cannot be passed by hand. Remove them from that file.";
  return "";
}

module.exports = { jarSupportsBlock, folderKeyMode, markBlockFolder, startFlags, startProblem, readZipEntry, MARKER };
