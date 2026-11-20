/*
 * flavor-test.cjs — the two apps this source tree builds never share anything that is kept by identity
 * (main/flavor.js, scripts/build-flavor.cjs). No app is started, no node, no keychain, no socket: electron is a
 * stand-in, `security` is never run (config.rpcSecret is not called), and the OS questions node-manager asks about
 * other processes are answered by stand-ins.
 */
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), os = require("os"), path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, ".."), PKG = require("../package.json");
const APPDATA = "/Users/x/Library/Application Support", REAL = APPDATA + "/minimaCore";
const flavor = require("../main/flavor.js");   // plain node: the released flavour, nothing applied

/**
 * The app's main-process modules as they load in a build of flavour `id` ("" = the released app): package.json as that
 * build packages it (extraMetadata), behind a stand-in electron. → { F, calls, load(name), restore }
 */
function build(id, o = {}) {
  const calls = { setName: [], setPath: [], exit: [], kill: [], login: [] }, userData = { dir: o.userData || path.join(o.appData || APPDATA, PKG.productName) };
  const app = { isPackaged: o.packaged !== false, getVersion: () => PKG.version, setName: (n) => calls.setName.push(n), getName: () => calls.setName.at(-1) || PKG.productName,
    getPath: (k) => (k === "appData" ? (o.appData || APPDATA) : k === "userData" ? userData.dir : os.tmpdir()), setPath: (k, v) => { calls.setPath.push([k, v]); if (k === "userData") userData.dir = v; },
    exit: (c) => { calls.exit.push(c); throw new Error("app.exit(" + c + ")"); }, setLoginItemSettings: (s) => calls.login.push(s) };
  const electron = { app, shell: { showItemInFolder() {} }, safeStorage: { isEncryptionAvailable: () => false } };
  const pkg = Object.assign({}, PKG, id ? { flavor: id, productName: PKG.flavors[id].productName } : {}, o.pkg || {});
  const realLoad = Module._load, env = process.env.MCD_TEST_PROFILE, argv = process.argv, realExit = process.exit;
  Module._load = function (request, parent, ...rest) {
    if (request === "electron") return electron;
    if (request === "../package.json" && parent && /main[\\/]flavor\.js$/.test(parent.filename)) return pkg;
    return realLoad.call(this, request, parent, ...rest);
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, "main") + path.sep)) delete require.cache[k];
  if (o.profile) process.env.MCD_TEST_PROFILE = o.profile; else delete process.env.MCD_TEST_PROFILE;
  process.argv = argv.slice(0, 2).concat(o.argv || []);
  process.exit = (c) => { throw new Error("process.exit(" + c + ")"); };
  const restore = () => { Module._load = realLoad; process.argv = argv; process.exit = realExit; if (env === undefined) delete process.env.MCD_TEST_PROFILE; else process.env.MCD_TEST_PROFILE = env;
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, "main") + path.sep)) delete require.cache[k]; };
  let F = null, error = null;
  try { F = require("../main/flavor.js"); } catch (e) { error = e; }
  return { F, error, calls, userData, load: (name) => require("../main/" + name), restore };
}

