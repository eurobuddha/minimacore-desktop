/*
 * loader.js — DESKTOP-ONLY glue (editable; everything else in this directory is a BYTE-IDENTICAL copy of
 * ~/Projects/atomix-mds and must never be hand-edited — scripts/atomix-parity-check.sh enforces it).
 *
 * Runs the AtomiX engine VERBATIM in a Node `vm` context behind an `MDS` shim, exactly the pandapools
 * pattern — with one twist that makes this even more faithful: the donor's `service.js` performs its OWN
 * module loading via `MDS.load(...)`, so we implement `MDS.load` (path-jailed to this directory) and execute
 * ONLY service.js; the engine then assembles itself in its own declared order. The same three events drive it
 * as on every other platform: `inited`, `NEWBLOCK`, `MDS_TIMER_60SECONDS` — fired by the orchestrator.
 *
 * As with pandapools: the sandbox deliberately does NOT inject parent-realm ES intrinsics (the vm child realm
 * has its own; injecting the parent's breaks cross-realm `instanceof`). Only MDS/console/timers go in.
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const BASE = __dirname;

/** Build the vm context and boot the engine: implement MDS.load, then run service.js verbatim.
 *  `mds` must provide: cmd, sql, net.{GET,POST}, notify, log, init (captures the event handler). */
function createContext(mds) {
  const sandbox = { MDS: mds, console, setTimeout, clearTimeout, setInterval, clearInterval };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);

  mds.load = function (rel) {
    const p = path.normalize(path.join(BASE, String(rel)));
    if (!p.startsWith(BASE + path.sep)) throw new Error("atomix: load path escapes the module dir: " + rel);
    vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: "atomix/" + rel });
  };

  vm.runInContext(fs.readFileSync(path.join(BASE, "service.js"), "utf8"), ctx, { filename: "atomix/service.js" });
  // Two donor modules the BROWSER loads that service.js doesn't (they're UI-side there): the wallet send core
  // and the swap-status report builder. The desktop orchestrator needs both — load them into the same context.
  mds.load("lib/wallet.js");
  mds.load("lib/inspect.js");
  return ctx;   // ctx.AX = the full engine; the captured MDS.init handler drives it
}

module.exports = { createContext };
