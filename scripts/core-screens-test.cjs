// The core screens rebuilt to Pandamonium's in Phase 2c (0.18.85+): Startup Params, Backup & Recovery, first run,
// Settings. Functions are lifted out of renderer/app.js and RUN; nothing here talks to a node, and every word
// used as a seed below is an obvious fake.
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const PARAMS = require("../renderer/params.js");

// a one-line definition, or a block that ends at the first "}" in column 0 (as scripts/wallet-money-test.cjs)
function source(name) {
  const m = app.match(new RegExp("\\n((?:async )?(?:const|function) " + name + "\\b[^\\n]*)")); assert.ok(m, name + " found in app.js");
  const code = m[1].replace(/\s+\/\/.*$/, "");
  return /\{$/.test(code) ? app.slice(m.index + 1, app.indexOf("\n}", m.index) + 2) : m[1];
}
function lift(names, env) {
  env = Object.assign({ MINIMA_PARAMS: PARAMS }, env || {});
  return new Function(...Object.keys(env), names.map(source).join("\n") + "; return { " + names.join(", ") + " };")(...Object.values(env));
}

test("Startup Params: a titled sub screen, opened from the menu and from the Node tab; the old wizard is not", () => {
  assert.ok(html.includes('id="view-params"'));
  assert.ok(/SUB_TITLE = \{[^}]*params: "Startup Params"/.test(app));
  assert.ok(app.includes('act === "params") selectTab("params")'));
  assert.ok(app.includes('el("nReconfig").onclick = () => selectTab("params")'));
  const body = source("renderParams");
  for (const words of ["Startup parameters", "Configure how the node starts. Changes take effect when the node restarts.", "Server mode (-server)",
    "MegaMMR (-megammr)", "Keets transport (-keets)", "Extra arguments (advanced)", ">Save<", "Save &amp; Restart Node", "Copy RPC password"])
    assert.ok(body.includes(words), "the phone's wording: " + words);
  assert.ok(!/Resync automatically/.test(body), "no auto-resync switch: the desktop has nothing behind it");
});

test("Startup Params saves node settings only: never a wallet field", () => {
  const { paramsPatch } = lift(["paramsPatch"]);
  const P = PARAMS.defaultParams();
  const r = paramsPatch({ net: "mainnet", server: true, basePort: "12001", rpcPort: "", dataFolder: "", customPeer: "", extraArgs: "-txpowdbstore 3", P }, { basePort: 9001 });
  assert.deepEqual(Object.keys(r.patch).sort(), ["basePort", "contribute", "customConnect", "dataFolder", "extraArgs", "network", "params", "rpcPortManual"]);
  assert.equal(r.patch.contribute, true);
  assert.equal(paramsPatch({ net: "solo", server: true, basePort: "x", rpcPort: "", P }, { basePort: 9001 }).patch.contribute, false, "a solo network never contributes");
  assert.equal(paramsPatch({ net: "solo", server: true, basePort: "x", rpcPort: "", P }, { basePort: 9001 }).patch.basePort, 9001);
  assert.ok(paramsPatch({ net: "custom", customPeer: "", P }, {}).error, "a custom network needs its peer");
});

test("Startup Params: the Server switch and the network preset fill the flags the wizard's did", () => {
  const { applyNetPreset } = lift(["applyNetPreset"]);
  const d = PARAMS.defaultParams();
  assert.deepEqual(applyNetPreset(Object.assign({}, d), "mainnet", false, "", ""), d, "mainnet and light wallet are the defaults");
  const c = applyNetPreset(Object.assign({}, d), "mainnet", true, "", "");
  assert.ok(c.server === true && c.isclient === false && c.mobile === false && c.nosyncibd === false, "contribute emits -server alone");
  const s = applyNetPreset(Object.assign({}, d), "solo", true, "", "");
  assert.ok(s.solo === true && s.isclient === false && s.server === false && s.p2pnodes === "");
  const x = applyNetPreset(Object.assign({}, d), "custom", false, "192.0.2.7:9001", "");
  assert.ok(x.connect === "192.0.2.7:9001" && x.p2pnodes === "");
});

test("the RPC password goes from the main process to the clipboard and is never handed to the page", () => {
  const main = fs.readFileSync(path.join(ROOT, "main", "main.js"), "utf8");
  assert.ok(/"mcd:copyRpcPassword", \(\) => \{ clipboard\.writeText\(config\.rpcSecret\(\)\); return true; \}/.test(main));
  assert.ok(!/(return|=>)\s*config\.rpcSecret\(\)/.test(main), "no handler returns the secret");
});
