// Restoring ANOTHER wallet into this node (main/restore.js): the key-mode check on a backup file, the command,
// and (0.18.96+) the work in flight. Nothing here talks to a node: the node is a function that records.
"use strict";
const test = require("node:test"), assert = require("node:assert");
const restore = require("../main/restore.js");

const H = "megammr.example:9001";
function deps(over) { const sent = []; return Object.assign({ keyMode: "classic", supported: false, running: true, sent, run: async (c) => { sent.push(c); return { status: true, response: {} }; } }, over); }

test("H3: a backup of the other key mode is refused before any command exists, in plain words", async () => {
  // today's desktop: classic only. A block backup from a Pandamonium phone is the forbidden mix.
  let d = deps();
  await assert.rejects(restore.restoreBackup({ host: H, file: "phone.bak", password: "pw1", mode: "block" }, d), (e) => /runs classic keys only/.test(e.message) && /Nothing was changed/.test(e.message) && /What you can do/.test(e.message) && /send its funds/.test(e.message));
  await assert.rejects(restore.restoreBackup({ host: H, file: "phone.bak", mode: "block", check: true }, d), /runs classic keys only/, "the check alone refuses too");
  assert.deepEqual(d.sent, []);
  // a capable node, a classic install: still refused; and the other way round
  d = deps({ supported: true });
  await assert.rejects(restore.restoreBackup({ host: H, file: "a.bak", mode: "block" }, d), /holds a classic key wallet, and that cannot be changed/);
  d = deps({ supported: true, keyMode: "block" });
  await assert.rejects(restore.restoreBackup({ host: H, file: "a.bak", mode: "classic" }, d), /holds a block key wallet, and that cannot be changed/);
  // no answer, or a made-up one: refused
  for (const mode of [undefined, "", "fast", null]) await assert.rejects(restore.restoreBackup({ host: H, file: "a.bak", mode }, deps()), /Choose which kind of wallet made this backup/);
  await assert.rejects(restore.restoreBackup({ host: H, file: "a.bak", mode: "classic" }, deps({ keyMode: "" })), /No wallet has been set up yet/);
  assert.deepEqual(d.sent, []);
});

test("H3: a backup of the install's own mode is restored with the 0.18.84 command, and the check sends nothing", async () => {
  for (const [keyMode, supported] of [["classic", false], ["classic", true], ["block", true]]) {
    const d = deps({ keyMode, supported });
    assert.deepEqual(await restore.restoreBackup({ host: H, file: "old.bak", password: "pw1", mode: keyMode, check: true }, d), { ok: true });
    assert.deepEqual(d.sent, []);
    await restore.restoreBackup({ host: " " + H + " ", file: "old.bak", password: "pw1", mode: keyMode }, d);
    assert.deepEqual(d.sent, [`megammrsync action:resync host:${H} file:old.bak password:pw1`]);
  }
  await assert.rejects(restore.restoreBackup({ host: H, file: "a.bak", mode: "classic" }, deps({ running: false })), /node is not running/);
  await assert.rejects(restore.restoreBackup({ host: H, file: "my file.bak", mode: "classic" }, deps()), /spaces or quotes/);
});

test("H3: the general command channel can tell a backup-file restore from everything else", () => {
  for (const c of ["restore file:a.bak password:x", "restoresync file:a.bak", "megammrsync action:resync host:h:1 file:a.bak", " Restore file:a.bak", "status;restore file:a.bak", "MEGAMMRSYNC action:resync host:h:1 FILE:a.bak"])
    assert.equal(restore.loadsBackupFile(c), true, c);
  for (const c of ["megammrsync action:resync host:h:1", 'megammrsync action:resync host:h:1 phrase:"x y" keyuses:5', "backup password:abc", "status", "send address:0x00 amount:1", "megammrsync action:mydetails", "", null])
    assert.equal(restore.loadsBackupFile(c), false, String(c));
});
