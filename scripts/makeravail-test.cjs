"use strict";
// A failed balance read must never publish an AtomiX market as zero (review of minimaCore Desktop 0.18.328, MAJOR 2).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makerAvailFrom, ladderNeeds, saveThenPublish } = require("../main/makeravail");
test("publish: a balance that could not be read refuses; a real zero is zero; a withdraw still goes", () => {
  assert.deepEqual(makerAvailFrom({ minima: "12.5", usdt: "3" }, true), { minima: 12.5, usdt: 3 });
  assert.deepEqual(makerAvailFrom({ minima: "0", usdt: "0" }, true), { minima: 0, usdt: 0 });            // really empty
  assert.throws(() => makerAvailFrom({ minima: "0", usdt: "5", minimaErr: "RPC timeout" }, true), /could not be read.*RPC timeout.*nothing was published/);
  assert.throws(() => makerAvailFrom({ minima: "7", usdt: "—" }, true), /USDT balance could not be read/);
  assert.throws(() => makerAvailFrom(null, true), /could not be read/);
  assert.deepEqual(makerAvailFrom({ minima: "0", usdt: "—", minimaErr: "x" }, false), { minima: 0, usdt: 0 });   // tombstone
});

// 0.19.431 (independent review of 0.19.428, MINOR 11)
test("only the side the ladder uses must be readable: an ask-only market is not blocked by a failed USDT read", () => {
  assert.deepEqual(ladderNeeds({ pegEnable: true, size: 10, bidSize: 0 }, null), { minima: true, usdt: false });        // pegged, asks only
  assert.deepEqual(ladderNeeds({ pegEnable: true, size: 0, askSize: "", bidSize: "25" }, null), { minima: false, usdt: true });
  assert.deepEqual(ladderNeeds({ pegEnable: true, size: 10 }, null), { minima: true, usdt: true });                       // both fall back to size
  assert.deepEqual(ladderNeeds({ pegEnable: false }, { bids: [], asks: [{ p: 1.01, a: 5 }] }), { minima: true, usdt: false });
  assert.deepEqual(ladderNeeds({ pegEnable: false }, { bids: [{ p: 0.99, a: 5 }], asks: [{ p: 1.01, a: 0 }] }), { minima: false, usdt: true });
  assert.deepEqual(ladderNeeds({}, { bids: [], asks: [] }), { minima: true, usdt: true }, "no side at all: both, as before");
  const askOnly = { minima: true, usdt: false };
  assert.deepEqual(makerAvailFrom({ minima: "7", usdt: "—" }, true, askOnly), { minima: 7, usdt: 0 });
  assert.throws(() => makerAvailFrom({ minima: "0", usdt: "5", minimaErr: "RPC timeout" }, true, askOnly), /Minima-side balance could not be read.*RPC timeout/);
  assert.deepEqual(makerAvailFrom({ minima: "0", usdt: "5", minimaErr: "RPC timeout" }, true, { minima: false, usdt: true }), { minima: 0, usdt: 5 });
  assert.throws(() => makerAvailFrom({ minima: "7", usdt: "—" }, true, { minima: false, usdt: true }), /USDT balance could not be read/);
});
test("Save reads the balances first: a refused Save stores nothing; a good one saves, then publishes", async () => {
  const did = [], io = (b) => ({ read: async () => b, save: async () => { did.push("save"); }, publish: async (a) => { did.push(["publish", a]); } });
  await assert.rejects(saveThenPublish(io({ minima: "7", usdt: "—" }), { pegEnable: true, size: 10 }, null), /USDT balance could not be read.*nothing was published/);
  assert.deepEqual(did, [], "the new order was not stored (it was, before the read, up to 0.19.430)");
  await saveThenPublish(io({ minima: "7", usdt: "—" }), { pegEnable: true, size: 10, bidSize: 0 }, null);
  assert.deepEqual(did, ["save", ["publish", { minima: 7, usdt: 0 }]]);
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "atomix.js"), "utf8"), fn = src.slice(src.indexOf("async function makerSave("), src.indexOf("async function makerPublish("));
  assert.ok(/saveThenPublish\(\{ read: balances,/.test(fn) && fn.indexOf("saveConfig") > fn.indexOf("read: balances"), "makerSave goes through it");
});
