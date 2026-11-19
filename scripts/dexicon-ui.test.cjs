// Dexicon's screens (Phase 3b): the logic in renderer/dexicon-core.js, run here; nothing in this file reads source
// text to decide a result, except where a constant must equal a committed file.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const C = require("../renderer/dexicon-core.js");

test("rooms: three, in the phone's order; Exchange has the phone's six tabs", () => {
  assert.deepEqual(C.ROOMS.map(r => r.n + " " + r.label), ["① MxUSD", "② Pools", "③ Exchange"]);
  assert.deepEqual(C.ROOMS[2].tabs.map(t => C.TAB_LABEL[t]), ["Trade", "Orders", "History", "Activity", "Assets", "Settings"]);
  assert.deepEqual([C.ROOMS[0].view, C.ROOMS[1].view], ["atomix", "pandapools"], "rooms 1 and 2 are the existing panels until 3c / 3d");
  assert.deepEqual([C.ROOMS[0].tabs, C.ROOMS[1].tabs], [[], []], "and get no Dexicon tab that would do nothing");
});

test("each room remembers its last tab; Dexicon opens on room 1; the theme is remembered", () => {
  let mem = C.load(null);
  assert.equal(mem.room, 0); assert.equal(mem.theme, "ONYX"); assert.equal(mem.tabs.exchange, "trade");
  C.pickRoom(mem, 2); C.pickTab(mem, "history");
  assert.equal(C.tabOf(mem), "history");
  C.pickRoom(mem, 1); assert.equal(C.tabOf(mem), "", "Pools has no Dexicon tab yet");
  C.pickTab(mem, "orders"); assert.equal(mem.tabs.exchange, "history", "a tab of another room changes nothing");
  C.pickRoom(mem, 2); assert.equal(C.tabOf(mem), "history", "back in Exchange: the tab it was left on");
  C.toggleTheme(mem);
  const again = C.load(C.save(mem));
  assert.equal(again.room, 0, "a new start opens on room 1");
  assert.equal(again.tabs.exchange, "history"); assert.equal(again.theme, "DAYLIGHT");
  assert.equal(C.toggleTheme(again).theme, "ONYX");
  for (const junk of ["", "{", "null", '{"tabs":{"exchange":"nope"},"theme":7}', '{"tabs":"x"}']) {
    const m = C.load(junk); assert.equal(m.tabs.exchange, "trade", "junk: " + junk); assert.equal(m.theme, "ONYX");
  }
  C.pickRoom(mem, 9); assert.equal(mem.room, 2, "a room that does not exist is ignored");
});

test("every Dexicon room is a view the shell knows", () => {
  for (const v of ["atomix", "pandapools", "dexicon"]) assert.ok(C.roomOfView(v) >= 0, v + " is a Dexicon room");
  assert.equal(C.roomOfView("balances"), -1);   // full screen vs shell: scripts/shell-test.cjs runs the shell's own shellMode
});

test("the status strip says what is true: node, then engine", () => {
  assert.deepEqual(C.strip("stopped", null), { text: "NODE STOPPED", tone: "dim" });
  assert.deepEqual(C.strip("starting", null), { text: "NODE STARTING…", tone: "dim" });
  assert.equal(C.strip("running", null).text, "PAIRED · starting Dexicon");
  assert.equal(C.strip("running", { started: true, ready: false }).text, "PAIRED · starting Dexicon");
  assert.equal(C.strip("running", { started: true, ready: true, restingReady: false }).text, "PAIRED · reading the chain");
  assert.deepEqual(C.strip("running", { started: true, ready: true, restingReady: true }), { text: "PAIRED", tone: "ok" });
});

test("the version pill is the vendored engine's version", () => {
  require("./dexicon-mock.cjs");   // main/rpc.js and main/netfetch.js replaced by versions that throw
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "dexicon-parity.manifest.json"), "utf8"));
  const dexicon = require("../main/dexicon.js");
  assert.equal(dexicon.ENGINE_VERSION, manifest.donor.mdsVersion);
  assert.equal(dexicon.makeHost({ quiet: true, dataDir: "/nonexistent" }).status().version, manifest.donor.mdsVersion);
});
