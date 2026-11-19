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
const NODE_VARS = ["AX_TEST_NODE_RPC", "AX_TEST_NODE_CONTAINER", "AX_TEST_NODE_I_OWN_THIS", "AX_TEST_NODE_EXPECT_ETH", "AX_TEST_CDP_PORT"];

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
    assert.equal(fs.readFileSync(mark, "utf8").trim(), "docker exec some-test-node curl -s -m 60 http://127.0.0.1:19005/status", r.stdout + r.stderr);
    assert.match(r.stdout, /About to use the node at http:\/\/127\.0\.0\.1:19005 inside the docker container some-test-node\. It will be sent:\n  - status \(a read\)/);
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

// ---- the TEST copy of the app (scripts/dev-run.sh, main/testprofile.js) ----
test("TEST profile: refused on, inside or around the real install's folder (any letter case); otherwise its own keychain service name", () => {
  const { profile } = require("../main/testprofile.js"), REAL = "/Users/x/Library/Application Support/minimaCore";
  assert.deepEqual(profile({}, REAL), { on: false, dir: "", keychainSuffix: "", error: "" }, "not asked for: the real names, unchanged");
  for (const bad of [REAL, REAL + "/", REAL + "/node-data", "/Users/x/Library/Application Support/MINIMACORE/sub", "/Users/x/Library/Application Support", "/Users/x", "relative/folder"]) {
    const p = profile({ MCD_TEST_PROFILE: bad }, REAL);
    assert.ok(p.on && p.error && p.keychainSuffix === "", bad + " must be refused: " + JSON.stringify(p));
  }
  const a = profile({ MCD_TEST_PROFILE: "/Users/x/Library/Application Support/MinimaCoreDesktop-TEST" }, REAL), b = profile({ MCD_TEST_PROFILE: "/tmp/other-test" }, REAL);
  assert.equal(a.error, ""); assert.match(a.keychainSuffix, /^\.test\.[0-9a-f]{64}$/); assert.notEqual(a.keychainSuffix, b.keychainSuffix, "one name per profile folder");
  const cfg = fs.readFileSync(path.join(ROOT, "main/config.js"), "utf8"), main = fs.readFileSync(path.join(ROOT, "main/main.js"), "utf8");
  assert.match(cfg, /const KEYCHAIN_SERVICE = "com\.eurobuddha\.minimacore\.rpc" \+ require\("\.\/testprofile"\)\.keychainSuffix;/, "every keychain read and write goes under the profile's own service name");
  assert.equal((cfg.match(/"com\.eurobuddha\.minimacore/g) || []).length, 1, "and there is one service name in the app");
  assert.ok(main.indexOf('require("./testprofile")') < main.indexOf('require("./config")') && main.indexOf('require("./testprofile")') < main.indexOf("requestSingleInstanceLock"), "the profile is set before the config, the keychain or the single-instance lock is touched");
  assert.match(main, /if \(!testProfile\.on\) updater\.start\(\);/, "a TEST copy does not read the update feed");
  assert.match(fs.readFileSync(path.join(ROOT, "main/loginitem.js"), "utf8"), /if \(process\.env\.MCD_TEST_PROFILE\) return \{ ok: false, on, note: "not registered: TEST profile" \};/);
});

test("dev-run.sh: refuses the real folder, a busy port and missing jars; copies jars only with --jars; fetches nothing; opens no debugging port", () => {
  const sh = fs.readFileSync(path.join(ROOT, "scripts/dev-run.sh"), "utf8");
  assert.ok(!/\b(curl|wget|gh |npm run fetch|remote-debugging-port)\b/.test(sh.replace(/^\s*#.*$/gm, "")), "it downloads nothing and opens no debugging port");
  assert.equal((sh.replace(/<<MSG[\s\S]*?\nMSG\n/, "").match(/^\s*cp /gm) || []).length, 1, "one copy, the --jars one (the copy commands in the refusal are text)");
  assert.ok(sh.indexOf('if [ -n "$JARS" ]; then') < sh.indexOf('cp "${found[0]}"') && sh.indexOf('cp "${found[0]}"') < sh.indexOf("\nfi\nmissing=0"), "and it is inside the --jars branch");
  for (const must of ["is, or is inside, the real install's folder", "contains the real install's folder", "was not created by this script", "something is already listening on port(s)", "12001 is the real app's default base port",
    "shasum -a 256", "minima-1.1.2.31-euro5.jar", "parlons-node-0.2.153.jar", "desktop/minimacore-desktop/resources/minima.jar", 'MCD_TEST_PROFILE="$PROFILE" exec "$ELECTRON" "$ROOT" --user-data-dir="$PROFILE"'])
    assert.ok(sh.includes(must), "dev-run.sh: " + must);
  assert.ok(sh.indexOf("for off in 0 1 2 3 4 584 586") < sh.indexOf('mkdir -p "$PROFILE"'), "the ports are probed before anything is created");
});
