/*
 * loginitem.js — "Open at login": start minimaCore Desktop (and so its node) when the user logs in.
 *
 * mac / Windows: the OS keeps the list; Electron's app.setLoginItemSettings registers this app bundle.
 * Linux: there is no OS API — the XDG autostart convention is a .desktop file in ~/.config/autostart. The
 *        AppImage exposes its own path as $APPIMAGE (process.execPath would point inside the mount, which is
 *        gone after quit), so that is what Exec= gets.
 *
 * Re-applied on every boot from the saved setting, so a moved AppImage or a re-installed app re-registers
 * itself without the user touching Settings again. Only a packaged app registers: in development the entry
 * would point at the bare electron binary.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const DESKTOP_FILE = "minimacore.desktop";

function linuxAutostartPath() { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart", DESKTOP_FILE); }

function linuxDesktopEntry(exec) {
  return ["[Desktop Entry]", "Type=Application", "Name=minimaCore", "Comment=Start the minimaCore node at login",
    "Exec=" + exec, "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n");
}

/** Register or remove the login item. Returns { ok, on, note } — never throws (Settings shows the note). */
function apply(app, on) {
  on = !!on;
  try {
    if (!app.isPackaged) return { ok: false, on, note: "not registered: development build" };
    if (process.platform === "linux") {
      const p = linuxAutostartPath();
      if (on) {
        const exec = process.env.APPIMAGE || process.execPath;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, linuxDesktopEntry(exec), { mode: 0o644 });
      } else if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true, on };
    }
    app.setLoginItemSettings({ openAtLogin: on });
    return { ok: true, on };
  } catch (e) {
    return { ok: false, on, note: String((e && e.message) || e) };
  }
}

module.exports = { apply, linuxAutostartPath, linuxDesktopEntry };
