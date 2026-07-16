/*
 * loader.js — runs the byte-identical PandaPools MDS modules (decimal.js / covenant.js / curve.js / router.js /
 * book.js / store.js / poolmgr.js / service.js, copied verbatim from ~/Projects/pandapools-mds for 3-way parity)
 * inside ONE shared V8 vm context, with a small `MDS` shim injected so the reused code runs UNMODIFIED.
 *
 * The MDS files are browser/MDS-runtime globals (`var Covenant = (function(){…})()`), so evaluating them in a vm
 * context in the same order index.html loads them wires the globals together exactly like the MiniDapp:
 *   decimal.js → Decimal ; covenant.js → Covenant ; curve.js → PP,Curve ; router.js → Router ;
 *   book.js → Book ; store.js → Store ; poolmgr.js → PoolMgr ; service.js → its NEWBLOCK worker.
 * Reuse rule: NEVER edit those files here — the runtime differences live entirely in the injected `MDS` shim.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// index.html load order (minus mds.js, which the shim replaces).
const ALL_FILES = ["decimal.js", "covenant.js", "curve.js", "router.js", "book.js", "store.js", "poolmgr.js", "service.js"];

/**
 * Build a vm context with the given `mds` shim and evaluate `files` (default: all) in order.
 * Returns the context object; read `ctx.Covenant`, `ctx.Book`, `ctx.PoolMgr`, `ctx.Store`, `ctx.Curve`,
 * `ctx.Router`, `ctx.PP` to drive the reused code.
 */
function createContext(mds, files) {
  const sandbox = {
    MDS: mds,
    console: console,
    // decimal.js + the reused modules only touch pure JS built-ins; expose the ones a vm context lacks by default.
    Math: Math, JSON: JSON, Date: Date, parseInt: parseInt, parseFloat: parseFloat,
    isNaN: isNaN, isFinite: isFinite, Array: Array, Object: Object, String: String, Number: Number,
    Boolean: Boolean, Error: Error, RegExp: RegExp, setTimeout: setTimeout, clearTimeout: clearTimeout,
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  (files || ALL_FILES).forEach((f) => {
    const code = fs.readFileSync(path.join(__dirname, f), "utf8");
    vm.runInContext(code, ctx, { filename: "pandapools/" + f });
  });
  return ctx;
}

module.exports = { createContext, ALL_FILES };
