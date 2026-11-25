/*
 * importfile.js — a file on this computer that the NODE is told to read: a backup (.bak, Backup & Recovery › Restore from file)
 * or a MegaMMR file (.mmr / .megammr, Backup & Recovery › Resync from a MegaMMR file). No electron: scripts/importfile-test.cjs runs it.
 *
 * The path is only ever one the user chose in the system's own open dialog (pick), checked here, and kept here: the window gets it to
 * show, and a restore or an import runs only on that same path (confirm), checked again. The file is never copied: the node reads it
 * where it is (MiniFile.createBaseFile takes an absolute path as it is, core/minima-core src/org/minima/utils/MiniFile.java:28-36).
 *
 * How the node reads the path (core/minima-core, block line 1.1.2.31-euro14, src/org/minima/system/commands/CommandRunner.java):
 *  - the whole text is cut at every ";" (StringTokenizer, :314), quotes or not, and the Parlons admin RPC runs the WHOLE chain and
 *    returns the first reply (runSingleCommand, :196): a ";" in a path would run the rest of it as a second command, unseen;
 *  - a value in double quotes keeps its spaces (splitterQuotedPattern, :683; the slower splitter, :597, which a Windows path or a
 *    "{" / "[" selects); there is no escape character, so a '"' in a path cannot be carried;
 *  - the fast splitter puts spaces round every ":" first (:682), inside quotes too, so a ":" would change the path; a Windows path
 *    (":\") takes the slower splitter, which keeps it;
 *  - "{" / "[" start JSON reading (:610-628, :546-560).
 * So a path holding ; " : (but a Windows drive's) { } [ ] or a control character is refused, and every other path goes in quotes.
 */
const path = require("path");
const { N_ } = require("./lang").I18N;

// control characters, and the invisible ones that would make the path shown differ from the path given (zero widths, the
// direction marks, the word joiner, the byte order mark)
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u061c\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
// ponytail: 1 GB is above any backup this app's node makes (it reads the whole file into one array, restore.java readCompleteFile,
// with a 1.5 GB heap by default); raise it if a real backup is ever larger
const KINDS = {
  backup: { exts: [".bak"], min: 64, max: 1024 * 1024 * 1024, filter: N_("Node backup"),
    ext: "This is not a node backup file: a backup file's name ends in .bak. Nothing was sent.",
    small: "This file is too small to be a node backup ({size} bytes). Nothing was sent.",
    large: "This file is larger than any node backup this app can restore (over 1 GB). Nothing was sent." },
  megammr: { exts: [".mmr", ".megammr"], min: 1024, max: Infinity, filter: N_("MegaMMR file"),
    ext: "This is not a MegaMMR file: its name ends in .mmr or .megammr. Nothing was sent.",
    small: "This file is too small to be a MegaMMR file ({size} bytes). Nothing was sent." }
};
const BAD_PATH = "The file's path holds a character the node cannot be given safely: one of ; \" : [ ] { }, a backslash outside Windows, or a control character. Rename the file or move it to a plain folder (spaces are fine), then choose it again. Nothing was sent.";
const NOT_PLAIN = "Not a plain file: choose the file itself, not a folder, a link or a device. Nothing was sent.";
const UNREADABLE = "The file could not be read ({error}). Nothing was sent.";
const CHOOSE_FIRST = "Choose the file first (Choose…). Nothing was sent.";
const UNKNOWN_KIND = "Unknown kind of file.";
// The node's own databases folder (<data>/1.1/databases): the import and the restore replace what is in it, and a start without
// -megammr deletes its megammr.mmr (MinimaDB.java loadAllDB), so a file there is never one to read from.
const IN_DATABASES = "This file is inside the node's own databases folder, which the import replaces. Copy it to another folder first, then choose the copy. Nothing was sent.";
// The start of a MegaMMR file as the node writes it (megammr.java export, MegaMMRBackup.writeDataStream): the backup's version 1,
// the MegaMMR's version 1, then its MMR (block time, entry number, entry count). Anything else (a renamed file, a web page saved
// under the name) is refused before the node is touched; the whole file is read by the node's own reader later (megammr integrity).
const NOT_MEGAMMR = "This is not a MegaMMR file: it does not begin as a MegaMMR export does. Nothing was sent.";
// Room for a MegaMMR import (owner, 2026-11-22; refitted to the owner's mainnet import of 2026-11-23). The node refuses a file larger than its free heap and holds the whole MegaMMR in memory
// (megammr.java pre-flight); it writes it to <data>/…/databases/megammr.mmr and rebuilds the chain beside it.
const ROOM_HEAP = "This MegaMMR file is {file} MB. The node needs about four times that in memory while it checks and imports it: {need} MB, and it is set to {heap} MB. In Settings, set Parlons Node memory to {need} or more and press Apply and restart the node, then try again. Nothing was changed.";
// the plain Minima node is started with no memory setting: Java gives it a quarter of this computer's memory (node-manager buildArgs)
const ROOM_HEAP_PLAIN = "This MegaMMR file is {file} MB. The node needs about four times that in memory while it checks and imports it: {need} MB, and the plain Minima node gets {heap} MB here (a quarter of this computer's memory). In Settings, choose the Parlons Node, set Parlons Node memory to {need} or more and press Apply and restart the node, then try again. Nothing was changed.";
const ROOM_RAM = "This computer has {ram} MB of memory. The node would need {heap} MB of it for this MegaMMR file, which leaves too little for everything else, so it cannot be imported on this computer. Nothing was changed.";
const ROOM_DISK = "The node's data folder has {free} MB free, and this import needs about {need} MB. Make room, then try again. Nothing was changed.";
const ON_FAILED = "The node did not come back in MegaMMR mode, so nothing was imported, and the setting was put back as it was. Look at the Logs, and start the node again from the Node tab if it is stopped.";
const MB = 1024 * 1024;
/** The node's memory for an import: the Parlons Node's MegaMMR setting, or Java's own default for the plain node (a quarter of the memory). */
const importHeapMb = (kind, heapMb, ramBytes) => (kind === "minima" ? Math.floor(ramBytes / 4 / MB) : megammrHeapMb(heapMb));
/** The node's memory in MegaMMR mode: the app's own rule (main/node-manager.js buildParlonsArgs): the setting, else 3072 MB. */
const megammrHeapMb = (heapMb) => (parseInt(heapMb, 10) > 0 ? parseInt(heapMb, 10) : 3072);
/** Why there is no room for this import ("" = there is). o = { kind ("parlons" | "minima"), size (bytes), heapMb (the node's heap for the import:
 *  importHeapMb), ramBytes, freeDiskBytes (null: not known) }. */
