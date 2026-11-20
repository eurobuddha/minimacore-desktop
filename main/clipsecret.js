/*
 * clipsecret.js — a secret on the clipboard (the ETH private key), 0.18.152. It is written here, by the main process,
 * and taken off again after a minute and when the app quits, each time ONLY if the clipboard still holds exactly that
 * text: something the user copied since is never cleared. The secret is kept in memory only until it has been cleared
 * or replaced.
 */
const CLEAR_MS = 60000;
/** create(clipboard: { writeText, readText, clear }, timers?) → { copy(text), clearNow() }. */
function create(clipboard, timers) {
  const T = timers || { setTimeout, clearTimeout };
  let held = "", timer = null;
  /** Clear the clipboard if it still holds the secret; forget the secret either way. → whether it was cleared. */
  function clearNow() {
    const t = held; held = "";
    if (timer) { T.clearTimeout(timer); timer = null; }
    if (!t) return false;
    try { if (clipboard.readText() === t) { clipboard.clear(); return true; } } catch (e) {}
    return false;
  }
  function copy(text) {
    const t = String(text == null ? "" : text);
    if (timer) { T.clearTimeout(timer); timer = null; }
    clipboard.writeText(t); held = t;
    timer = T.setTimeout(clearNow, CLEAR_MS);
    return true;
  }
  return { copy, clearNow };
}
module.exports = { create, CLEAR_MS };
