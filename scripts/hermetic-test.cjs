/*
 * hermetic-test.cjs — no test or script in this repo can touch a node by accident (0.18.140).
 *
 * Until then scripts/atomix-unit.js ran `docker exec <a fixed name> curl …` whenever docker was reachable, and on the
 * owner's machine that name is a wallet with real funds. These tests run the scripts with a PATH that holds only
 * stand-in `docker`, `curl` and `security` programs which leave a mark when started: a mark is a failure.
 */
const test = require("node:test"), assert = require("node:assert");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const NODE_VARS = ["AX_TEST_NODE_RPC", "AX_TEST_NODE_CONTAINER", "AX_TEST_NODE_I_OWN_THIS", "AX_TEST_NODE_ADDRESS", "AX_TEST_NODE_EXPECT_ETH", "AX_TEST_CDP_PORT"];

/** Runs a script with only the stand-in programs on PATH. → { status, out, marks: the programs that were started } */
function run(script, env = {}, args = []) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-bin-")), mark = path.join(bin, "STARTED");
  for (const name of ["docker", "curl", "security", "java"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\necho \"" + name + " $*\" >> \"" + mark + "\"\nexit 1\n", { mode: 0o755 });
  const clean = Object.assign({}, process.env); for (const k of NODE_VARS) delete clean[k];
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { cwd: ROOT, env: Object.assign(clean, { PATH: bin }, env), encoding: "utf8", timeout: 120000 });
  const marks = fs.existsSync(mark) ? fs.readFileSync(mark, "utf8").trim().split("\n") : [];
  fs.rmSync(bin, { recursive: true, force: true });
  return { status: r.status, out: String(r.stdout) + String(r.stderr), marks };
}

