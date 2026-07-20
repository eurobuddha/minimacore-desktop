/*
 * loader.js — DESKTOP-ONLY glue (editable). Runs the Zero Edge Casino engine in a Node `vm` behind an `MDS`
 * shim, exactly the atomix/pandapools pattern.
 *
 *  - service.js is a BYTE-IDENTICAL copy of ~/Projects/Ideas/universal-casino/mds/service.js (the donor's headless
 *    auto-processor). It self-registers via MDS.init and, on each NEWBLOCK we fire, auto-reveals as house /
 *    auto-resolves as player. It must never be hand-edited (scripts/casino-parity-check.sh enforces it).
 *  - engine.js is the interactive half: the donor index.html's txn functions (createBet/takeBet/reveal/resolve/
 *    cancel/claimTimeout) lifted with the MDS.cmd command strings copied CHAR-FOR-CHAR, DOM/localStorage/SFX
 *    stripped, results returned via callback so the orchestrator can drive them over IPC. It does NOT call
 *    MDS.init (only service.js captures the event handler) and shares the SAME MDS shim — so a bet secret written
 *    by engine.createBet is the exact secret service.js reads to reveal. It exposes `global.CASINO`.
 *
 * As with atomix: the sandbox deliberately does NOT inject parent-realm ES intrinsics (the vm child realm has its
 * own; injecting the parent's breaks cross-realm checks). Only MDS/console/timers go in.
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const BASE = __dirname;

/** Build the vm context and boot both engine files. `mds` must provide: cmd, keypair.{get,set}, notify, log, init. */
function createContext(mds) {
  const sandbox = { MDS: mds, console, setTimeout, clearTimeout, setInterval, clearInterval };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);

  mds.load = function (rel) {
    const p = path.normalize(path.join(BASE, String(rel)));
    if (!p.startsWith(BASE + path.sep)) throw new Error("casino: load path escapes the module dir: " + rel);
    vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: "casino/" + rel });
  };

  // engine.js first (defines global.CASINO with identity + txn fns), then service.js (captures MDS.init handler).
  vm.runInContext(fs.readFileSync(path.join(BASE, "engine.js"), "utf8"), ctx, { filename: "casino/engine.js" });
  vm.runInContext(fs.readFileSync(path.join(BASE, "service.js"), "utf8"), ctx, { filename: "casino/service.js" });
  return ctx;   // ctx.CASINO = the interactive engine; the captured MDS.init handler drives service.js
}

module.exports = { createContext };
