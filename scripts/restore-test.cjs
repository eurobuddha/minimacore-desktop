// Restoring ANOTHER wallet into this node (main/restore.js): the key-mode check on a backup file, the command,
// and (0.18.96+) the work in flight. Nothing here talks to a node: the node is a function that records.
"use strict";
const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm"), Module = require("module");
const restore = require("../main/restore.js");
const ROOT = path.join(__dirname, "..");
// The checks of mcd:cmd live in main/seedgate.js checkCommand since 0.19.327 (the released 0.18.201); main.js's handler calls it first.
const CHECKS = () => { const g = fs.readFileSync(path.join(ROOT, "main", "seedgate.js"), "utf8"), a = g.indexOf("async function checkCommand("); return g.slice(a, g.indexOf("\n}\n", a)); };
const CALLS_CHECKS = "await seedgate.checkCommand(command, { take: secretGate.take, running: requireRunning, walletWork, keyMode: () => config.load().keyMode,";   // 0.19.329: and tip

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
const quiet = { atomix: { ready: true, swaps: [], maker: false, otcOffer: false, otcDeals: 0 }, pools: [] };

test("M1: replacing the wallet is refused while work that needs its keys is open, and each piece is named in full", async () => {
  assert.deepEqual(restore.activeWorkList(quiet), []);
  assert.equal(restore.activeWorkProblem([]), "");
  assert.deepEqual(restore.activeWorkList({ atomix: { ready: false, hasStore: false }, pools: [] }), [], "a new install: AtomiX has no store yet, nothing to lose");
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
  // changed on purpose (0.19.327): the checks are read in seedgate.js checkCommand, in the same order, and main calls it before the node
  const chk = CHECKS(), order = ["io.running()", "R.loadsBackupFile(command)", "R.replacesWalletFromPhrase(command)", "R.activeWorkProblem(await io.walletWork())"].map(x => chk.indexOf(x));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), "refusals in order: " + order);
  assert.ok(cmd.indexOf(CALLS_CHECKS) > 0 && cmd.indexOf(CALLS_CHECKS) < cmd.indexOf("seedgate.scrubReply(await run(pinned), command)"), "every check before the node gets anything");
  assert.ok(/const walletWork = async \(skipDexicon = Date\.now\(\) < dexSkipUntil\) => restore\.activeWorkList\(\{ atomix: await atomix\.activeWork\(\)\.catch\(\(\) => null\), pools: await pandapools\.activeWork\(\)\.catch\(\(\) => null\),/.test(main), "asked of the existing read models; a failed read is null, which refuses");
  assert.ok(/work: walletWork \}\);/.test(main), "and the backup-file restore asks the same");
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
  const ax = read("atomix.js"), inv = ax.slice(ax.indexOf("function invalidate()"), ax.indexOf("\n}\n", ax.indexOf("function invalidate()")));
  // CHANGED on purpose (0.19.243): the move is moveStoreAside() (a failed one is owed: init throws until it is done)
  const mv = ax.slice(ax.indexOf("function moveStoreAside()"), ax.indexOf("\n}\n", ax.indexOf("function moveStoreAside()")));
  assert.ok(inv.includes("moveStoreAside();") && mv.includes('const file = path.join(dir(), "atomix.sqlite")') && mv.includes('require("./restore").moveAside(file)') && !/unlink|rmSync/.test(inv + mv), "atomix.invalidate moves the swap database aside");
  for (const f of ["atomix.js", "pandapools.js", "mail.js", "mail-store.js"]) assert.ok(!/(unlink|rm)(Sync)?\([^)]*(sqlite|mail\.json)/.test(read(f)), f + " deletes no store");
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
  assert.deepEqual(w, { ready: true, swaps: [HASH, "0x03"], nearestMs: (secs + 3600) * 1000, nearestApprox: false, maker: false, otcOffer: false, otcDeals: 0 }, "unfinished, and an error still inside its timelock; finished and long-dead rows do not block");
  w = await atomix._activeWorkFrom(A({ maker: { currentOrder: () => ({ pairs: { USDT: { en: true, bids: [{ p: 1, a: 1 }], asks: [] } } }) },
    otc: { allDeals: (cb) => cb(null, [{ status: "AGREED" }, { status: "COMPLETE" }, { status: "EXPIRED" }]), myOffer: () => ({ enable: true }) } }), 100, now);
  assert.ok(w.maker && w.otcOffer && w.otcDeals === 1);
  w = await atomix._activeWorkFrom(A({ maker: { currentOrder: () => ({ pairs: { USDT: { en: false, bids: [], asks: [] } } }) } }), 100, now);
  assert.equal(w.maker, false, "a withdrawn order is not a live one");
  await assert.rejects(atomix._activeWorkFrom(A({ swapdb: { allSwaps: (cb) => cb(new Error("db closed")) } }), 100, now), /db closed/, "an unreadable swap list is an error, which main.js turns into a refusal");
});