function roomProblem(o) {
  // Measured (owner, mainnet, 2026-11-23, Parlons Node 0.2.160): a 1.5 GB file with 663,588 coins peaked at 5.5 GB of a 6144 MB heap during
  // the integrity check, on a node that had restarted into MegaMMR mode with a MegaMMR of 663,414 coins already loaded (its own copy in
  // memory too). So four times the file, which that import passes (1531 MB → 6124 MB) and nothing less than its peak would.
  // ponytail: one measurement; measure again if a file is refused that the node would have taken, or a node runs out at 4x
  const file = Math.ceil(o.size / MB), need = file * 4, heap = o.heapMb;
  if (heap < need) return say(o.kind === "minima" ? ROOM_HEAP_PLAIN : ROOM_HEAP, { file, need, heap });
  if (o.ramBytes < (heap + 1024) * MB) return say(ROOM_RAM, { ram: Math.floor(o.ramBytes / MB), heap });
  const disk = file * 2 + 512;   // the megammr.mmr the node writes, and the chain it rebuilds beside it
  if (o.freeDiskBytes != null && o.freeDiskBytes < disk * MB) return say(ROOM_DISK, { free: Math.floor(o.freeDiskBytes / MB), need: disk });
  return "";
}

/** Why the node cannot be given this path ("" = it can, in double quotes). */
function pathProblem(p, platform) {
  const s = String(p == null ? "" : p), win = (platform || process.platform) === "win32";
  if (!s || s.length > 1024 || CTRL.test(s) || /[;"{}[\]]/.test(s)) return BAD_PATH;
  if (win) { if (!/^[A-Za-z]:\\/.test(s) || s.indexOf(":", 2) !== -1) return BAD_PATH; }
  else if (!s.startsWith("/") || /[:\\]/.test(s)) return BAD_PATH;
  return "";
}
const say = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));

/** The file at p for this kind, as the node will read it: { path (links in its folders resolved), size }. Throws the plain reason.
 *  dataDir: the node's data folder; a file in a "databases" folder inside it is refused (IN_DATABASES). */
function check(kind, p, fs, platform, dataDir) {
  const K = KINDS[kind]; if (!K) throw new Error(UNKNOWN_KIND);
  let st, real;
  try { st = fs.lstatSync(p); } catch (e) { throw new Error(say(UNREADABLE, { error: e.code || e.message })); }
  if (!st.isFile()) throw new Error(NOT_PLAIN);   // a folder, a device, a pipe, or a link (lstat does not follow it)
  try { real = fs.realpathSync(p); st = fs.lstatSync(real); } catch (e) { throw new Error(say(UNREADABLE, { error: e.code || e.message })); }
  if (!st.isFile()) throw new Error(NOT_PLAIN);
  if (!K.exts.includes(path.extname(real).toLowerCase())) throw new Error(K.ext);
  const why = pathProblem(real, platform); if (why) throw new Error(why);
  if (st.size < K.min) throw new Error(say(K.small, { size: st.size }));
  if (st.size > K.max) throw new Error(K.large);
  if (dataDir) {
    let data = String(dataDir); try { data = fs.realpathSync(data); } catch (e) { /* not there yet: compared as written */ }
    const rel = path.relative(data, real);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && rel.split(path.sep).slice(0, -1).some(s => s.toLowerCase() === "databases")) throw new Error(IN_DATABASES);
  }
  try { fs.accessSync(real, fs.constants.R_OK); } catch (e) { throw new Error(say(UNREADABLE, { error: e.code || e.message })); }
  return { path: real, size: st.size };
}

