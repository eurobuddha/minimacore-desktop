// Restoring ANOTHER wallet into this node (main/restore.js): the key-mode check on a backup file, the command,
// and (0.18.96+) the work in flight. Nothing here talks to a node: the node is a function that records.
"use strict";
const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm"), Module = require("module");
const restore = require("../main/restore.js");
const ROOT = path.join(__dirname, "..");

const H = "megammr.example:9001";
function deps(over) { const sent = []; return Object.assign({ keyMode: "classic", supported: false, running: true, sent, work: async () => [], run: async (c) => { sent.push(c); return { status: true, response: {} }; } }, over); }

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

// ---- 0.18.96: M1, work in flight and the stores of the old wallet ----
const HASH = "0x" + "AB12".repeat(16), TXP = "0x" + "00CD".repeat(16);
const quiet = { atomix: { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 }, pools: [], casino: null };

test("M1: replacing the wallet is refused while work that needs its keys is open, and each piece is named in full", async () => {
  assert.deepEqual(restore.activeWorkList(quiet), []);
  assert.equal(restore.activeWorkProblem([]), "");
  assert.deepEqual(restore.activeWorkList({ atomix: { ready: false, hasStore: false }, pools: [], casino: null }), [], "a new install: AtomiX has no store yet, nothing to lose");
  const one = (r) => { const l = restore.activeWorkList(Object.assign({}, quiet, r)); assert.equal(l.length, 1, JSON.stringify(l)); return l[0]; };
  const swap = one({ atomix: Object.assign({}, quiet.atomix, { swaps: [HASH] }) });
  assert.ok(/^1 AtomiX swap still in flight/.test(swap) && swap.includes(HASH), "the whole hash, never shortened: " + swap);
  assert.ok(/maker order/.test(one({ atomix: Object.assign({}, quiet.atomix, { maker: true }) })));
  assert.ok(/OTC offer/.test(one({ atomix: Object.assign({}, quiet.atomix, { otcOffer: true }) })));
  assert.ok(/^2 AtomiX OTC deals still open/.test(one({ atomix: Object.assign({}, quiet.atomix, { otcDeals: 2 }) })));
  assert.ok(/could not be asked/.test(one({ atomix: null })), "AtomiX unreadable: refused, not assumed idle");
  assert.ok(/has not finished starting/.test(one({ atomix: { ready: false, hasStore: true } })));
  assert.ok(/PandaPools could not be asked/.test(one({ pools: null })));
  const pool = one({ pools: [{ type: "STATUS", summary: "x" }, { txpowid: TXP, confirmed: false }, { txpowid: "0x01", confirmed: true }, { txpowid: "0x02", confirmed: false, failed: true }] });
  assert.ok(/^1 PandaPools transaction still waiting to confirm/.test(pool) && pool.includes(TXP));
  assert.ok(/1 offer and 2 bets still open/.test(one({ casino: { offers: 1, bets: 2 } })));
  assert.deepEqual(restore.activeWorkList(Object.assign({}, quiet, { casino: { offers: 0, bets: 0 } })), []);
  const why = restore.activeWorkProblem([swap, pool]);
  assert.ok(/Nothing was changed/.test(why) && why.includes(HASH) && why.includes(TXP) && /neither claimed nor refunded/.test(why));
  // a backup-file restore: refused with the list, in the check and in the run, and the node is sent nothing
  for (const check of [true, false]) {
    const d = deps({ work: async () => [swap] });
    await assert.rejects(restore.restoreBackup({ host: H, file: "a.bak", mode: "classic", check }, d), (e) => e.message.includes(HASH));
    assert.deepEqual(d.sent, []);
  }
});

test("M1: a seed restore on the general command channel is recognised, and main.js checks before the node gets it", () => {
  for (const c of ['megammrsync action:resync host:h:1 phrase:"A B" anyphrase:true keyuses:5', ' MegaMMRsync action:resync host:h:1 Phrase:"x"', 'status;megammrsync action:resync host:h:1 phrase:"x"'])
    assert.equal(restore.replacesWalletFromPhrase(c), true, c);
  for (const c of ["megammrsync action:resync host:h:1", "megammrsync action:mydetails", 'send address:0x00 amount:1 state:{"1":"phrase:x"}', "", null]) assert.equal(restore.replacesWalletFromPhrase(c), false, String(c));
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), cmd = main.slice(main.indexOf('"mcd:cmd"'), main.indexOf('"mcd:clip"'));
  const order = ["requireRunning()", "restore.loadsBackupFile(command)", "restore.replacesWalletFromPhrase(command)", "restore.activeWorkProblem(await walletWork())", "return run(pinned)"].map(x => cmd.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "refusals first, the node last: " + order);
  assert.ok(/const walletWork = async \(\) => restore\.activeWorkList\(\{ atomix: await atomix\.activeWork\(\)\.catch\(\(\) => null\), pools: await pandapools\.activity\(\)\.catch\(\(\) => null\),/.test(main), "asked of the existing read models; a failed read is null, which refuses");
  assert.ok(/work: walletWork \}\)\);/.test(main), "and the backup-file restore asks the same");
});

