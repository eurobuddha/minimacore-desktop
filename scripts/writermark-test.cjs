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

test("the node manager asks before it starts java, and marks the folder", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main", "node-manager.js"), "utf8");
  const i = src.indexOf("writermark.problem("), j = src.indexOf("writermark.mark("), k = src.indexOf("this.spawnFn(");
  assert.ok(i > 0 && j > i && k > j, "the check, then the mark, then the spawn");
});
