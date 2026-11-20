/*
 * mail-peer-test.cjs — a peer's mail message is stored only as plain capped values (0.18.171). Electron, config and the
 * node manager are stood in for; nothing reaches a node.
 * Run: node --test scripts/mail-peer-test.cjs
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mail-peer-"));
const realLoad = Module._load, SECRETS = {}, LOG = [];
Module._load = function (request, parent) {
  if (request === "electron") return { app: { getPath: () => DIR, getVersion: () => "t" } };
  const from = parent && parent.filename || "";
  if (/[\\/]main[\\/]mail\.js$/.test(from) && request === "./config") return { getSecret: (a) => SECRETS[a] || null, setSecret: (v, a) => { SECRETS[a] = v; }, deleteSecret: () => {}, rpcSecret: () => "", load: () => ({}) };
  if (/[\\/]main[\\/]mail\.js$/.test(from) && request === "./node-manager") return { rpcPort: () => 0, log: (l) => LOG.push(l), on: () => {} };
  return realLoad.apply(this, arguments);
};
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });
const mail = require("../main/mail"), mc = require("../main/mailcrypto"), store = require("../main/mail-store");

test("a nested object, an oversized field or a bad picture is never stored as sent; the pass goes on; the store still saves", async () => {
  mail._setRunner(async (c) => c.startsWith("vault") ? { status: true, response: { locked: false, seed: "0x" + "11".repeat(32) } }
    : c.startsWith("getaddress") ? { status: true, response: { miniaddress: "MxG0" + "D".repeat(56) } } : { status: true, response: [] });
  const me = await mail.init(), peer = await mc.deriveIdentity("0x" + "22".repeat(32));
  const deep = "[".repeat(12000) + "]".repeat(12000);
  const base = { from: peer.publicId, to: me.publicId, date: Date.now(), type: "text" };
  const wire = (o) => JSON.stringify(o).split('"@@"').join(deep);
  const msgs = [
    wire(Object.assign({}, base, { randomid: "@@", subject: "@@", message: "nested", fromname: "@@" })),
    wire(Object.assign({}, base, { randomid: "r2", subject: "s", message: "@@", amount: "@@", tokenid: "@@", payaddr: "@@", image: "@@", date: "@@" })),
    JSON.stringify(Object.assign({}, base, { randomid: "r3", subject: "big", message: "m".repeat(60000), fromname: "n".repeat(500), type: "image", image: "<svg onload=x>", payaddr: "Mx address:0xEVIL" })),
    JSON.stringify(Object.assign({}, base, { randomid: "r4", subject: "ok", message: "hello", type: "payment", amount: "1.5", tokenid: "0x00", tokenname: "Minima", txpowid: "0x" + "AB".repeat(32), payaddr: "MxG0" + "E".repeat(56) }))];
  const coins = [];
  for (let i = 0; i < msgs.length; i++) coins.push({ coinid: "0xAA" + i, state: { "99": "0x" + await mc.seal(peer, me.publicId, Buffer.from(msgs[i])) } });
  const out = await mail._processCoins(coins, true);
  const got = store.all().filter(m => m.frompublickey === peer.publicId);
  const by = (rid) => got.find(m => m.randomid === rid);
  assert.equal(out.fresh, 3, "a message whose randomid is not a plain value is not stored; the pass reached the last coin");
  for (const m of got) for (const [k, v] of Object.entries(m)) assert.ok(v == null || ["string", "number", "boolean"].includes(typeof v), k + " is a plain value");
  const r2 = by("r2"); assert.equal(r2.message, ""); assert.equal(r2.amount, ""); assert.equal(r2.payaddr, ""); assert.equal(typeof r2.date, "number");
  const r3 = by("r3"); assert.equal(r3.message.length, 45000, "a message is cut at 45,000"); assert.equal(r3.fromname.length, 200); assert.equal(r3.image, "", "a picture is bare base64 or nothing"); assert.equal(r3.payaddr, "", "an address with a parameter in it is not kept");
  const r4 = by("r4"); assert.deepEqual([r4.message, r4.amount, r4.tokenid, r4.txpowid, r4.payaddr], ["hello", "1.5", "0x00", "0x" + "AB".repeat(32), "MxG0" + "E".repeat(56)], "a real message is whole");
  assert.equal(store.metaGet("pa:" + peer.publicId), "MxG0" + "E".repeat(56), "the pa: meta only ever holds a checked address");
  await new Promise(r => setTimeout(r, 400));   // the store's debounced save
  const disk = JSON.parse(fs.readFileSync(path.join(DIR, "mail.json"), "utf8"));
  assert.ok(Object.values(disk.messages).some(m => m.randomid === "r4"), "saved to disk");
});

test("a save that fails is logged, not swallowed", async () => {
  const errs = [], err = console.error, real = fs.writeFileSync; console.error = (...a) => errs.push(a.join(" "));
  fs.writeFileSync = () => { throw new Error("disk full"); };
  try { store.metaSet("k", 1); await new Promise(r => setTimeout(r, 400)); } finally { fs.writeFileSync = real; console.error = err; }
  assert.match(errs.join(), /\[mail\] mail\.json could not be saved \(retried on the next write\): disk full/);
});
