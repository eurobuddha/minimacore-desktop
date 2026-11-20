/*
 * securescreen.js — keeping the window out of screen captures while a seed phrase can be on it (Entropy), as the phone's
 * FLAG_SECURE. Electron's setContentProtection works on macOS and Windows; Linux has no such switch.
 *
 * It answers WHAT WAS SET, never a promise about the result: { on, platform }. `on` is true only when the switch was
 * turned on by a call that did not throw, on a platform that has it. Whether a given recorder then honours it was not
 * tested (the app cannot be launched where this was written), so the screen says "asked the system", not "protected".
 *
 * Protection never outlives the page that asked for it: a load, a reload or a renderer crash turns it off (watch()),
 * so a window left protected by a page that is gone cannot stay black in captures for the rest of the run.
 */
"use strict";
function set(win, on, platform) {
  platform = platform || process.platform;
  if (!win || win.isDestroyed() || platform === "linux") return { on: false, platform };
  try { win.setContentProtection(on === true); return { on: on === true, platform }; } catch (e) { return { on: false, platform }; }
}
/** A new page in the window, or its renderer gone: whatever asked for protection is no longer there. */
function watch(win, platform) {
  const off = () => { set(win, false, platform); };
  win.webContents.on("did-finish-load", off);
  win.webContents.on("render-process-gone", off);
}
module.exports = { set, watch };
