/*
 * syscheck.js: the system's own "is it you" step of every secret gate (0.19.188, port of the released desktop's
 * main/syscheck.js 0.18.176 and 0.18.186): the Terminal's secret commands and Show seed phrase (main/seedgate.js) and the
 * ETH key (main/ethwallet.js exportKeyGated). It comes after the typed phrase, never instead of it.
 *
 *  - Touch ID where the Mac can prompt now; the reason names what is about to be shown (for a command: the command).
 *  - Once a Touch ID prompt has SUCCEEDED on this install, a file in the app's data folder says so, with an identifier of
 *    this Mac. While it is there and names this Mac, a Mac that cannot prompt now (Touch ID locked after failed tries, the
 *    sensor gone, a call that throws) is REFUSED with a plain message naming the file: it never falls back to the phrase
 *    alone. The window cannot remove that file; a file from another Mac (a copied profile) is ignored.
 *  - Where Touch ID was never available: a message box of the main process shows exactly what is about to be shown and
 *    must be confirmed. The answer says that no Touch ID check took place.
 *
 * A reason or a detail is a catalog key, or [key, params]: it is said in the app's language (main/lang.js). A Touch ID
 * reason is cut at 120 characters by the system, so a translated one that would be longer is said in English, which the
 * callers keep inside that limit: the command it names is never cut.
 * io = { can() -> bool, prompt(reason) -> Promise, confirm(detail) -> Promise<bool>, seen() -> bool, markSeen(), where() -> path }.
 * check(reason, detail) -> { biometric: bool }; throws "Cancelled" or the plain refusal.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const lang = require("./lang");
const REASON_MAX = 120;
const fill = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && Object.hasOwn(p, k) ? String(p[k]) : m));

function create(io, t) {
  const say = (x, tr) => (Array.isArray(x) ? tr(x[0], x[1] || {}) : tr(String(x)));
  const tt = typeof t === "function" ? t : lang.t;
  async function check(reason, detail) {
    let can = false; try { can = !!io.can(); } catch (e) { can = false; }
    if (can) {
      let why = say(reason, tt); if (why.length > REASON_MAX) why = say(reason, fill);
      try { await io.prompt(why.slice(0, REASON_MAX)); } catch (e) { throw new Error("Cancelled"); }
      try { io.markSeen(); } catch (e) {}   // only once a prompt has SUCCEEDED
      return { biometric: true };
    }
    let seen = false; try { seen = !!io.seen(); } catch (e) { seen = true; }
    if (seen) {
      let where = ""; try { where = String(io.where() || ""); } catch (e) {}
      throw new Error("Touch ID has worked in this app on this Mac before but cannot be asked now, so nothing was shown. If Touch ID is locked after too many tries, lock the screen and log in again with your password; Touch ID then works again. If this Mac no longer has Touch ID, quit the app and delete this file: " + where + " . The app then asks with a confirmation window instead.");
    }
    let ok = false; try { ok = await io.confirm(say(detail, tt)); } catch (e) { ok = false; }
    if (!ok) throw new Error("Cancelled");
    return { biometric: false };
  }
  return { check };
}

/** An identifier of this Mac: a hash of its built-in network card's hardware address (en0), else of all of them. */
function machineId() {
  const os = require("os"), nets = os.networkInterfaces();
  const macs = (k) => (nets[k] || []).map(n => n.mac).filter(m => m && m !== "00:00:00:00:00:00");
  const list = macs("en0").length ? macs("en0") : Object.keys(nets).sort().flatMap(macs);
  return require("crypto").createHash("sha256").update(os.platform() + "|" + [...new Set(list)].sort().join(",")).digest("hex");
}
/** The real one: Electron's Touch ID, a main-process message box, and a marker file in userData. */
function forElectron(electron, win) {
  const { systemPreferences, dialog, app } = electron;
  const marker = () => path.join(app.getPath("userData"), "touchid-seen");
  const read = () => { try { return JSON.parse(fs.readFileSync(marker(), "utf8")); } catch (e) { return null; } };
  return create({
    can: () => process.platform === "darwin" && systemPreferences.canPromptTouchID(),
    prompt: (why) => systemPreferences.promptTouchID(why),
    confirm: async (detail) => {
      const w = win && win();
      const r = await dialog.showMessageBox(w && !w.isDestroyed() ? w : undefined, { type: "warning", buttons: [lang.t("Cancel"), lang.t("Show it")], defaultId: 0, cancelId: 0, noLink: true,
        message: lang.t("Show a secret?"), detail: detail + "\n\n" + lang.t("No Touch ID check is available on this computer: this confirmation and the typed phrase are the only checks.") });
      return r.response === 1;
    },
    seen: () => { const m = read(); return !!(m && m.machine === machineId()); },   // a marker from another Mac is ignored
    markSeen: () => { const m = read(); if (!(m && m.machine === machineId())) fs.writeFileSync(marker(), JSON.stringify({ machine: machineId(), since: new Date().toISOString() }) + "\n", { mode: 0o600 }); },
    where: () => marker()
  });
}

module.exports = { create, forElectron, machineId, REASON_MAX };
