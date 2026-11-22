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

const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
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
const NEEDS_MEGAMMR = "This node does not keep the MegaMMR, so it cannot import a MegaMMR file. Switch on MegaMMR mode in Startup Params (the node then needs more memory; a large file needs a lot: Settings, Parlons Node memory), then try again. Nothing was sent.";

/** Why the node cannot be given this path ("" = it can, in double quotes). */
function pathProblem(p, platform) {
  const s = String(p == null ? "" : p), win = (platform || process.platform) === "win32";
  if (!s || s.length > 1024 || CTRL.test(s) || /[;"{}[\]]/.test(s)) return BAD_PATH;
  if (win) { if (!/^[A-Za-z]:\\/.test(s) || s.indexOf(":", 2) !== -1) return BAD_PATH; }
  else if (!s.startsWith("/") || /[:\\]/.test(s)) return BAD_PATH;
  return "";
}
const say = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));

/** The file at p for this kind, as the node will read it: { path (links in its folders resolved), size }. Throws the plain reason. */
function check(kind, p, fs, platform) {
  const K = KINDS[kind]; if (!K) throw new Error("Unknown kind of file.");
  let st, real;
  try { st = fs.lstatSync(p); } catch (e) { throw new Error(say(UNREADABLE, { error: e.code || e.message })); }
  if (!st.isFile()) throw new Error(NOT_PLAIN);   // a folder, a device, a pipe, or a link (lstat does not follow it)
  try { real = fs.realpathSync(p); st = fs.lstatSync(real); } catch (e) { throw new Error(say(UNREADABLE, { error: e.code || e.message })); }
  if (!st.isFile()) throw new Error(NOT_PLAIN);
  if (!K.exts.includes(path.extname(real).toLowerCase())) throw new Error(K.ext);
  const why = pathProblem(real, platform); if (why) throw new Error(why);
  if (st.size < K.min) throw new Error(say(K.small, { size: st.size }));
  if (st.size > K.max) throw new Error(K.large);
  try { fs.accessSync(real, fs.constants.R_OK); } catch (e) { throw new Error(say(UNREADABLE, { error: e.code || e.message })); }
  return { path: real, size: st.size };
}

/** The value of the node's file: parameter, or throws. */
function fileValue(p, platform) { const why = pathProblem(p, platform); if (why) throw new Error(why); return '"' + p + '"'; }
function megammrImportCommand(p, platform) { return "megammr action:import file:" + fileValue(p, platform); }

/**
 * The picked files, one per kind, held in the main process. deps = { fs, platform, showOpen(options) → { canceled, filePaths },
 * defaultPath(), t (the dialog's words) }. pick(kind) → null (cancelled) or { path, size } (thrown: why the file is refused, and nothing is kept);
 * confirm(kind, shown) → the path, checked again, when it is the one shown; otherwise throws.
 */
function create(deps) {
  const fs = deps.fs || require("fs"), picked = {};
  return {
    async pick(kind) {
      const K = KINDS[kind]; if (!K) throw new Error("Unknown kind of file.");
      delete picked[kind];
      const r = await deps.showOpen({ properties: ["openFile"], defaultPath: deps.defaultPath ? deps.defaultPath() : undefined,
        filters: [{ name: deps.t ? deps.t(K.filter) : K.filter, extensions: K.exts.map(e => e.slice(1)) }] });
      if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return null;
      const f = check(kind, r.filePaths[0], fs, deps.platform);
      picked[kind] = f.path;
      return f;
    },
    confirm(kind, shown) {
      const p = picked[kind];
      if (!p || shown !== p) throw new Error(CHOOSE_FIRST);
      const f = check(kind, p, fs, deps.platform);
      if (f.path !== p) { delete picked[kind]; throw new Error(NOT_PLAIN); }   // a folder on the way became a link since it was chosen
      return p;
    }
  };
}

module.exports = { pathProblem, check, fileValue, megammrImportCommand, create, KINDS, BAD_PATH, NOT_PLAIN, UNREADABLE, CHOOSE_FIRST, NEEDS_MEGAMMR };