test("atomix-unit with nothing named: passes, starts no program, opens no socket, and says the live variant was skipped", () => {
  const r = run("atomix-unit.js");
  assert.equal(r.status, 0, r.out.slice(-1500));
  assert.deepEqual(r.marks, [], "no docker, curl, security or java was started");
  assert.match(r.out, /✓ frozen quote issues a replayable quoteId; replay consumes it \(mock node, fake identity\)/);
  assert.match(r.out, /✓ the whole suite started no child process and opened no socket/);
  assert.match(r.out, /SKIPPED \(no test node named: set AX_TEST_NODE_RPC/);
  assert.match(r.out, /ETH 0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a/, "the engine's identity is the one of the FAKE key written in the test");
});

test("the live gates with nothing named: refuse with a message and a non-zero exit, and start nothing", () => {
  for (const g of ["atomix-boot-gate.js", "atomix-s2-gate.js", "cdp-eval.js"]) {
    const r = run(g);
    assert.equal(r.status, 1, g + ": " + r.out); assert.deepEqual(r.marks, [], g);
    assert.match(r.out, /NOT RUN: no (test node|app) was named\..*Nothing was sent/s, g);
  }
});

test("a node that is named but not owned: what would be sent is printed (the seed read first), then it refuses and starts nothing", () => {
  for (const s of ["atomix-unit.js", "atomix-boot-gate.js", "atomix-s2-gate.js"]) {
    for (const env of [{ AX_TEST_NODE_RPC: "http://127.0.0.1:1", AX_TEST_NODE_CONTAINER: "some-test-node" }, { AX_TEST_NODE_RPC: "http://127.0.0.1:1", AX_TEST_NODE_I_OWN_THIS: "y" }]) {
      const r = run(s, env);
      assert.equal(r.status, 2, s + ": " + r.out); assert.deepEqual(r.marks, [], s);
      assert.match(r.out, /About to use the node at http:\/\/127\.0\.0\.1:1/);
      assert.match(r.out, /vault action:seed \(READS THE NODE'S SEED PHRASE/);
      assert.match(r.out, /seedrandom modifier:ethbridge/);
      assert.match(r.out, /REFUSED: AX_TEST_NODE_I_OWN_THIS=yes is not set\. Nothing was sent\./);
    }
  }
  const half = run("atomix-unit.js", { AX_TEST_NODE_CONTAINER: "some-test-node", AX_TEST_NODE_I_OWN_THIS: "yes" });
  assert.equal(half.status, 2); assert.deepEqual(half.marks, []); assert.match(half.out, /there is no default/);
  const cdp = run("cdp-eval.js", { AX_TEST_CDP_PORT: "1" }, ["1+1"]);
  assert.equal(cdp.status, 2); assert.match(cdp.out, /REFUSED/);
});

test("a named and owned node in a container is reached through docker exec of THAT name only (the stand-in docker, so nothing real)", () => {
  const probe = path.join(os.tmpdir(), "hermetic-probe-" + process.pid + ".cjs");
  fs.writeFileSync(probe, "require(" + JSON.stringify(path.join(ROOT, "scripts/test-node.cjs")) + ").testNode(['status (a read)']).run('status').then(() => process.exit(0), () => process.exit(0));");
  try {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-bin-")), mark = path.join(bin, "STARTED");
    fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho \"docker $*\" >> \"" + mark + "\"\nexit 1\n", { mode: 0o755 });
    const r = spawnSync(process.execPath, [probe], { env: { PATH: bin, AX_TEST_NODE_RPC: "http://127.0.0.1:19005", AX_TEST_NODE_CONTAINER: "some-test-node", AX_TEST_NODE_I_OWN_THIS: "yes" }, encoding: "utf8", timeout: 30000 });
    // 0.19.103: the FIRST thing sent is `balance`; the stand-in docker answers nothing, so the script stops there and `status` is never sent
    assert.equal(fs.readFileSync(mark, "utf8").trim(), "docker exec some-test-node curl -s -m 60 http://127.0.0.1:19005/balance", r.stdout + r.stderr);
    assert.equal(r.status, 2); assert.match(r.stderr, /REFUSED: the node did not answer `balance`.*Nothing else was sent\./s);
    assert.match(r.stdout, /About to use the node at http:\/\/127\.0\.0\.1:19005 inside the docker container some-test-node\. It will be sent:\n  - balance \(a read, sent FIRST[^\n]*\n  - checkaddress [^\n]*\n  - status \(a read\)/);
    fs.rmSync(bin, { recursive: true, force: true });
  } finally { fs.rmSync(probe, { force: true }); }
});

test("no script, package script or workflow names a node: no container name, no docker or RPC port outside scripts/test-node.cjs", () => {
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/^\s*#.*$/gm, "");
  const files = fs.readdirSync(path.join(ROOT, "scripts")).filter(f => /\.(c?js|sh)$/.test(f)).map(f => "scripts/" + f)
    .concat(fs.readdirSync(path.join(ROOT, "scripts/dev-preview")).filter(f => /\.js$/.test(f)).map(f => "scripts/dev-preview/" + f), ["package.json"],
      fs.readdirSync(path.join(ROOT, ".github/workflows")).map(f => ".github/workflows/" + f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8"), c = code(src);
    assert.ok(!new RegExp("mini" + "mega", "i").test(c), f + " names the custody container in code");
    if (f === "scripts/test-node.cjs" || f === "scripts/hermetic-test.cjs") continue;
    assert.ok(!/["'`]docker["'`]|\bdocker (exec|run)\b/.test(c), f + " starts docker itself: it must go through scripts/test-node.cjs");
    assert.ok(!/127\.0\.0\.1:9005|localhost:9005|:9333\b/.test(c), f + " carries a fixed node or debugging port");
  }
  const tn = fs.readFileSync(path.join(ROOT, "scripts/test-node.cjs"), "utf8");
  assert.ok(!/\|\|\s*["']\w/.test(code(tn).replace(/\|\| ""/g, "")), "test-node.cjs has no default node");
});

// ---- 0.19.103: a node that holds funds is refused unless the caller names one of ITS OWN addresses ----
test("live scripts: `balance` is sent first; any non-zero balance refuses unless AX_TEST_NODE_ADDRESS is an address that node itself owns", async () => {
  const { balanceProblem } = require("./test-node.cjs"), MINE = "0x" + "AB".repeat(32), THEIRS = "0x" + "CD".repeat(32);
  const node = (rows, own) => { const sent = []; return { sent, send: async (c) => { sent.push(c); if (c === "balance") return { status: true, response: rows }; if (/^checkaddress address:/.test(c)) return { status: true, response: c.endsWith(own || "-") ? { simple: true, relevant: true } : {} }; throw new Error("sent before the check: " + c); } }; };
  const zero = [{ tokenid: "0x00", confirmed: "0", unconfirmed: "0", sendable: "0", coins: "0", total: "1000000000" }];
  const e = node(zero); assert.equal(await balanceProblem(e.send, ""), ""); assert.deepEqual(e.sent, ["balance"], "an empty node: one read, no address needed");
  for (const rows of [[{ tokenid: "0x00", confirmed: "0.000000001", unconfirmed: "0", sendable: "0" }], [{ tokenid: "0x00", confirmed: "0", unconfirmed: "5", sendable: "0" }], zero.concat([{ tokenid: "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", confirmed: "12.5", unconfirmed: "0", sendable: "12.5" }])]) {
    const n = node(rows, MINE);
    assert.match(await balanceProblem(n.send, ""), /^this node HOLDS FUNDS: .*AX_TEST_NODE_ADDRESS.*Nothing else was sent\.$/); assert.deepEqual(n.sent, ["balance"]);
    assert.match(await balanceProblem(n.send, THEIRS), /is NOT one of its own\. This is not the node you named the address of\. Nothing else was sent\.$/, "the address of ANOTHER node: a wrong container name cannot pass");
    assert.equal(await balanceProblem(n.send, MINE), "", "its own address: allowed");
    assert.match(await balanceProblem(n.send, "0x1234"), /is not a Minima address/);
  }
  const custody = (await balanceProblem(node([{ tokenid: "0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90", confirmed: "1", unconfirmed: "0", sendable: "1" }]).send, ""));
  assert.ok(custody.includes("token 0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90"), "a token id is printed whole");
  // unreadable is never "empty"
  assert.match(await balanceProblem(async () => { throw new Error("ECONNREFUSED"); }, MINE), /did not answer `balance`/);
  assert.match(await balanceProblem(async () => ({ status: false, error: "x" }), MINE), /could not be read/);
  assert.match(await balanceProblem(async (c) => (c === "balance" ? { status: true, response: [{ tokenid: "0x00", confirmed: "1", unconfirmed: "0", sendable: "1" }] } : { status: false }), MINE), /is NOT one of its own/);
  // through testNode: the caller's first command waits for the check, and a refusal ends the script before it is sent
  const probe = path.join(os.tmpdir(), "hermetic-bal-" + process.pid + ".cjs");
  fs.writeFileSync(probe, `const sent = []; const t = require(${JSON.stringify(path.join(ROOT, "scripts/test-node.cjs"))});
    const rows = JSON.parse(process.env.ROWS);
    const n = t.testNode(["vault action:seed"], process.env, async (c) => { sent.push(c); process.stdout.write("SENT " + c + "\\n"); if (c === "balance") return { status: true, response: rows }; if (/^checkaddress/.test(c)) return { status: true, response: c.endsWith(process.env.OWN) ? { simple: true } : {} }; return { status: true, response: {} }; });
    Promise.all([n.run("vault action:seed"), n.run("keys")]).then(() => { process.stdout.write("DONE " + sent.join(" | ") + "\\n"); });`);
  try {
    const go = (env) => spawnSync(process.execPath, [probe], { env: Object.assign({ PATH: "/nonexistent", AX_TEST_NODE_RPC: "http://127.0.0.1:1", AX_TEST_NODE_I_OWN_THIS: "yes", OWN: MINE }, env), encoding: "utf8", timeout: 30000 });
    const funded = JSON.stringify([{ tokenid: "0x00", confirmed: "7", unconfirmed: "0", sendable: "7" }]);
    let r = go({ ROWS: JSON.stringify(zero) }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /DONE balance \| vault action:seed \| keys\n$/, "one balance read, then the commands");
    r = go({ ROWS: funded }); assert.equal(r.status, 2); assert.ok(!/SENT vault|SENT keys/.test(r.stdout), "the seed read never left"); assert.match(r.stderr, /REFUSED: this node HOLDS FUNDS: MINIMA \(confirmed 7, unconfirmed 0\)/);
    r = go({ ROWS: funded, AX_TEST_NODE_ADDRESS: THEIRS }); assert.equal(r.status, 2); assert.ok(!/SENT vault/.test(r.stdout)); assert.match(r.stderr, /is NOT one of its own/);
    r = go({ ROWS: funded, AX_TEST_NODE_ADDRESS: MINE }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /DONE balance \| checkaddress address:0xAB[AB]{62} \| vault action:seed \| keys\n$/);
  } finally { fs.rmSync(probe, { force: true }); }
});

// ---- the TEST copy of the app (scripts/dev-run.sh, main/flavor.js) ----
// What the TEST profile may and may not be is tested with the flavours, in scripts/flavor-test.cjs (0.19.105).
test("TEST profile: one mechanism (main/flavor.js) sets the folder, the name and the keychain service before anything reads them", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "main/config.js"), "utf8"), main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8"), fl = fs.readFileSync(path.join(ROOT, "main/flavor.js"), "utf8");
  assert.match(cfg, /const KEYCHAIN_SERVICE = flavor\.keychainService;/, "every keychain read and write goes under the flavour's (and the profile's) own service name");
  assert.equal((cfg.match(/com\.eurobuddha\./g) || []).length, 0, "no service name is written in main/config.js");
  assert.ok(main.indexOf('require("./flavor")') < main.indexOf('require("./config")') && main.indexOf('require("./flavor")') < main.indexOf("requestSingleInstanceLock"), "applied before the config, the keychain or the single-instance lock is touched");
  assert.match(fl, /const released = path\.join\(String\(appData \|\| ""\), RELEASED\.userData\)/, "the released folder comes from appData, never from userData");
  assert.match(fs.readFileSync(path.join(ROOT, "main/updater.js"), "utf8"), /const OFF = !flavor\.updates \|\| flavor\.test;/, "a TEST copy does not read the update feed");
  assert.match(fs.readFileSync(path.join(ROOT, "main/loginitem.js"), "utf8"), /if \(flavor\.test\) return \{ ok: false, on, note: "not registered: TEST profile" \};/);
});

test("dev-run.sh: refuses the real folder, a busy port and missing jars; copies jars only with --jars; fetches nothing; opens no debugging port", () => {
  const sh = fs.readFileSync(path.join(ROOT, "scripts/dev-run.sh"), "utf8");
  assert.ok(!/\b(curl|wget|gh |npm run fetch|remote-debugging-port)\b/.test(sh.replace(/^\s*#.*$/gm, "")), "it downloads nothing and opens no debugging port");
  assert.equal((sh.replace(/<<MSG[\s\S]*?\nMSG\n/, "").match(/^\s*cp /gm) || []).length, 1, "one copy, the --jars one (the copy commands in the refusal are text)");
  assert.ok(sh.indexOf('if [ -n "$JARS" ]; then') < sh.indexOf('cp "${found[0]}"') && sh.indexOf('cp "${found[0]}"') < sh.indexOf("\nfi\nmissing=0"), "and it is inside the --jars branch");
  for (const must of ["is, or is inside, the real install's folder", "contains the real install's folder", "was not created by this script", "something is already listening on port(s)", "12001 is the real app's default base port",
    "shasum -a 256", "minima-1.1.2.31-euro5.jar", "parlons-node-0.2.153.jar", "desktop/minimacore-desktop/resources/minima.jar", 'MCD_TEST_PROFILE="$PROFILE" exec "$ELECTRON" "$ROOT"\n', "17001 is Pandamonium Desktop's default base port"])
    assert.ok(sh.includes(must), "dev-run.sh: " + must);
  assert.ok(sh.indexOf("for off in 0 1 2 3 4 5 584 586") < sh.indexOf('mkdir -p "$PROFILE"'), "the ports are probed before anything is created");
  assert.ok(!/--user-data-dir=/.test(sh.replace(/^\s*#.*$/gm, "")), "the app is started without --user-data-dir: it refuses the switch and sets its folder itself (0.19.105)");
});

// ---- 0.19.280: the vendored-file manifests run in the local suites too, and Finder's .DS_Store is not a stray ----
test("the copied-engine manifests: in the local test:atomix and test:casino, and a .DS_Store beside the files is no stray while any other file is", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  assert.match(pkg["test:atomix"], /npm run test:atomix-manifest/); assert.match(pkg["test:casino"], /npm run test:casino-manifest/);
  const run = (script, ...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { cwd: ROOT, encoding: "utf8" });
  for (const [dir, script, args] of [["main/casino", "vendored-manifest.cjs", ["casino", "--verify"]], ["main/atomix", "vendored-manifest.cjs", ["atomix", "--verify"]], ["main/pandapools", "pandapools-parity-manifest.cjs", ["--verify"]], ["main/dexicon", "dexicon-parity-manifest.cjs", ["--verify"]]]) {
    const ds = path.join(ROOT, dir, ".DS_Store"), stray = path.join(ROOT, dir, "stray-0-19-280.js"), had = fs.existsSync(ds);
    try {
      if (!had) fs.writeFileSync(ds, "Finder");
      let r = run(script, ...args); assert.equal(r.status, 0, dir + " with a .DS_Store: " + r.stdout + r.stderr);
      fs.writeFileSync(stray, "// not an engine file");
      r = run(script, ...args); assert.notEqual(r.status, 0, dir + ": a stray file still fails"); assert.match(r.stdout + r.stderr, /stray-0-19-280\.js/);
    } finally { fs.rmSync(stray, { force: true }); if (!had) fs.rmSync(ds, { force: true }); }
  }
});
