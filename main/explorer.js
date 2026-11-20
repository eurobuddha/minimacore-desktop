/*
 * explorer.js — what Minima Explorer may ask the node (main process). After Pandamonium's Minima Explorer
 * (apks/base integrated/blockexplorer, 1c60c2593325f70cba5089e2ba430925d6ccca3c; standalone apks/blockexplorer 0.1.10).
 *
 * READ ONLY, and a fixed list: the seven reads the original sends, each built HERE from a checked argument. The screen
 * names a kind and one value; it never hands over a command. The search box is free text, so a value that is not a
 * whole number, a 0x hex string or an Mx address never reaches a command string (a space or a `;` would add
 * parameters or a second command).
 *
 * BOUNDED: one block per `txpow block:`, one record per `txpow txpowid:`. `txpow address:` answers with every record
 * the node still holds for that address, which nothing in the command bounds: the answer is cut here to the first
 * ADDRESS_MAX records and the total is said, so the page never has to draw a list of any length. There is no `coins`
 * and no history scan.
 */
"use strict";
const NUM = /^[0-9]{1,15}$/, HEX = /^0x[0-9a-fA-F]{1,128}$/, MX = /^Mx[0-9A-Za-z]{10,128}$/;
const ADDRESS_MAX = 200;
const KINDS = {
  tip: () => "block",
  status: () => "status",
  info: () => "txpow action:info",
  block: (a) => (NUM.test(a) ? "txpow block:" + a : null),
  txpow: (a) => (HEX.test(a) ? "txpow txpowid:" + a : null),
  onchain: (a) => (HEX.test(a) ? "txpow onchain:" + a : null),
  address: (a) => (HEX.test(a) || MX.test(a) ? "txpow address:" + a : null)
};
/** The node command for one read, or null when the kind is unknown or the value is not of its shape. */
function command(kind, arg) {
  if (!Object.hasOwn(KINDS, kind)) return null;
  return KINDS[kind](typeof arg === "string" ? arg : "");
}
/** One read. run(command) → the node's reply (through rpcCall). → the reply as the node gave it; an address list is cut to ADDRESS_MAX. */
async function ask(kind, arg, run) {
  const c = command(kind, arg);
  if (!c) throw new Error("Not a block number, a TxPoW ID or an address.");
  const j = await run(c);
  if (kind === "address" && j && Array.isArray(j.response) && j.response.length > ADDRESS_MAX) return Object.assign({}, j, { response: j.response.slice(0, ADDRESS_MAX), total: j.response.length });
  return j;
}
module.exports = { command, ask, ADDRESS_MAX, KINDS: Object.keys(KINDS) };