// ---- 0.18.97: M2 and the low findings ----
test("lows: a semicolon in a restore value is refused in plain words; a resync and a bad backup password are recognised in the main process", () => {
  assert.ok(/semicolon \(;\), which the node reads as the end of the command\. Rename the file/.test(restore.restoreFileCommand({ host: H, file: "my;backup.bak" }).error));
  assert.ok(/semicolon \(;\).*cannot pass it/.test(restore.restoreFileCommand({ host: H, file: "a.bak", password: "pw;1" }).error));
  assert.ok(restore.restoreFileCommand({ host: H, file: "a.bak", password: "pw1" }).cmd);
  for (const c of ["megammrsync action:resync host:h:1", 'megammrsync action:resync host:h:1 phrase:"x" keyuses:1', "megammrsync host:h:1 action:resync", "status;megammrsync action:resync host:h:1"]) assert.equal(restore.isResync(c), true, c);
  for (const c of ["megammrsync action:mydetails", "megammrsync action:proofs address:0x00", "megammrsync action:resyncx", "status", "", null]) assert.equal(restore.isResync(c), false, String(c));
  for (const c of ['backup password:"abc123"', "backup password:abc123", "backup", "backup password:abc confirm:abc file:x.bak", "status", "send address:0x00 amount:1"]) assert.equal(restore.backupCommandProblem(c), "", c);
  for (const c of ['backup password:"a"b"', 'backup password:"a b"', "backup password:a;b", 'backup password:"pä55"', "backup password:", 'backup password:"abc" confirm:"ab c"', " Backup password:a-b"])
    assert.ok(/letters and numbers only/.test(restore.backupCommandProblem(c)), c);
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), cmd = main.slice(main.indexOf('"mcd:cmd"'), main.indexOf('"mcd:clip"'));
  assert.ok(CHECKS().includes("const bad = R.backupCommandProblem(command);\n  if (bad) throw new Error(bad);") && cmd.indexOf(CALLS_CHECKS) > 0 && cmd.indexOf(CALLS_CHECKS) < cmd.indexOf("seedgate.scrubReply(await run(pinned), command)"));   // in checkCommand since 0.19.327 (changed on purpose)
});

// ---- 0.19.193: the command channel's restore checks read a command as the node does (main/cmdverb.js) ----
test("restore, restoresync, megammrsync file: / phrase: / action:resync and backup passwords are seen quoted, control-character led and ':'-spaced", () => {
  for (const c of ['"restore" file:x', "\u0001restore file:x", 're"st"ore file:x', '"restoresync" file:x', "status;\u0002restore file:x",
    '"megammrsync" action:resync file:x', "megammrsync action:resync file : x", 'megammrsync action:resync "file":x', '"megammrsync"file:x'])
    assert.equal(restore.loadsBackupFile(c), true, JSON.stringify(c));
  for (const c of ['"megammrsync" action:resync phrase:"a b"', "\u0001megammrsync action:resync phrase:x", "megammrsync action:resync phrase : x", 'megammrsync "phrase":x'])
    assert.equal(restore.replacesWalletFromPhrase(c), true, JSON.stringify(c));
  for (const c of ['"megammrsync" action:resync', "megammrsync action : resync", 'megammrsync "action":"resync"', "status;\u0001megammrsync action:resync"])
    assert.equal(restore.isResync(c), true, JSON.stringify(c));
  for (const c of ["megammrsync action:list", "status", "backup password:abc", "restorex file:x"]) { assert.equal(restore.loadsBackupFile(c), false, c); assert.equal(restore.isResync(c), false, c); }
  for (const c of ['"backup" password:"a b"', '"backup" password : a"b', 'backup "password":a$b', "\u0001backup password:a.b", 'backup confirm : "x y"', '"backup"password:abc;status'])
    assert.equal(restore.backupCommandProblem(c), "A backup password can hold letters and numbers only.", JSON.stringify(c));
  for (const c of ["backup password:abc123", 'backup password:"abc123"', '"backup" password : abc', "backup", "status;backup password:abc"]) assert.equal(restore.backupCommandProblem(c), "", JSON.stringify(c));
});