test("M1: a store of the old wallet is moved aside under a dated name, never deleted and never overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-test-")), f = path.join(dir, "atomix.sqlite"), day = new Date(2026, 10, 19, 12);
  assert.equal(restore.moveAside(f, day), "", "nothing there: nothing to do");
  fs.writeFileSync(f, "swap rows and preimages");
  const kept = restore.moveAside(f, day);
  assert.equal(kept, f + "-legacy-keys-20261119");
  assert.equal(fs.existsSync(f), false); assert.equal(fs.readFileSync(kept, "utf8"), "swap rows and preimages");
  fs.writeFileSync(f, "second wallet");
  assert.equal(restore.moveAside(f, day), f + "-legacy-keys-20261119-2", "a second one on the same day does not replace the first");
  fs.writeFileSync(f, "third");
  assert.equal(restore.moveAside(f, day), f + "-legacy-keys-20261119-3");
  assert.equal(fs.readFileSync(kept, "utf8"), "swap rows and preimages");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["atomix.sqlite-legacy-keys-20261119", "atomix.sqlite-legacy-keys-20261119-2", "atomix.sqlite-legacy-keys-20261119-3"]);
});

test("M1: the reset chain deletes no store: AtomiX's database and the mail store are set aside, the pools database is kept", () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, "main", f), "utf8");
  const ax = read("atomix.js"), inv = ax.slice(ax.indexOf("function invalidate()"), ax.indexOf("startLoop();\n}", ax.indexOf("function invalidate()")));
  assert.ok(inv.includes('require("./restore").moveAside(path.join(dir(), "atomix.sqlite"))') && !/unlink|rmSync/.test(inv), "atomix.invalidate moves the swap database aside");
  for (const f of ["atomix.js", "pandapools.js", "mail.js", "mail-store.js", "casino.js"]) assert.ok(!/(unlink|rm)(Sync)?\([^)]*(sqlite|mail\.json)/.test(read(f)), f + " deletes no store");
  const pp = read("pandapools.js"), ppInv = pp.slice(pp.indexOf("async function invalidate()"), pp.indexOf("// ---- helpers ----"));
  assert.ok(!/unlink|rename|rmSync/.test(ppInv), "pandapools.invalidate leaves pandapools.sqlite where it is");
  assert.ok(/function invalidateIdentity\(\) \{[\s\S]*?store\.setAside\(\)/.test(read("mail.js")));
  // the mail store, run for real behind a stand-in for electron
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "restore-mail-")), realLoad = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? { app: { getPath: () => userData } } : realLoad.call(this, request, ...rest); };
  try {
    const store = require("../main/mail-store.js");
    assert.equal(store.setAside(), "", "an empty store: nothing to keep");
    store.addContact("MAILPUBLICID", "a friend"); store.metaSet("coinnotify", true);
    const kept = store.setAside();
    assert.ok(/mail\.json-legacy-keys-\d{8}$/.test(kept), kept);
    const old = JSON.parse(fs.readFileSync(kept, "utf8"));
    assert.equal(old.contacts.MAILPUBLICID.username, "a friend", "what was in memory, written out before the move");
    assert.deepEqual(store.exportAll(), { messages: {}, contacts: {}, meta: {} }, "and the app starts empty for the new wallet");
  } finally { Module._load = realLoad; }
});

test("M1: AtomiX's own read models say what is in flight (the engine's real swap rules, a stand-in for its database)", async () => {
  const box = { AX: {} }; box.globalThis = box; vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "main", "atomix", "lib", "trading.js"), "utf8"), box);
  const trading = box.AX.trading; assert.equal(typeof trading.isTerminalSwap, "function");
  const atomix = require("../main/atomix.js");
  const now = Date.now(), secs = Math.floor(now / 1000);
  const rows = [{ hash: HASH, status: "STARTED", myTimelock: secs + 3600 }, { hash: "0x01", status: "COMPLETE" }, { hash: "0x02", status: "REFUNDED" },
    { hash: "0x03", status: "ERROR", myTimelock: secs + 3600 }, { hash: "0x04", status: "ERROR", myTimelock: secs - 30 * 86400 }];
  const A = (o) => Object.assign({ trading, swapdb: { allSwaps: (cb) => cb(null, rows) }, maker: { currentOrder: () => null },
    otc: { allDeals: (cb) => cb(null, []), myOffer: () => ({ enable: false }) } }, o);
  let w = await atomix._activeWorkFrom(A(), 100, now);
  assert.deepEqual(w, { ready: true, swaps: [HASH, "0x03"], maker: false, otcOffer: false, otcDeals: 0 }, "unfinished, and an error still inside its timelock; finished and long-dead rows do not block");
  w = await atomix._activeWorkFrom(A({ maker: { currentOrder: () => ({ pairs: { USDT: { en: true, bids: [{ p: 1, a: 1 }], asks: [] } } }) },
    otc: { allDeals: (cb) => cb(null, [{ status: "AGREED" }, { status: "COMPLETE" }, { status: "EXPIRED" }]), myOffer: () => ({ enable: true }) } }), 100, now);
  assert.ok(w.maker && w.otcOffer && w.otcDeals === 1);
  w = await atomix._activeWorkFrom(A({ maker: { currentOrder: () => ({ pairs: { USDT: { en: false, bids: [], asks: [] } } }) } }), 100, now);
  assert.equal(w.maker, false, "a withdrawn order is not a live one");
  await assert.rejects(atomix._activeWorkFrom(A({ swapdb: { allSwaps: (cb) => cb(new Error("db closed")) } }), 100, now), /db closed/, "an unreadable swap list is an error, which main.js turns into a refusal");
});
