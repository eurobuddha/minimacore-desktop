/*
 * flavor.js — WHICH APP THIS IS (0.19.105). Required FIRST by main.js, before anything reads a path, the config, the
 * keychain or takes the single-instance lock.
 *
 * One source tree builds more than one app. A FLAVOUR is chosen at BUILD time, never at run time: the build script
 * (scripts/build-flavor.cjs) writes `"flavor": "<id>"` into the packaged package.json (electron-builder
 * extraMetadata), and this file reads it from there. There is no setting, switch or environment variable that turns
 * one app into the other. With no flavour written, this is the RELEASED app (minimaCore), and nothing below changes
 * anything about it: no name is set, no path is set.
 *
 * Everything that is kept by IDENTITY rather than by folder follows the flavour, from this one table:
 *   productName      the app's name: the menu bar, About, ~/Library/Logs/<name>, and Electron's safeStorage keychain
 *                    item "<name> Safe Storage" (Electron names it after the app's name when it starts)
 *   appId            the bundle id (preferences, saved state, notifications, the OS login item)
 *   userData         the FOLDER NAME under the OS's application-data folder: config, node data, wallet, every store,
 *                    the node's pidfile and log, the single-instance lock, the crash dumps
 *   keychainService  the login keychain service every secret of the app sits under (main/config.js)
 *   basePort         the default base port; every other port is derived from it (main/node-manager.js PORTS)
 *   updates          whether the app may read an update feed at all (main/updater.js)
 *   loginItem        whether "Open at login" may register the app with the OS (main/loginitem.js)
 *
 * A TEST PROFILE (scripts/dev-run.sh) is "this flavour, in a folder of its own": MCD_TEST_PROFILE=<folder> keeps
 * everything in that folder, adds ".test.<sha256 of the folder>" to the keychain service and " TEST" to the name.
 *
 * The released install's folder is ALWAYS <appData>/minimaCore: it is derived from appData, never from userData
 * (userData is what a `--user-data-dir` switch moves; deriving the "real" folder from it made the overlap check
 * compare the profile with itself). `--user-data-dir` is refused outright for a flavour and for a TEST profile.
 */
const path = require("path"), crypto = require("crypto");

/** The released app. These values are the ones every install since 0.1 has: do not edit them. */
const RELEASED = Object.freeze({ id: "", productName: "minimaCore", appId: "com.eurobuddha.minimacore", userData: "minimaCore",
  keychainService: "com.eurobuddha.minimacore.rpc", basePort: 12001, updates: true, loginItem: true,
  windowTitle: "Minima Core", autostartFile: "minimacore.desktop", artifact: "minimaCore" });
const KEYS = ["productName", "appId", "userData", "keychainService", "basePort"];   // must ALL differ from the released app's

/** The flavour a package.json names ({ flavor, flavors }). Throws when it is named and is not a whole, separate identity. */
function resolve(pkg) {
  const id = String((pkg && pkg.flavor) || "");
  if (!id) return RELEASED;
  const f = pkg.flavors && pkg.flavors[id];
  if (!f || typeof f !== "object") throw new Error("package.json names the flavour '" + id + "' but does not define it");
  for (const k of KEYS) {
    if (f[k] == null || f[k] === "") throw new Error("flavour '" + id + "' has no " + k);
    if (String(f[k]).toLowerCase() === String(RELEASED[k]).toLowerCase()) throw new Error("flavour '" + id + "' has the released app's " + k + " (" + f[k] + "): the two apps would share it");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(f.userData)) throw new Error("flavour '" + id + "': userData must be a plain folder name, not a path: " + f.userData);
  if (String(f.keychainService).toLowerCase().startsWith(RELEASED.keychainService.toLowerCase())) throw new Error("flavour '" + id + "': its keychain service must not begin with the released app's");
  if (!(Number.isInteger(f.basePort) && f.basePort >= 1024 && f.basePort <= 64900)) throw new Error("flavour '" + id + "': basePort must be a whole number between 1024 and 64900");
  if (Math.abs(f.basePort - RELEASED.basePort) < 1000) throw new Error("flavour '" + id + "': basePort is within the released app's port range");
  return Object.freeze({ id, productName: String(f.productName), appId: String(f.appId), userData: String(f.userData), keychainService: String(f.keychainService),
    basePort: f.basePort, updates: f.updates === true, loginItem: f.loginItem === true, windowTitle: String(f.windowTitle || f.productName),
    autostartFile: String(f.autostartFile || (String(f.appId) + ".desktop")), artifact: String(f.artifact || f.userData) });
}

