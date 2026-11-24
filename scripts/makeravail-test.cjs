"use strict";
// A failed balance read must never publish an AtomiX market as zero (review of minimaCore Desktop 0.18.328, MAJOR 2).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makerAvailFrom } = require("../main/makeravail");
test("publish: a balance that could not be read refuses; a real zero is zero; a withdraw still goes", () => {
  assert.deepEqual(makerAvailFrom({ minima: "12.5", usdt: "3" }, true), { minima: 12.5, usdt: 3 });
  assert.deepEqual(makerAvailFrom({ minima: "0", usdt: "0" }, true), { minima: 0, usdt: 0 });            // really empty
  assert.throws(() => makerAvailFrom({ minima: "0", usdt: "5", minimaErr: "RPC timeout" }, true), /could not be read.*RPC timeout.*nothing was published/);
  assert.throws(() => makerAvailFrom({ minima: "7", usdt: "—" }, true), /USDT balance could not be read/);
  assert.throws(() => makerAvailFrom(null, true), /could not be read/);
  assert.deepEqual(makerAvailFrom({ minima: "0", usdt: "—", minimaErr: "x" }, false), { minima: 0, usdt: 0 });   // tombstone
});
