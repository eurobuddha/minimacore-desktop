/*
 * loader.js — DESKTOP-ONLY glue for the Dexicon engine (ported from DexiconPro main/dexicon/loader.js; the AtomiX
 * loader pattern). Runs service.desktop.js in a Node vm context; its MDS.load() is path-jailed to this directory, so
 * the verbatim lib/ crypto/ vendor/ resting/ files assemble themselves in the service's declared order. Only MDS,
 * console and timers go into the context: the engine's code has no `require`, `process` or `fs` NAME to use, and its
 * only ways out are the MDS stand-in's (main/dexicon.js: rpcCall, its own store, the relay and price allow-list).
 * THIS IS NOT A SECURITY BOUNDARY, and was wrongly described as one ("no process") until 0.18.110. MDS, console and
 * the timers are objects of the HOST realm: from any of them the engine's code can reach the host's Function
 * (`MDS.log.constructor("return process")()`), and with it everything this process can do. node:vm does not confine
 * code. What runs here is this app's own vendored engine, pinned byte for byte by the parity manifest; what it
 * receives from relays is parsed as data (JSON, hex) and never evaluated. A test holds this description true.
 * Not ported from DexiconPro: the two host hooks it injected (PandaPrice, its private MEXC feed, and DX_GATE, its
 * coordinator's last look). Here resting/price.js is the price source, as in the MiniDapp.
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const BASE = __dirname;

function createContext(mds) {
  const sandbox = { MDS: mds, console, setTimeout, clearTimeout, setInterval, clearInterval };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  mds.load = function (rel) {
    const p = path.normalize(path.join(BASE, String(rel)));
    if (!p.startsWith(BASE + path.sep)) throw new Error("dexicon: load path escapes the module dir: " + rel);
    vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: "dexicon/" + rel });
  };
  vm.runInContext(fs.readFileSync(path.join(BASE, "service.desktop.js"), "utf8"), ctx, { filename: "dexicon/service.desktop.js" });
  return ctx;   // ctx.AX = the FAST engine; ctx.PDService = the RESTING engine; ctx.DX = the service's read model
}

module.exports = { createContext };
