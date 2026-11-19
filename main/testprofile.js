/*
 * testprofile.js — a TEST copy of the app that cannot touch the real install (0.18.140; scripts/dev-run.sh).
 *
 * Required FIRST by main.js. With MCD_TEST_PROFILE=<folder> the app keeps everything in that folder instead of the
 * real userData, and takes a separate name for each thing that is NOT kept by folder:
 *   - the login keychain service (main/config.js): the RPC secret, the secret start-up parameters, the mail and
 *     shop identities and the P2P Chance commit preimages all sit under ONE service name. Sharing it, a test copy
 *     would overwrite the real install's mail identity with its own node's;
 *   - the app name, which names Electron's "<name> Safe Storage" keychain key (safeStorage, the file fallback);
 *   - "Open at login" is never registered (main/loginitem.js) and the update feed is never read (main.js);
 *   - the single-instance lock follows userData, so it is separate once the folder is.
 * The folder must not be the real userData, inside it, or around it: refused here as well as in the launcher.
 */
const path = require("path"), crypto = require("crypto");

/** Same folder, or one inside the other. Case is ignored: the Mac's file system does. */
function overlaps(a, b) {
  const norm = (p) => path.resolve(String(p)).toLowerCase(), x = norm(a), y = norm(b);
  const within = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  return within(x, y) || within(y, x);
}

/** → { on, dir, keychainSuffix, error }. Pure: tested in scripts/shell-test.cjs. */
function profile(env, realUserData) {
  const raw = String((env && env.MCD_TEST_PROFILE) || "").trim();
  if (!raw) return { on: false, dir: "", keychainSuffix: "", error: "" };
  const dir = path.resolve(raw);
  if (!path.isAbsolute(raw)) return { on: true, dir, keychainSuffix: "", error: "MCD_TEST_PROFILE must be a full path: " + raw };
  if (realUserData && overlaps(dir, realUserData)) return { on: true, dir, keychainSuffix: "", error: "MCD_TEST_PROFILE (" + dir + ") is, is inside, or contains the real install's folder " + realUserData };
  return { on: true, dir, keychainSuffix: ".test." + crypto.createHash("sha256").update(dir.toLowerCase()).digest("hex"), error: "" };
}

let app = null; try { app = require("electron").app || null; } catch (e) { /* plain node (tests) */ }
let real = ""; try { real = app ? app.getPath("userData") : ""; } catch (e) { app = null; }   // a test's stand-in app
const P = profile(process.env, real);
if (P.on && app) {
  if (P.error) { console.error("REFUSED: " + P.error + ". The app was not started."); app.exit(2); process.exit(2); }
  app.setName("minimaCore TEST");
  app.setPath("userData", P.dir);
  if (path.resolve(app.getPath("userData")) !== P.dir) { console.error("REFUSED: the TEST profile folder could not be set. The app was not started."); app.exit(2); process.exit(2); }
}

module.exports = Object.assign({ profile, overlaps }, P);