/** The value of the node's file: parameter, or throws. */
function fileValue(p, platform) { const why = pathProblem(p, platform); if (why) throw new Error(why); return '"' + p + '"'; }
function megammrImportCommand(p, platform) { return "megammr action:import file:" + fileValue(p, platform); }
/** The node's own whole-file check (megammr.java integrity): reads the file as the import does and checks that its blocks follow its
 *  MegaMMR and that every coin's proof holds. It changes nothing in the node. */
function megammrCheckCommand(p, platform) { return "megammr action:integrity file:" + fileValue(p, platform); }

/** The first bytes of a MegaMMR file, read as the node reads them (MiniNumber: scale byte, length byte, the number's bytes;
 *  MMREntryNumber: a MiniNumber scale, then an int length and the bytes). → { tip } (the block its MegaMMR ends at); throws NOT_MEGAMMR. */
function megammrHeader(p, fs) {
  const b = Buffer.alloc(256); let n = 0, fd;
  try { fd = fs.openSync(p, "r"); n = fs.readSync(fd, b, 0, b.length, 0); } catch (e) { throw new Error(say(UNREADABLE, { error: e.code || e.message })); }
  finally { if (fd != null) try { fs.closeSync(fd); } catch (e) { /* closed */ } }
  let at = 0;
  const bad = () => { throw new Error(NOT_MEGAMMR); };
  const num = () => {   // a whole, non-negative MiniNumber
    if (at + 2 > n) bad();
    const scale = b.readInt8(at), len = b.readInt8(at + 1); at += 2;
    if (scale !== 0 || len < 1 || len > 32 || at + len > n || (b[at] & 0x80)) bad();
    let v = 0n; for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(b[at + i]); at += len; return v;
  };
  if (num() !== 1n || num() !== 1n) bad();   // the backup's version, then the MegaMMR's
  const tip = num();                          // the MMR's block time
  if (num() !== 0n) bad();                    // the entry number's scale
  if (at + 4 > n) bad();
  const len = b.readInt32BE(at); at += 4;
  if (len < 1 || len > 64 || at + len > n) bad();
  at += len; num();                           // the entry number's bytes, then how many MMR entries follow
  return { tip: tip.toString() };
}

/**
 * The picked files, one per kind, held in the main process. deps = { fs, platform, showOpen(options) → { canceled, filePaths },
 * defaultPath(), t (the dialog's words), dataDir() (the node's data folder) }. pick(kind) → null (cancelled) or { path, size } (thrown: why the file is refused, and nothing is kept);
 * confirm(kind, shown) → the path, checked again, when it is the one shown; otherwise throws.
 */
function create(deps) {
  const fs = deps.fs || require("fs"), picked = {};
  return {
    async pick(kind) {
      const K = KINDS[kind]; if (!K) throw new Error(UNKNOWN_KIND);
      delete picked[kind];
      const r = await deps.showOpen({ properties: ["openFile"], defaultPath: deps.defaultPath ? deps.defaultPath() : undefined,
        filters: [{ name: deps.t ? deps.t(K.filter) : K.filter, extensions: K.exts.map(e => e.slice(1)) }] });
      if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return null;
      return this.remember(kind, r.filePaths[0]);
    },
    remember(kind, candidate) {
      const f = check(kind, candidate, fs, deps.platform, deps.dataDir && deps.dataDir());
      picked[kind] = f.path;
      return f;
    },
    confirm(kind, shown) {
      const p = picked[kind];
      if (!p || shown !== p) throw new Error(CHOOSE_FIRST);
      const f = check(kind, p, fs, deps.platform, deps.dataDir && deps.dataDir());
      if (f.path !== p) { delete picked[kind]; throw new Error(NOT_PLAIN); }   // a folder on the way became a link since it was chosen
      return p;
    },
    /** Used: a later run needs the file chosen again. */
    forget(kind) { delete picked[kind]; }
  };
}

module.exports = { pathProblem, check, fileValue, megammrImportCommand, megammrCheckCommand, megammrHeader, create, roomProblem, megammrHeapMb, importHeapMb, say,
  KINDS, BAD_PATH, NOT_PLAIN, UNREADABLE, CHOOSE_FIRST, UNKNOWN_KIND, IN_DATABASES, NOT_MEGAMMR, ON_FAILED };