// ---- 0.19.218: every other command that replaces the keys or loads a backup is refused on the command channel ----
test("archive / mysql with phrase:, reset seedsync / restore, vault action:resetkeys: refused however spelled; their plain chain forms are not", () => {
  for (const c of ['archive action:resync host:h:9001 phrase:"a b c" keyuses:10', 'archive action:import file:x.raw.dat phrase:"a b"', 'archive action:importold file:x phrase:"a"', '"archive" action:resync "phrase":"a"',
    "\u0001archive action:resync phrase:a", 'archive action : resync phrase : "a"', 'ar"chi"ve action:import file:x phrase:a', 'mysql action:resync phrase:"a b" keys:90', '"mysql"action:resync phrase:a',
    'reset archivefile:x.gz action:seedsync keyuses:1000 phrase:"a b"', "reset action:restore file:b.bak password:x", 'reset action : restore file:b.bak', '"reset" action:seedsync archivefile:x',
    "vault action:resetkeys phrase:a", 'vault action : resetkeys phrase:"a b"', '"vault"action:resetkeys', "status;archive action:resync phrase:a"])
    assert.equal(restore.replacesKeysElsewhere(c), true, JSON.stringify(c));
  for (const c of ["archive action:resync host:h:9001", "archive action:export", "archive action:inspect file:x", "mysql action:info", "reset action:chainsync archivefile:x", "vault", "vault action:seed",
    "megammrsync action:resync phrase:a", "status", 'send amount:1 address:0xA state:{"phrase":"x"}'])
    assert.equal(restore.replacesKeysElsewhere(c), false, JSON.stringify(c));
  // 0.19.281: a value the node pastes, unquoted, into the archive / mysql command it runs itself becomes its parameters
  for (const c of ['reset action:chainsync archivefile:"/Users/me/archive.gz phrase:abc anyphrase:true" keys:[1]', 'archive action:import file:/Users/me/archive.gz keys:"64 phrase:abc anyphrase:true" address:{}',
    'reset action:chainsync archivefile:"C:\\x.gz phrase:abc anyphrase:true"', 'reset action:chainsync archivefile:"x.gz phrase:abc"', 'archive action:importraw file:x keyuses:"5 phrase:a"', 'archive action:importold file:x anyphrase:"true phrase:a"',
    'mysql action:reset file:"x phrase:a"', 'txpow txpowid:"0x01 action:resync phrase:abc"', 'archive action:import file:"/Users/me/My Archive.gz"'])
    assert.equal(restore.replacesKeysElsewhere(c), true, JSON.stringify(c));
  for (const c of ["reset action:chainsync archivefile:/Users/me/archive.gz", "archive action:import file:/Users/me/archive.gz", "txpow txpowid:0x01", "mysql action:reset file:/x/y.dat", "archive action:resync host:h:9001",
    "reset action:chainsync archivefile:C:\\backup\\a.gz", "archive action:import file:D:\\minima\\archive.gz"])   // a Windows path (0.19.296)
    assert.equal(restore.replacesKeysElsewhere(c), false, JSON.stringify(c));
  const h = CHECKS();   // in seedgate.js checkCommand since 0.19.327 (changed on purpose)
  assert.ok(h.indexOf("R.replacesKeysElsewhere(command)") > 0 && h.indexOf("R.replacesKeysElsewhere(command)") < h.indexOf("refusal(command, io.take)"), "refused before the gate asks anything");
});

