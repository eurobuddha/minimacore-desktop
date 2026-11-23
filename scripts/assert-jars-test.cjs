// 0.18.321: scripts/assert-jars.sh checks a directory it is given (the built app's Contents/Resources from scripts/verify-mac.sh), and
// every way to build an installer runs it: dist, dist:mac, dist:win, dist:linux, dist:mac:signed and CI.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const D = path.resolve(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(D, f), "utf8");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("assert-jars.sh checks the directory it is given, and refuses a jar that is not the pin there", () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "jars-")), good = { p: Buffer.from("parlons pinned"), m: Buffer.from("minima pinned") };
  try {
    fs.mkdirSync(path.join(T, "scripts")); fs.copyFileSync(path.join(D, "scripts/assert-jars.sh"), path.join(T, "scripts/assert-jars.sh"));
    fs.writeFileSync(path.join(T, "package.json"), JSON.stringify({ parlonsNodeSha256: sha(good.p), minimaJarSha256: sha(good.m) }));
    const put = (dir, p, m) => { fs.mkdirSync(path.join(T, dir), { recursive: true }); fs.writeFileSync(path.join(T, dir, "parlons-node.jar"), p); fs.writeFileSync(path.join(T, dir, "minima.jar"), m); };
    put("resources", Buffer.from("stale 0.2.152"), good.m);
    put("App.app/Contents/Resources", good.p, good.m);
    put("Stale.app/Contents/Resources", good.p, Buffer.from("old minima"));
    const run = (...a) => spawnSync("bash", [path.join(T, "scripts/assert-jars.sh"), ...a], { encoding: "utf8" });
    assert.equal(run().status, 1, "resources/ holds a stale jar");
    assert.equal(run(path.join(T, "App.app/Contents/Resources")).status, 0, "the app's jars are the pinned ones");
    const r = run(path.join(T, "Stale.app/Contents/Resources")); assert.equal(r.status, 1); assert.match(r.stdout, /FAIL .*minima\.jar/);
    assert.equal(run(path.join(T, "nowhere")).status, 1, "a missing jar fails");
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test("every installer build runs the check, verify-mac checks the jars inside the app, CI runs it after the fetch", () => {
  const s = JSON.parse(rd("package.json")).scripts;
  for (const k of ["dist", "dist:mac", "dist:win", "dist:linux"]) assert.match(s[k], /^bash scripts\/assert-jars\.sh && electron-builder /, k);
  assert.match(s["dist:mac:signed"], /npm run dist:mac/);
  assert.match(rd("scripts/verify-mac.sh"), /\nbash scripts\/assert-jars\.sh "\$APP\/Contents\/Resources" \|\|/);
  const ci = rd(".github/workflows/desktop-build.yml"), fetch = ci.indexOf("run: bash scripts/fetch-parlons-node-jar.sh"), check = ci.indexOf("run: bash scripts/assert-jars.sh"), build = ci.indexOf("npx electron-builder");
  assert.ok(fetch > 0 && check > fetch && build > check, "CI: fetch, then the check, then the build");
});
