/*
 * syscheck.js — the system's own "is it you" step of every secret gate (0.18.176): the seed (main/seedgate.js), the ETH
 * key (main/ethwallet.js exportKeyGated) and the Terminal's secret commands (main/cmdgate.js). It comes after the typed
 * phrase, never instead of it.
 *
 *  - Touch ID where the Mac can prompt now; the reason names what is about to be shown (for a command: the command).
 *  - Once Touch ID has worked on this install, a file in the app's data folder says so. While it is there, a Mac that
 *    cannot prompt now (Touch ID locked after failed tries, the sensor gone, a call that throws) is REFUSED with a plain
 *    message: it never falls back to the phrase alone. The renderer cannot remove that file.
 *  - Where Touch ID was never available: a dialog from the main process shows exactly what is about to be shown and
 *    must be confirmed. The answer says that no biometric check took place.
 *
 * io = { can() -> bool, prompt(reason) -> Promise, confirm(detail) -> Promise<bool>, seen() -> bool, markSeen() }.
 * check(reason, detail) → { biometric: bool }; throws "Cancelled" or the plain refusal.
 */
const fs = require("fs");
const path = require("path");

function create(io) {
  async function check(reason, detail) {
    let can = false; try { can = !!io.can(); } catch (e) { can = false; }
    if (can) {
      try { io.markSeen(); } catch (e) {}
      try { await io.prompt(String(reason).slice(0, 120)); } catch (e) { throw new Error("Cancelled"); }
      return { biometric: true };
    }
    let seen = false; try { seen = !!io.seen(); } catch (e) { seen = true; }
    if (seen) throw new Error("Touch ID has been used on this computer before but cannot be asked now (it may be locked after too many tries). Unlock it in System Settings (or with your password at the lock screen), then try again. Nothing was shown.");
    let ok = false; try { ok = await io.confirm(String(detail)); } catch (e) { ok = false; }
    if (!ok) throw new Error("Cancelled");
    return { biometric: false };
  }
  return { check };
}

/** The real one: Electron's Touch ID, a main-process message box, and a marker file in userData. */
function forElectron(electron, win) {
  const { systemPreferences, dialog, app } = electron;
  const marker = () => path.join(app.getPath("userData"), "touchid-seen");
  return create({
    can: () => process.platform === "darwin" && systemPreferences.canPromptTouchID(),
    prompt: (why) => systemPreferences.promptTouchID(why),
    confirm: async (detail) => {
      const r = await dialog.showMessageBox(win && win() ? win() : undefined, { type: "warning", buttons: ["Cancel", "Show it"], defaultId: 0, cancelId: 0, noLink: true,
        message: "Show a secret?", detail: detail + "\n\nNo biometric check is available on this computer: this confirmation and the typed phrase are the only checks." });
      return r.response === 1;
    },
    seen: () => fs.existsSync(marker()),
    markSeen: () => { if (!fs.existsSync(marker())) fs.writeFileSync(marker(), new Date().toISOString() + "\n", { mode: 0o600 }); }
  });
}

module.exports = { create, forElectron };