/** Same folder, or one inside the other. Case is ignored: the Mac's file system does. */
function overlaps(a, b) {
  const norm = (p) => path.resolve(String(p)).toLowerCase(), x = norm(a), y = norm(b);
  const within = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  return within(x, y) || within(y, x);
}

/**
 * Where this run keeps its data and under which names. F: resolve(); env: process.env; argv: process.argv; appData:
 * the OS's application-data folder. Pure (tests). → { set, dir, name, keychainService, test, error }:
 *   set:false  the released app, as it has always been: nothing is to be set (dir and name are "")
 *   set:true   userData must be `dir` and the app's name `name`, before anything else runs
 *   error      why the app must NOT start
 */
function place(F, env, argv, appData) {
  const raw = String((env && env.MCD_TEST_PROFILE) || "").trim(), test = !!raw;
  const out = { set: false, dir: "", name: "", keychainService: F.keychainService, test, error: "" };
  if (!F.id && !test) return out;
  out.set = true;
  out.name = F.productName + (test ? " TEST" : "");
  const released = path.join(String(appData || ""), RELEASED.userData), own = path.join(String(appData || ""), F.userData);
  if ((argv || []).some(a => /^--user-data-dir(=|$)/.test(String(a)))) { out.error = "--user-data-dir is not accepted: " + (test ? "a TEST profile" : F.productName) + " keeps its data in a folder fixed by the app itself."; return out; }
  if (!appData || !path.isAbsolute(String(appData))) { out.error = "the application-data folder could not be read"; return out; }
  if (!test) { out.dir = own; if (overlaps(out.dir, released)) out.error = "this app's data folder (" + out.dir + ") is, is inside, or contains the released app's folder " + released; return out; }
  out.dir = path.resolve(raw);
  if (!path.isAbsolute(raw)) { out.error = "MCD_TEST_PROFILE must be a full path: " + raw; return out; }
  if (overlaps(out.dir, released)) { out.error = "MCD_TEST_PROFILE (" + out.dir + ") is, is inside, or contains the released install's folder " + released; return out; }
  if (F.id && overlaps(out.dir, own)) { out.error = "MCD_TEST_PROFILE (" + out.dir + ") is, is inside, or contains this app's own folder " + own; return out; }
  out.keychainService = F.keychainService + ".test." + crypto.createHash("sha256").update(out.dir.toLowerCase()).digest("hex");
  return out;
}

// ---- applied once, here, when the main process starts ----
let app = null; try { app = require("electron").app || null; } catch (e) { /* plain node (tests) */ }
const F = resolve(require("../package.json"));
let appData = ""; try { appData = app ? app.getPath("appData") : ""; } catch (e) { app = null; }   // a test's stand-in app
const P = app ? place(F, process.env, process.argv, appData) : { set: false, dir: "", name: "", keychainService: F.keychainService, test: false, error: "" };
if (app && P.set) {
  const refuse = (why) => { console.error("REFUSED: " + why + ". The app was not started."); try { app.exit(2); } catch (e) {} process.exit(2); };
  if (P.error) refuse(P.error);
  app.setName(P.name);
  app.setPath("userData", P.dir);
  let now = ""; try { now = path.resolve(app.getPath("userData")); } catch (e) {}
  if (now !== path.resolve(P.dir)) refuse("the data folder could not be set to " + P.dir);
  if (overlaps(now, path.join(appData, RELEASED.userData))) refuse("the data folder resolves into the released app's folder");
}

module.exports = Object.assign({}, F, { test: P.test, keychainService: P.keychainService, dataDir: P.dir, RELEASED, resolve, place, overlaps });