test("the released flavour is the released identity, name for name as in 0.18.69, and nothing is set for it", () => {
  assert.deepEqual(flavor.RELEASED, { id: "", productName: "minimaCore", appId: "com.eurobuddha.minimacore", userData: "minimaCore", keychainService: "com.eurobuddha.minimacore.rpc",
    basePort: 12001, updates: true, loginItem: true, windowTitle: "Minima Core", autostartFile: "minimacore.desktop", artifact: "minimaCore" });
  assert.equal(PKG.flavor, "", "the source tree names no flavour: a plain build is the released app");
  assert.equal(flavor.resolve(PKG), flavor.RELEASED); assert.equal(flavor.resolve({}), flavor.RELEASED);
  assert.equal(PKG.productName, "minimaCore"); assert.equal(PKG.build.appId, "com.eurobuddha.minimacore"); assert.equal(PKG.build.productName, "minimaCore");
  assert.deepEqual([PKG.parlonsNode, PKG.parlonsNodeSha256], ["0.2.152", "1b3a0dc7921675d54e96a611be5a37194116227c4529e32d8aeb74bb72ec1fd1"], "the released app's jar pin is untouched");
  assert.deepEqual(PKG.build.extraResources.slice(0, 2), [{ from: "resources/minima.jar", to: "minima.jar" }, { from: "resources/parlons-node.jar", to: "parlons-node.jar" }]);
  const b = build("");
  try {
    assert.deepEqual([b.calls.setName, b.calls.setPath, b.calls.exit], [[], [], []], "no name and no path is set: the released app is exactly as it was");
    assert.equal(b.F.keychainService, "com.eurobuddha.minimacore.rpc"); assert.equal(b.F.test, false);
    const cfg = b.load("config.js"), upd = b.load("updater.js");
    assert.equal(cfg.DEFAULTS.basePort, 12001); assert.equal(cfg.defaultDataFolder(), REAL + "/node-data");
    assert.equal(upd.OFF, false); assert.equal(upd.current().feed, "https://eurobuddha.com/pandaapps/minimacore-desktop.json");
    assert.equal(b.load("loginitem.js").linuxAutostartPath().endsWith("/autostart/minimacore.desktop"), true);
    assert.match(b.load("loginitem.js").linuxDesktopEntry("/x"), /^\[Desktop Entry\]\nType=Application\nName=minimaCore\nComment=Start the minimaCore node at login\nExec=\/x\n/);
    // a `--user-data-dir` on the released app is left as it always was (it is the released behaviour): nothing refused, nothing set
  } finally { b.restore(); }
  const moved = build("", { argv: ["--user-data-dir=/tmp/elsewhere"] });
  try { assert.equal(moved.error, null); assert.deepEqual(moved.calls.setPath, []); } finally { moved.restore(); }
});

