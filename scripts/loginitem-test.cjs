/* loginitem-test.cjs — "Open at login" never throws, registers only a packaged app, and on Linux writes a
 * valid XDG autostart entry pointing at the AppImage (not at the transient mount). */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const li = require("../main/loginitem");

test("a development build is never registered, and says so", () => {
  const r = li.apply({ isPackaged: false, setLoginItemSettings() { throw new Error("must not be called"); } }, true);
  assert.equal(r.ok, false); assert.match(r.note, /development/);
});

test("mac/win hand the flag to the OS login items, both ways", () => {
  if (process.platform === "linux") return;
  const calls = [];
  const app = { isPackaged: true, setLoginItemSettings: (o) => calls.push(o) };
  assert.deepEqual(li.apply(app, true), { ok: true, on: true });
  assert.deepEqual(li.apply(app, false), { ok: true, on: false });
  assert.deepEqual(calls, [{ openAtLogin: true }, { openAtLogin: false }]);
});

test("an OS refusal is reported, not thrown", () => {
  if (process.platform === "linux") return;
  const app = { isPackaged: true, setLoginItemSettings() { throw new Error("denied"); } };
  const r = li.apply(app, true);
  assert.equal(r.ok, false); assert.equal(r.note, "denied");
});

test("linux writes and removes an autostart entry that execs the AppImage", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcd-autostart-"));
  const oldXdg = process.env.XDG_CONFIG_HOME, oldImg = process.env.APPIMAGE;
  process.env.XDG_CONFIG_HOME = tmp; process.env.APPIMAGE = "/home/u/Apps/minimaCore-0.17.26-x64.AppImage";
  try {
    const p = li.linuxAutostartPath();
    assert.equal(p, path.join(tmp, "autostart", "minimacore.desktop"));
    const entry = li.linuxDesktopEntry(process.env.APPIMAGE);
    assert.match(entry, /^\[Desktop Entry\]\n/); assert.match(entry, /\nType=Application\n/);
    assert.match(entry, /\nExec=\/home\/u\/Apps\/minimaCore-0\.17\.26-x64\.AppImage\n/, "Exec is the AppImage itself");
    assert.match(entry, /\nName=minimaCore\n/);
    if (process.platform === "linux") {
      const app = { isPackaged: true };
      assert.deepEqual(li.apply(app, true), { ok: true, on: true });
      assert.equal(fs.readFileSync(p, "utf8"), entry);
      assert.deepEqual(li.apply(app, false), { ok: true, on: false });
      assert.ok(!fs.existsSync(p), "removed when switched off");
      assert.deepEqual(li.apply(app, false), { ok: true, on: false }, "switching off twice is fine");
    }
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldImg === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = oldImg;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
