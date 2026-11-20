/*
 * syscheck.js — the system's own "is it you" step of every secret gate (0.18.176): the seed (main/seedgate.js), the ETH
 * key (main/ethwallet.js exportKeyGated) and the Terminal's secret commands (main/cmdgate.js). It comes after the typed
 * phrase, never instead of it.
 *
 *  - Touch ID where the Mac can prompt now; the reason names what is about to be shown (for a command: the command).
 *  - Once a Touch ID prompt has SUCCEEDED on this install, a file in the app's data folder says so, with an identifier of
 *    this Mac (0.18.186; its IOPlatformUUID since 0.18.191). While it is there and names this Mac, a Mac that cannot prompt now (Touch ID locked after failed
 *    tries, the sensor gone, a call that throws) is REFUSED with a plain message naming the file: it never falls back to
 *    the phrase alone. The renderer cannot remove that file; a file from another Mac (a copied profile) is ignored.
 *  - Where Touch ID was never available: a dialog from the main process shows exactly what is about to be shown and
 *    must be confirmed. The answer says that no biometric check took place.
 *
 * io = { can() -> bool, prompt(reason) -> Promise, confirm(detail) -> Promise<bool>, seen() -> bool, markSeen(), where() -> path }.
 * check(reason, detail) → { biometric: bool }; throws "Cancelled" or the plain refusal.
 */
const fs = require("fs");
const path = require("path");

function create(io) {
  async function check(reason, detail) {
    let can = false; try { can = !!io.can(); } catch (e) { can = false; }
    if (can) {
      try { await io.prompt(String(reason).slice(0, 120)); } catch (e) { throw new Error("Cancelled"); }
      try { io.markSeen(); } catch (e) {}   // only once a prompt has SUCCEEDED (0.18.186)
      return { biometric: true };
    }
    let seen = false; try { seen = !!io.seen(); } catch (e) { seen = true; }
    if (seen) {
      let where = ""; try { where = String(io.where() || ""); } catch (e) {}
      throw new Error("Touch ID has worked in this app on this Mac before but cannot be asked now, so nothing was shown. "
        + "If Touch ID is locked after too many tries, lock the screen and log in again with your password; Touch ID then works again. "
        + "If this Mac no longer has Touch ID, quit the app and delete this file: " + where + " . The app then asks with a confirmation window instead.");
    }
    let ok = false; try { ok = await io.confirm(String(detail)); } catch (e) { ok = false; }
    if (!ok) throw new Error("Cancelled");
    return { biometric: false };
  }
  return { check };
}

/** The real one: Electron's Touch ID, a main-process message box, and a marker file in userData. */
/** An identifier of this Mac (0.18.191): its IOPlatformUUID, read once with /usr/sbin/ioreg (absolute path, no shell),
 *  then cached. "" when it cannot be read (not a Mac, ioreg missing): a marker is then taken as this Mac's. Never the
 *  network interfaces (an adapter plugged in changed them). run: for tests only. */
let cachedId = null;
function machineId(run) {
  if (cachedId != null && !run) return cachedId;
  let id = "";
  try {
    const out = (run || ((f, a) => require("child_process").execFileSync(f, a, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })))("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const m = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{8,64})"/.exec(String(out)); id = m ? m[1].toUpperCase() : "";
  } catch (e) { id = ""; }
  if (!run) cachedId = id;
  return id;
}
/** Is a marker this Mac's? An id that cannot be read, on either side, counts as the same Mac. */
function sameMac(markerId, hereId) { return !markerId || !hereId || markerId === hereId; }
function forElectron(electron, win) {
  const { systemPreferences, dialog, app } = electron;
  const marker = () => path.join(app.getPath("userData"), "touchid-seen");
  const read = () => { try { return JSON.parse(fs.readFileSync(marker(), "utf8")); } catch (e) { return null; } };
  return create({
    can: () => process.platform === "darwin" && systemPreferences.canPromptTouchID(),
    prompt: (why) => systemPreferences.promptTouchID(why),
    confirm: async (detail) => {
      const r = await dialog.showMessageBox(win && win() ? win() : undefined, { type: "warning", buttons: ["Cancel", "Show it"], defaultId: 0, cancelId: 0, noLink: true,
        message: "Show a secret?", detail: detail + "\n\nNo biometric check is available on this computer: this confirmation and the typed phrase are the only checks." });
      return r.response === 1;
    },
    seen: () => { const m = read(); return !!(m && sameMac(m.machine, machineId())); },   // a marker from another Mac is ignored
    markSeen: () => { const m = read(); if (!(m && sameMac(m.machine, machineId()))) fs.writeFileSync(marker(), JSON.stringify({ machine: machineId(), since: new Date().toISOString() }) + "\n", { mode: 0o600 }); },
    where: () => marker()
  });
}

module.exports = { create, forElectron, machineId, sameMac };