test("the identity table: every identity-keyed name of Pandamonium Desktop differs from the released app's", () => {
  const P = flavor.resolve({ flavor: "pandamonium", flavors: PKG.flavors }), R = flavor.RELEASED;
  assert.deepEqual(P, { id: "pandamonium", productName: "Pandamonium Desktop", appId: "com.eurobuddha.pandamonium.desktop", userData: "PandamoniumDesktop",
    keychainService: "com.eurobuddha.pandamonium.desktop.rpc", basePort: 17001, updates: false, loginItem: false, windowTitle: "Pandamonium Desktop",
    autostartFile: "pandamonium-desktop.desktop", artifact: "PandamoniumDesktop" });
  for (const k of ["productName", "appId", "userData", "keychainService", "basePort", "windowTitle", "autostartFile", "artifact"]) assert.notEqual(String(P[k]).toLowerCase(), String(R[k]).toLowerCase(), k);
  assert.ok(!P.keychainService.startsWith(R.keychainService) && !R.keychainService.startsWith(P.keychainService), "neither keychain service is a prefix of the other");
  const b = build("pandamonium");
  try {
    assert.deepEqual(b.calls.setName, ["Pandamonium Desktop"], "the name is set before anything else (it names the Safe Storage keychain item)");
    assert.deepEqual(b.calls.setPath, [["userData", APPDATA + "/PandamoniumDesktop"]]);
    const cfg = b.load("config.js"), nm = b.load("node-manager.js");
    assert.equal(cfg.DEFAULTS.basePort, 17001); assert.equal(cfg.load().basePort, 17001);
    assert.equal(cfg.defaultDataFolder(), APPDATA + "/PandamoniumDesktop/node-data"); assert.equal(nm.pidfilePath(), APPDATA + "/PandamoniumDesktop/node.pid");
    assert.equal(b.load("loginitem.js").linuxAutostartPath().endsWith("/autostart/pandamonium-desktop.desktop"), true);
    // every file the app keeps is under its own folder: no module resolves a path under the released one
    for (const f of fs.readdirSync(path.join(ROOT, "main")).filter(n => n.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(ROOT, "main", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      if (f !== "flavor.js") assert.ok(!/["'`]minimaCore["'`]|com\.eurobuddha\.minimacore/.test(src), "main/" + f + " carries the released app's folder name or bundle id in code");
      assert.ok(!/getPath\(\s*["'](?!userData|downloads|appData)/.test(src), "main/" + f + " uses an Electron path other than userData, downloads and appData");
      assert.ok(!/setAsDefaultProtocolClient|setAppUserModelId|crashReporter\.start|keytar/.test(src), "main/" + f + ": an OS-level registration that would need a name of its own");
    }
    const cs = fs.readFileSync(path.join(ROOT, "main/config.js"), "utf8");
    assert.equal((cs.match(/"-s", KEYCHAIN_SERVICE/g) || []).length, 3, "the three `security` calls all name the flavour's service"); assert.match(cs, /const KEYCHAIN_SERVICE = flavor\.keychainService;/);
    const main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8");
    assert.ok(main.indexOf('require("./flavor")') > 0 && main.indexOf('require("./flavor")') < main.indexOf('require("electron")') && main.indexOf('require("./flavor")') < main.indexOf('require("./config")') && main.indexOf('require("./flavor")') < main.indexOf("requestSingleInstanceLock"),
      "the flavour is applied before electron is used, the config or the keychain is read, or the single-instance lock is taken");
    assert.ok(!fs.existsSync(path.join(ROOT, "main/testprofile.js")), "the ad-hoc TEST profile module is gone: one mechanism");
  } finally { b.restore(); }
});

test("userData can never resolve to, into or around the released app's folder; --user-data-dir is refused; a flavour that borrows a released name does not load", () => {
  const P = flavor.resolve({ flavor: "pandamonium", flavors: PKG.flavors }), R = flavor.RELEASED;
  assert.deepEqual(flavor.place(R, {}, [], APPDATA), { set: false, dir: "", name: "", keychainService: R.keychainService, test: false, error: "" });
  const ok = flavor.place(P, {}, ["/x/electron", "."], APPDATA);
  assert.deepEqual(ok, { set: true, dir: APPDATA + "/PandamoniumDesktop", name: "Pandamonium Desktop", keychainService: "com.eurobuddha.pandamonium.desktop.rpc", test: false, error: "" });
  assert.equal(flavor.overlaps(ok.dir, REAL), false);
  for (const argv of [["--user-data-dir=" + REAL], ["--user-data-dir", REAL], ["--user-data-dir=/tmp/x"]]) for (const env of [{}, { MCD_TEST_PROFILE: "/tmp/t" }]) for (const F of [P, R]) {
    if (!F.id && !env.MCD_TEST_PROFILE) continue;   // the released app with no profile: untouched (above)
    assert.match(flavor.place(F, env, argv, APPDATA).error, /^--user-data-dir is not accepted/, JSON.stringify([F.id, env, argv]));
  }
  // the released folder is derived from appData, never from userData: a userData already moved by a switch changes nothing
  const moved = build("pandamonium", { userData: "/tmp/moved-by-a-switch" });
  try { assert.deepEqual(moved.calls.setPath, [["userData", APPDATA + "/PandamoniumDesktop"]]); } finally { moved.restore(); }
  const sw = build("pandamonium", { argv: ["--user-data-dir=" + REAL] });
  try { assert.match(String(sw.error && sw.error.message), /exit\(2\)/, "the app is not started"); assert.deepEqual(sw.calls.setPath, []); } finally { sw.restore(); }
  // a flavour definition that would share something with the released app is refused when the app loads
  const bad = (patch) => Object.assign({}, PKG.flavors.pandamonium, patch);
  for (const [patch, why] of [[{ userData: "minimaCore" }, /released app's userData/], [{ userData: "MINIMACORE" }, /released app's userData/], [{ userData: "../minimaCore" }, /plain folder name/], [{ userData: "minimaCore/sub" }, /plain folder name/],
    [{ userData: "/Users/x/Library/Application Support/minimaCore" }, /plain folder name/], [{ appId: "com.eurobuddha.minimacore" }, /released app's appId/], [{ productName: "minimaCore" }, /released app's productName/],
    [{ keychainService: "com.eurobuddha.minimacore.rpc" }, /released app's keychainService/], [{ keychainService: "com.eurobuddha.minimacore.rpc.x" }, /must not begin with the released app's/],
    [{ basePort: 12001 }, /released app's basePort/], [{ basePort: 12005 }, /within the released app's port range/], [{ basePort: 11500 }, /within the released app's port range/], [{ userData: "" }, /has no userData/], [{ basePort: "17001" }, /whole number/]])
    assert.throws(() => flavor.resolve({ flavor: "x", flavors: { x: bad(patch) } }), why, JSON.stringify(patch));
  assert.throws(() => flavor.resolve({ flavor: "nosuch", flavors: PKG.flavors }), /does not define it/);
  const loaded = build("pandamonium", { pkg: { flavors: { pandamonium: bad({ userData: "minimaCore" }) } } });
  try { assert.match(String(loaded.error && loaded.error.message), /released app's userData/); assert.deepEqual(loaded.calls.setPath, []); } finally { loaded.restore(); }
  // every folder a TEST profile may not be, for both flavours (the old check, kept): the released folder, around it, inside it, any letter case
  for (const F of [R, P]) {
    for (const dir of [REAL, REAL + "/", REAL + "/node-data", APPDATA + "/MINIMACORE/sub", APPDATA, "/Users/x", "relative/folder"])
      assert.ok(flavor.place(F, { MCD_TEST_PROFILE: dir }, [], APPDATA).error, F.id + " " + dir + " must be refused");
    const a = flavor.place(F, { MCD_TEST_PROFILE: APPDATA + "/MinimaCoreDesktop-TEST" }, [], APPDATA), b = flavor.place(F, { MCD_TEST_PROFILE: "/tmp/other-test" }, [], APPDATA);
    assert.equal(a.error, ""); assert.equal(a.name, F.productName + " TEST"); assert.match(a.keychainService, new RegExp("^" + F.keychainService.replace(/\./g, "\\.") + "\\.test\\.[0-9a-f]{64}$"));
    assert.notEqual(a.keychainService, b.keychainService, "one keychain service per profile folder");
  }
  assert.ok(flavor.place(P, { MCD_TEST_PROFILE: APPDATA + "/PandamoniumDesktop/sub" }, [], APPDATA).error, "a TEST profile inside the flavour's own folder is refused too");
});

test("no update check for this flavour: not at start, not when asked, nothing downloaded; and it never registers itself to open at login", async () => {
  const b = build("pandamonium");
  const http = require("http"), https = require("https"), real = [http.get, https.get, http.request, https.request]; let asked = 0;
  http.get = https.get = http.request = https.request = () => { asked++; throw new Error("TEST LEAK: a request left the updater"); };
  const realTimeout = global.setTimeout, realInterval = global.setInterval; let timers = 0;
  try {
    const upd = b.load("updater.js");
    assert.equal(upd.OFF, true);
    global.setTimeout = global.setInterval = () => { timers++; return { unref() {} }; };
    upd.start();
    global.setTimeout = realTimeout; global.setInterval = realInterval;
    assert.equal(timers, 0, "start() arms no timer");
    const st = await upd.check();
    assert.equal(st.available, false); assert.equal(asked, 0, "check() asks no feed");
    await assert.rejects(upd.download(), /Pandamonium Desktop does not update itself/);
    const cur = upd.current();
    assert.deepEqual([cur.available, cur.off, cur.feed], [false, true, ""], "no feed is even named"); assert.equal(asked, 0);
    const li = b.load("loginitem.js").apply(require("electron").app, true);
    assert.equal(li.ok, false); assert.match(li.note, /does not open at login/); assert.deepEqual(b.calls.login, [], "the OS login item is never set");
    const main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8");
    assert.match(main, /ipcMain\.handle\("mcd:updateCheck", async \(\) => \{ await updater\.check\(\); return updater\.current\(\); \}\);/, "the handlers go through the guarded functions");
    assert.match(main, /ipcMain\.handle\("mcd:updateDownload", async \(\) => \{ const p = await updater\.download\(\);/);
    assert.ok(!/updater\.(get|fetch)\(/.test(main));
  } finally { global.setTimeout = realTimeout; global.setInterval = realInterval; [http.get, https.get, http.request, https.request] = real; b.restore(); }
  // a TEST profile of the released app does not read the feed either
  const t = build("", { profile: "/tmp/flavor-test-profile" });
  try { assert.equal(t.load("updater.js").OFF, true); assert.equal(t.load("loginitem.js").apply(require("electron").app, true).note, "not registered: TEST profile"); assert.deepEqual(t.calls.setName, ["minimaCore TEST"]); } finally { t.restore(); }
});

/** node-manager in a temp userData, with stand-ins for everything it asks the OS. */
function manager(id, world) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flavor-node-")), b = build(id, { appData: dir, packaged: false });
  const cfg = b.load("config.js"); cfg.rpcSecret = () => "test-secret";
  const m = b.load("node-manager.js"), signals = [], rpc = [];
  m.sys = { sleep: async () => {}, alive: (pid) => !!world.procs[pid], commandOf: (pid) => world.procs[pid] || "",
    listeners: (port) => Object.keys(world.ports).filter(p => Number(p) === port).map(p => world.ports[p]),
    killPid: (pid, sig) => { signals.push([pid, sig]); if (world.dieOn === sig || world.dieOn === "any") { delete world.procs[pid]; for (const p of Object.keys(world.ports)) if (world.ports[p] === pid) delete world.ports[p]; } } };
  m.rpc = async (c) => { rpc.push(c); if (c === "quit" && world.quitWorks) { const pid = world.ports[m.rpcPort()]; delete world.procs[pid]; for (const p of Object.keys(world.ports)) if (world.ports[p] === pid) delete world.ports[p]; } return { status: true }; };
  return { m, cfg, signals, rpc, userData: b.userData.dir, done: () => { b.restore(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("ports derive from the base port: 17001 for Pandamonium Desktop, 12001 for the released app, and the two sets never meet", () => {
  const p = manager("pandamonium", { procs: {}, ports: {} }), r = manager("", { procs: {}, ports: {} });
  try {
    assert.deepEqual(p.m.ports(), [{ port: 17001, what: "the node's P2P port" }, { port: 17005, what: "the node's RPC" }, { port: 17006, what: "the keets sidecar" }, { port: 17585, what: "the Parlons wallet gateway" }, { port: 17587, what: "the Parlons panel" }]);
    assert.deepEqual(r.m.ports().map(x => x.port), [12001, 12005, 12006, 12585, 12587], "the released app's ports are what they were");
    assert.deepEqual([p.m.rpcPort(), p.m.panelPort(), p.m.capePort()], [17005, 17587, 17001]);
    const args = p.m.buildArgs().join(" ");
    for (const must of ["-Dparlons.node.port=17001", "-Dparlons.panel.port=17587", "-Dparlons.gateway.port=17585", "-Dparlons.node.data=" + p.userData + "/node-data", "-Dparlons.node.rpc=true"]) assert.ok(args.includes(must), must + " in " + args);
    assert.ok(!/1200\d|1258\d/.test(args), "no port of the released app in the start command");
    assert.ok(!/-mds|mdsenable/i.test(args) && !/-mds|mdsenable/i.test(r.m.buildArgs().join(" ")), "the MiniDapp System is never switched on (this node line has none)");
    assert.equal(p.m.ports().filter(a => r.m.ports().some(b2 => b2.port === a.port)).length, 0);
    p.cfg.save({ nodeKind: "minima", params: { keets: false } });
    assert.deepEqual(p.m.ports().map(x => x.port), [17001, 17005], "the plain node without keets: its P2P port and its RPC");
    p.cfg.save({ rpcPortManual: "17999" }); assert.deepEqual(p.m.ports().map(x => x.port), [17001, 17999]);
  } finally { p.done(); r.done(); }
});

test("reclaim never signals a foreign pid: only the pid in this profile's own pidfile, and only while its command line names this profile's data folder", async () => {
  for (const id of ["pandamonium", ""]) {
    const base = id ? 17001 : 12001;
    // (1) the RELEASED app's node (or any other) is listening on our port: reported, never touched
    for (const foreign of ["/Applications/minimaCore.app/Contents/Resources/jre/bin/java -Xmx1536m -Dparlons.node.data=/Users/x/Library/Application Support/minimaCore/node-data -Dparlons.node.port=" + base + " -jar /Applications/minimaCore.app/Contents/Resources/parlons-node.jar",
      "java -jar minima.jar -data /somewhere/else -port " + base, "/usr/bin/python3 -m http.server " + base, ""]) {
      const world = { procs: { 4242: foreign }, ports: { [base]: 4242, [base + 4]: 4242 }, dieOn: "any", quitWorks: true }, t = manager(id, world);
      try {
        fs.mkdirSync(t.userData, { recursive: true });
        fs.writeFileSync(t.m.pidfilePath(), JSON.stringify({ pid: 4242, port: base }));   // even named by a (stale or forged) pidfile: its command line is not ours
        const why = await t.m.reclaimStaleNode();
        assert.match(why, new RegExp("^Port " + base + " \\(the node's P2P port\\) is in use by .* \\(pid 4242\\)\\. .* did not start its node and did not touch that program\\."), why);
        assert.deepEqual(t.signals, [], "no signal: " + foreign); assert.deepEqual(t.rpc, [], "and no `quit` over RPC (a Parlons node's admin RPC obeys without a password)");
        assert.ok(world.procs[4242] !== undefined, "it is still running"); assert.deepEqual(t.m.portOwner, { pid: 4242, port: base, command: foreign || "(unknown)" });
      } finally { t.done(); }
    }
    // (2) any OTHER needed port held by something else: named, with what it is for
    for (const [off, what] of [[4, "the node's RPC"], [5, "the keets sidecar"], [584, "the Parlons wallet gateway"], [586, "the Parlons panel"]]) {
      const world = { procs: { 77: "some other program" }, ports: { [base + off]: 77 }, dieOn: "any" }, t = manager(id, world);
      try { assert.match(await t.m.reclaimStaleNode(), new RegExp("^Port " + (base + off) + " \\(" + what + "\\) is in use by some other program \\(pid 77\\)")); assert.deepEqual(t.signals, []); assert.deepEqual(t.rpc, []); } finally { t.done(); }
    }
    // (3) OUR OWN node from an earlier launch: pidfile pid + this profile's data folder in its command line. Stopped, then the start goes on
    {
      const world = { procs: {}, ports: {}, quitWorks: true }, t = manager(id, world);
      try {
        fs.mkdirSync(t.userData, { recursive: true });
        const mine = "java -Xmx1536m -Dparlons.node.data=" + t.userData + "/node-data -Dparlons.node.port=" + base + " -jar /x/parlons-node.jar";
        world.procs[555] = mine; world.ports[base] = 555; world.ports[base + 4] = 555;
        fs.writeFileSync(t.m.pidfilePath(), JSON.stringify({ pid: 555 }));
        assert.equal(await t.m.reclaimStaleNode(), ""); assert.deepEqual(t.rpc, ["quit"]); assert.deepEqual(t.signals, [], "it left on `quit`"); assert.equal(fs.existsSync(t.m.pidfilePath()), false);
        // it does not answer `quit` and is not the RPC listener: signalled, and ONLY it
        world.procs[556] = mine; world.procs[900] = "another app's node"; world.ports[base] = 556; world.dieOn = "SIGKILL";
        fs.writeFileSync(t.m.pidfilePath(), JSON.stringify({ pid: 556 })); t.rpc.length = 0;
        assert.equal(await t.m.reclaimStaleNode(), ""); assert.deepEqual(t.rpc, [], "`quit` is not sent when our node is not the one on the RPC port");
        assert.deepEqual(t.signals, [[556, "SIGTERM"], [556, "SIGKILL"]]); assert.ok(world.procs[900]);
        // the same folder name with something after it is ANOTHER profile's node: not ours
        world.procs[557] = mine.replace("/node-data ", "/node-data-2 "); world.ports[base] = 557; t.signals.length = 0;
        fs.writeFileSync(t.m.pidfilePath(), JSON.stringify({ pid: 557 }));
        assert.match(await t.m.reclaimStaleNode(), /^Port \d+ .* \(pid 557\)/); assert.deepEqual(t.signals, []);
        // the pidfile names THIS app's own process id (a reused pid): never signalled
        delete world.ports[base]; world.procs[process.pid] = mine; fs.writeFileSync(t.m.pidfilePath(), JSON.stringify({ pid: process.pid }));
        assert.equal(await t.m.reclaimStaleNode(), ""); assert.deepEqual(t.signals, []);
      } finally { t.done(); }
    }
  }
  const src = fs.readFileSync(path.join(ROOT, "main/node-manager.js"), "utf8"), fn = src.slice(src.indexOf("  async reclaimStaleNode() {"), src.indexOf("  /** Last resort on the way out"));
  assert.equal((fn.match(/killPid\(/g) || []).length, 2); assert.ok(!/killPid\((?!mine,)/.test(fn), "every signal in reclaim goes to `mine`");
  assert.ok(!/-port |parlons\.node\.port/.test(fn), "a node is no longer called ours for the port it listens on");
});

test("the build of a flavour: its name, id and artifact names, the flavour written into the PACKAGED package.json, its own jars checked against its own pins, nothing notarized or downloaded", () => {
  const { builderConfig, jarProblem } = require("./build-flavor.cjs"), { F, J, cfg } = builderConfig(PKG, "pandamonium");
  assert.equal(cfg.appId, "com.eurobuddha.pandamonium.desktop"); assert.equal(cfg.productName, "Pandamonium Desktop");
  assert.deepEqual(cfg.extraMetadata, { flavor: "pandamonium", productName: "Pandamonium Desktop" });
  assert.equal(cfg.mac.notarize, false); assert.equal(cfg.mac.hardenedRuntime, true); assert.equal(cfg.mac.identity, "Developer ID Application"); assert.equal(cfg.mac.artifactName, "PandamoniumDesktop-${version}-${arch}.${ext}");
  assert.equal(cfg.electronDist, "node_modules/electron/dist"); assert.equal(cfg.npmRebuild, false); assert.equal(cfg.publish, null);
  assert.deepEqual(cfg.extraResources.slice(0, 2), [{ from: "resources-pandamonium/minima.jar", to: "minima.jar" }, { from: "resources-pandamonium/parlons-node.jar", to: "parlons-node.jar" }]);
  assert.deepEqual(cfg.extraResources.slice(2), PKG.build.extraResources.slice(2), "the JRE and the keets sidecar are the released app's");
  assert.deepEqual(cfg.files, PKG.build.files); assert.ok(!cfg.files.some(f => /^scripts|test|dev-preview/.test(f)), "no script, test or preview is packaged");
  assert.equal(builderConfig(PKG, "pandamonium", { adhoc: true }).cfg.mac.identity, "-");
  // 0.19.107: the system's camera and microphone questions name this app; the released build's own wording is not edited
  assert.deepEqual(cfg.mac.extendInfo, { NSCameraUsageDescription: "Pandamonium Desktop uses your camera to scan QR codes.", NSMicrophoneUsageDescription: "Pandamonium Desktop uses your microphone to record a Chat voice note when you choose Voice note." });
  assert.match(PKG.build.mac.extendInfo.NSMicrophoneUsageDescription, /^Minima Core uses your microphone/);
  assert.throws(() => builderConfig(PKG, ""), /name a flavour/); assert.equal(F.basePort, 17001);
  assert.deepEqual([J.parlonsNode, J.parlonsNodeSha256, J.minima, J.minimaSha256], ["0.2.153", "c2b8cb33b07b78197cc4ed0b5c82cf3f14b6407095f20963971d6b932b25e6af", "1.1.2.31-euro5", "93111abb83f2239970257e692026b6033f3b1caeaf31db52604b9f531a0617ea"]);
  // the jar check, on stand-in files
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flavor-jars-")), sha = (s) => require("crypto").createHash("sha256").update(s).digest("hex");
  try {
    const pins = { minimaSha256: sha("m"), parlonsNodeSha256: sha("p") };
    assert.match(jarProblem(dir, pins), /minima\.jar is missing/);
    fs.writeFileSync(path.join(dir, "minima.jar"), "m"); fs.writeFileSync(path.join(dir, "parlons-node.jar"), "the released jar");
    assert.match(jarProblem(dir, pins), /parlons-node\.jar is not the pinned jar: sha256 [0-9a-f]{64}, package\.json pins [0-9a-f]{64}$/);
    fs.writeFileSync(path.join(dir, "parlons-node.jar"), "p"); assert.equal(jarProblem(dir, pins), "");
    assert.match(jarProblem(dir, { minimaSha256: sha("m") }), /pins no sha256/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // staged jars, when they are there, are the pinned ones (the build refuses otherwise)
  const staged = path.join(ROOT, J.dir);
  if (fs.existsSync(path.join(staged, "minima.jar")) && fs.existsSync(path.join(staged, "parlons-node.jar"))) assert.equal(jarProblem(staged, J), "");
  const sh = fs.readFileSync(path.join(ROOT, "scripts/build-flavor.cjs"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.ok(!/notarytool|gh release|curl|wget|https?:\/\//.test(sh), "the flavour build notarizes, uploads and downloads nothing");
});

// ---- 0.19.106: the Phase 4 messaging work (merged from the other branch) follows the flavour too ----
test("0.19.106: Parlons in the browser, Mail and Chat follow the flavour: the panel link only on this app's own panel port, the stores only in this app's own folder", () => {
  for (const [id, folder, panel, other] of [["pandamonium", "PandamoniumDesktop", 17587, 12587], ["", "minimaCore", 12587, 17587]]) {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "mcd-flavor-p4-")), own = path.join(appData, folder);
    const b = build(id, { appData, userData: path.join(appData, "minimaCore") });
    try {
      const opened = []; require("electron").shell.openExternal = (u) => opened.push(u);
      const cfg = b.load("config.js"), nm = b.load("node-manager.js"), parlons = b.load("parlons.js");
      cfg.save({ nodeKind: "parlons" });
      assert.equal(nm.panelPort(), panel);
      fs.mkdirSync(nm.dataDir(), { recursive: true });
      const ticket = (port) => fs.writeFileSync(path.join(nm.dataDir(), "panel-ticket.txt"), "http://127.0.0.1:" + port + "/open?ticket=abc\n");
      ticket(other); assert.equal(parlons.openExternal(), false, "the other app's panel port is not opened"); assert.deepEqual(opened, []);
      ticket(panel); assert.equal(parlons.openExternal(), true); assert.deepEqual(opened, ["http://127.0.0.1:" + panel + "/open?ticket=abc"]);
      // the stores: an older store in this app's own folder is the one read, and its one-time copy is made beside it
      const old = JSON.stringify({ version: 1, messages: {}, contacts: {}, meta: { "flavor-test": folder } });
      fs.writeFileSync(path.join(own, "mail.json"), old); fs.writeFileSync(path.join(own, "chat.json"), old);
      assert.equal(b.load("mail-store.js").metaGet("flavor-test"), folder); assert.equal(b.load("chat-store.js").metaGet("flavor-test"), folder);
      assert.ok(fs.existsSync(path.join(own, "mail.json.before-0.18.148")), "mail.json.before-0.18.148"); assert.ok(fs.existsSync(path.join(own, "chat.json.before-0.19.2")), "chat.json.before-0.19.2");
      assert.deepEqual(fs.readdirSync(appData), [folder], "nothing beside this app's own folder");
    } finally { b.restore(); fs.rmSync(appData, { recursive: true, force: true }); }
  }
  // by reading: every Phase 4 path is taken from userData, and none names an app
  for (const f of ["chat.js", "chatfiles.js", "chatvoice.js", "chat-store.js", "mail.js", "mail-store.js", "payverify.js", "parlons.js", "parlons-notify.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "main", f), "utf8");
    assert.ok(!/Application Support|getPath\("appData"\)|minimacore\.rpc|1258[57]|1200[156]/.test(src), f + " names no folder, service or port of the released app");
  }
});
