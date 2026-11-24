"use strict";
// An older copy of the app refuses a data folder a newer copy wrote (0.19.423).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const W = require("../main/writermark");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wm-"));

test("the mark: raised, never lowered; an older copy is refused with both versions and its own path; no mark is accepted", () => {
  const d = tmp();
  assert.equal(W.problem(d, "0.19.105", "Pandamonium Desktop", "/x/App"), "");          // a folder from before the mark
  W.mark(d, "0.19.423"); assert.equal(W.read(d), "0.19.423");
  W.mark(d, "0.19.105"); assert.equal(W.read(d), "0.19.423");                            // never lowered
  const why = W.problem(d, "0.19.105", "Pandamonium Desktop", "/Volumes/old/Pandamonium Desktop.app/Contents/MacOS/x");
  assert.match(why, /last used by Pandamonium Desktop 0\.19\.423\. This copy is 0\.19\.105, which is older/);
  assert.match(why, /The node was not started and nothing was changed/);
  assert.match(why, /This copy is at \/Volumes\/old\/Pandamonium Desktop\.app\/Contents\/MacOS\/x$/);
  assert.equal(W.problem(d, "0.19.423", "P", ""), ""); assert.equal(W.problem(d, "0.20.0", "P", ""), "");
  W.mark(d, "0.20.0"); assert.equal(W.read(d), "0.20.0");
  assert.equal(W.cmp("0.19.99", "0.19.100"), -1);                                        // numbers, not text
  fs.writeFileSync(path.join(d, W.FILE), "garbage\n"); assert.equal(W.problem(d, "0.1.0", "P", ""), "");   // unreadable = no mark
});

// 0.19.438 (independent review of 0.19.428, MINOR 12)
test("versions are compared within one app only; an old mark (no app named) is still read; older builds still read the file; the way back names the file whole", () => {
  const A = "com.eurobuddha.pandamonium.desktop", B = "com.eurobuddha.minimacore", d = tmp(), file = path.join(d, W.FILE);
  // two apps of the family on one custom data folder: unrelated version tracks (0.19.x and 0.18.x)
  W.mark(d, "0.19.438", A);
  assert.equal(W.problem(d, "0.18.330", "minimaCore", "/x", B), "", "the other app's higher number is not a reason to refuse this one (it was: one line, compared with everyone)");
  W.mark(d, "0.18.330", B);
  assert.equal(fs.readFileSync(file, "utf8"), "app 0.19.438\napp 0.18.330 " + B + "\napp 0.19.438 " + A + "\n");
  assert.equal(W.read(d, A), "0.19.438"); assert.equal(W.read(d, B), "0.18.330");
  assert.match(W.problem(d, "0.18.329", "minimaCore", "", B), /last used by minimaCore 0\.18\.330\. This copy is 0\.18\.329, which is older/, "within one app an older copy is still refused");
  assert.equal(W.problem(d, "0.18.331", "minimaCore", "", B), ""); assert.equal(W.problem(d, "0.19.438", "P", "", A), "");
  W.mark(d, "0.18.329", B); assert.equal(W.read(d, B), "0.18.330", "never lowered");
  // a build of 0.19.423 to 0.19.437 reads the file with its own pattern (the first "app <version>" line alone on a line): it still refuses
  const oldRead = (dir) => { const m = /^app (\S+)$/m.exec(fs.readFileSync(path.join(dir, W.FILE), "utf8")); return m ? m[1] : ""; };
  assert.equal(oldRead(d), "0.19.438");
  // an old mark names no app: still readable, and compared (it cannot be told whose it is)
  const e = tmp(); fs.writeFileSync(path.join(e, W.FILE), "app 0.19.430\n");
  assert.equal(W.read(e, A), "0.19.430"); assert.match(W.problem(e, "0.19.429", "Pandamonium Desktop", "", A), /last used by Pandamonium Desktop 0\.19\.430/);
  W.mark(e, "0.19.438", A); assert.equal(fs.readFileSync(path.join(e, W.FILE), "utf8"), "app 0.19.438\napp 0.19.438 " + A + "\n");
  // the way back, for a deliberate return to an older version: the exact file, whole, in the message; deleting it is all it takes
  const why = W.problem(d, "0.19.105", "Pandamonium Desktop", "/Volumes/old/x", A);
  assert.ok(why.includes("To go back to this older version on purpose, quit the app, delete the file " + file + " and open this copy again. This copy is at /Volumes/old/x"), why);
  fs.unlinkSync(file); assert.equal(W.problem(d, "0.19.105", "Pandamonium Desktop", "/Volumes/old/x", A), "");
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "node-manager.js"), "utf8");
  assert.ok(/writermark\.problem\(this\.dataDir\(\), APPVER, APPNAME, process\.execPath, flavor\.appId\)/.test(src) && /writermark\.mark\(this\.dataDir\(\), APPVER, flavor\.appId\)/.test(src), "the node manager names the app");
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8").includes("minimacore-writer.txt"), "the way back is in the README");
});

test("the node manager asks before it starts java, and marks the folder", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "node-manager.js"), "utf8");
  const i = src.indexOf("writermark.problem("), j = src.indexOf("writermark.mark("), k = src.indexOf("this.spawnFn(");
  assert.ok(i > 0 && j > i && k > j, "the check, then the mark, then the spawn");
});