// ---- 0.19.419: P2P Chance is gone: nothing of it holds a restore, a Quit or a Shutdown ----
test("P2P Chance removed (0.19.419): main's walletWork and inFlightWork run with no casino module at all, and an old casino field is ignored", async () => {
  // main.js's own walletWork and inFlightWork, run over stand-in engines with NO `casino` in scope: on 0.19.418 they read
  // casino.open() / casino.looping(), and this throws "casino is not defined"
  const ts = require("typescript"), src = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), decl = {};
  const walk = (n) => { if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && /^(walletWork|inFlightWork|dexWork|fcWork)$/.test(d.name.text)) decl[d.name.text] = n.getText(sf); ts.forEachChild(n, walk); };
  walk(sf);
  const R = require("../main/restore.js"), I = require("../main/inflight.js");
  const env = { restore: R, megafile: { holdsEngines: () => false }, loopsPaused: () => false, dexSkipUntil: 0, config: { load: () => ({ casinoEnabled: true }) },
    atomix: { activeWork: async () => ({ ready: true, swaps: [] }) }, pandapools: { activeWork: async () => [], status: () => ({}), ownPools: async () => [] },
    shop: { sendingCount: () => 0 }, futurecash: { activeWork: () => ({ ready: true, posted: 0 }) }, dexicon: { activeWork: async () => ({ ready: true, orders: [], pending: 0, takes: 0, unknown: 0 }) } };
  const m = new Function("env", "with (env) { " + decl.walletWork + "; " + decl.dexWork + "; " + decl.fcWork + "; " + decl.inFlightWork + "; return { walletWork, inFlightWork }; }")(env);
  assert.deepEqual(await m.walletWork(), [], "a wallet whose old config still says casinoEnabled is not held up");
  const w = I.inFlight(await m.inFlightWork(), "quit", Date.now());
  assert.equal(w.any, false, w.message);
  // a caller that still passes the old fields gets nothing from them
  assert.deepEqual(R.activeWorkList({ atomix: { ready: true, swaps: [] }, pools: [], casino: { offers: 1, bets: 2 }, casinoLooping: true, casinoWaitedMs: 200000 }), []);
  assert.equal(I.inFlight({ atomix: { ready: true, swaps: [] }, pools: [], dexicon: { ready: true, orders: [], pending: 0, takes: 0, unknown: 0 }, casino: { offers: 1, bets: 2 }, casinoOn: true }, "quit", Date.now()).any, false);
  assert.ok(!/casino/.test(decl.walletWork + decl.inFlightWork), "neither reads a casino");
});

// ---- 0.19.417: main's own reads of an engine that main's own MegaMMR flow stopped (the import refused itself on 0.19.395-0.19.416) ----
test("main's walletWork and inFlightWork read Dexicon held by an import, and Future Cash Next paused by it, from what they had open when they stopped", async () => {
  const ts = require("typescript"), src = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8"), sf = ts.createSourceFile("main.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), decl = {};
  const walk = (n) => { if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && /^(walletWork|inFlightWork|dexWork|fcWork)$/.test(d.name.text)) decl[d.name.text] = n.getText(sf); ts.forEachChild(n, walk); };
  walk(sf);
  const R = require("../main/restore.js"), I = require("../main/inflight.js");
  const run = (byFlow, dxLast, fcLast) => new Function("env", "with (env) { " + [decl.walletWork, decl.dexWork, decl.fcWork, decl.inFlightWork].filter(Boolean).join(";\n") + "; return { walletWork, inFlightWork }; }")({
    restore: R, megafile: { holdsEngines: () => byFlow }, loopsPaused: () => byFlow, dexSkipUntil: 0, config: { load: () => ({}) },
    atomix: { activeWork: async () => ({ ready: true, swaps: [] }) }, pandapools: { activeWork: async () => [], status: () => ({}), ownPools: async () => [] }, shop: { sendingCount: () => 0 },
    dexicon: { activeWork: async () => Object.assign({ ready: false, hasStore: true, waitedMs: 0 }, dxLast ? { last: dxLast } : {}) },
    futurecash: { activeWork: () => Object.assign({ ready: false, hasStore: true, error: "" }, fcLast ? { last: fcLast } : {}) } });
  const nothing = { orders: [], pending: 0, takes: 0, unknown: 0 }, fcNothing = { collects: [], queued: [], sweeps: [], posted: 0 };
  let m = run(true, nothing, fcNothing);
  assert.deepEqual(await m.walletWork(), [], "the import's own hold: nothing open, nothing said");
  assert.equal(I.inFlight(await m.inFlightWork(), "shutdown", Date.now()).any, false, "and the stop guard asks nothing");
  m = run(true, Object.assign({}, nothing, { takes: 1 }), Object.assign({}, fcNothing, { sweeps: ["0x" + "5E".repeat(32)], posted: 1 }));
  assert.deepEqual(await m.walletWork(), ["1 Dexicon trade sent and not yet answered. Wait for it to settle (a few minutes).", "1 Future Cash Next collect or sweep is still under way, which only this wallet's keys can finish: 0x" + "5E".repeat(32)]);
  m = run(false, nothing, fcNothing);
  assert.deepEqual(await m.walletWork(), ["Dexicon has not finished starting, so its orders could not be checked. Wait a moment and try again.", "Future Cash Next has not started (or is frozen), so its collects and sweeps could not be checked. Start the node, unfreeze it on the Apps tab, and try again."], "stopped for another reason: as before");
  m = run(true, null, null);
  assert.equal((await m.walletWork()).length, 2, "never ran (nothing kept): as before, never read as idle");
});
