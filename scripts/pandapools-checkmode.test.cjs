// 0.19.377: `checkmode` is an MDS command. The node jars this app runs (the block line and the plain minima.jar) answer it
// {status:false, error:"Command not found"}, and the vendored engine's write guard (main/pandapools/runtime-guard.js) then
// refused EVERY write without sending it ("could not get a payout address") and paused the background service at every
// block. The host shim (main/pandapools.js buildMds) answers it itself. These tests run the REAL main/pandapools.js shim
// over the REAL vendored engine, against a stand-in node that answers as those jars do.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const desktop = process.env.PP_DESKTOP_ROOT || path.resolve(__dirname, '..');
const actualSql = require(path.join(desktop, 'main/pandapools/sqlshim'));
const loader = require(path.join(desktop, 'main/pandapools/loader'));
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const good = (response) => ({ status: true, pending: false, response });
const NOT_FOUND = { command: 'checkmode', status: false, pending: false, error: 'Command not found' };   // what the block jars answer

/** health: what node-manager's status poll last read ({ locked } or null). */
async function harness(health) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-checkmode-')), contexts = [], stores = [], sent = [], logged = [];
  const nodeStub = { rpcPort: () => 0, health: health === undefined ? { locked: false } : health, log: (l) => logged.push(String(l)) };
  const exports = {};
  const sandbox = { module: { exports }, exports, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, require: (n) => {
    if (n === 'electron') return { app: { getPath: () => dir, getVersion: () => 'test' } };
    if (n === './config') return { rpcSecret: () => '' }; if (n === './node-manager') return nodeStub;
    if (n === './rpc') return { rpcCall: async () => { throw new Error('TEST LEAK: rpcCall'); } }; if (n === './netfetch') return { fetchJson: async () => null };
    if (n === './pandapools/loader') return { ...loader, createContext: (...args) => { const c = loader.createContext(...args); contexts.push(c); return c; } };
    if (n === './pandapools/sqlshim') return { makeSqlShim: async (file) => { const sql = await actualSql.makeSqlShim(file); stores.push(sql); return sql; } };
    return require(n);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(desktop, 'main/pandapools.js'), 'utf8'), sandbox, { filename: 'main/pandapools.js' });
  const api = sandbox.module.exports; api._setDataDir(dir);
  const wallet = [{ coinid: hash(50), address: hash(51), tokenid: '0x00', amount: '1000', tokenamount: '1000', spent: false, state: [], created: 1 }];
  api._setRunner(async (q) => {
    sent.push(q);
    if (q === 'checkmode') return NOT_FOUND;
    if (q === 'block') return good({ block: 0 });
    if (q === 'getaddress') return good({ address: hash(500), publickey: hash(501), miniaddress: 'MxPAYOUT' });
    if (q.startsWith('coins relevant:true sendable:true')) return good(wallet);
    // As the real node: found only by the address exactly as the coins carry it (case-SENSITIVE lookup).
    if (q.startsWith('scripts address:')) { const a = q.slice('scripts address:'.length); return wallet.some(c => c.address === a) ? good({ address: a, simple: true, publickey: hash(501) }) : { status: false, pending: false, error: 'Script with that address not found' }; }
    if (/^txn(create|input|output|state|delete|basics)/.test(q)) return good({});
    return { status: false, pending: false, error: 'stand-in: ' + q.split(' ')[0] };
  });
  return { api, contexts, sent, logged, nodeStub, ctx: () => contexts.at(-1),
    close: () => { api.stopLoop(); for (const c of contexts) c.ActivityChain.stop(); for (const sql of stores) { try { sql.flush(); sql._db.close(); } catch (e) {} } fs.rmSync(dir, { recursive: true, force: true }); } };
}
const until = async (f, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const ask = (ctx, q) => new Promise((r) => ctx.MDS.cmd(q, r));   // ctx.MDS.cmd is the guard's wrapper over the host shim

test('a write command passes the real guard and reaches the node; checkmode is answered by the host, never sent', async () => {
  const h = await harness();
  try {
    await h.api.init();
    const r = await ask(h.ctx(), 'getaddress');
    assert.equal(r.status, true, JSON.stringify(r));
    assert.equal(r.response.address, hash(500));
    assert.ok(h.sent.includes('getaddress'), 'getaddress reached the node');
    assert.ok(!h.sent.includes('checkmode'), 'checkmode is not a command of these node jars: it is never sent');
    const lf = h.api.lastNodeFailure(); assert.ok(!(lf && lf.guard), 'no refusal of the guard: ' + JSON.stringify(lf));
  } finally { h.close(); }
});

test('the background service becomes READY (it was paused at every block)', async () => {
  const h = await harness();
  try {
    await h.api.init();
    assert.ok(await until(() => vm.runInContext('READY', h.ctx()) === true), 'service.js READY');
    assert.equal(h.api.status().paused, '');
    assert.ok(!h.logged.some((l) => /paused/.test(l)), h.logged.join(' | '));
  } finally { h.close(); }
});

test('a swap build goes past the payout-address step', async () => {
  const h = await harness();
  try {
    await h.api.init();
    const c = h.ctx(), D = c.Decimal;
    const pool = { address: hash(10), oadr: hash(11), opk: hash(12), tok: hash(13), kmin: '50', coinidM: hash(14), coinidT: hash(15) };
    const route = { ok: true, pairAddresses: [pool.address], totalIn: new D(10), totalOut: new D('0.03'), allocs: [{ pool, quote: { newX: new D(1010), newY: new D('2.97') } }] };
    const fail = await new Promise((r) => c.PoolMgr.swap(route, true, { ok: () => r(null), fail: r }));
    assert.notEqual(fail, 'could not get a payout address');
    const at = h.sent.indexOf('getaddress');
    assert.ok(at >= 0 && h.sent.slice(at + 1).some((q) => q.startsWith('coins checkmempool:true coinid:' + pool.coinidM)), 'the build goes on to the pool\'s coins after the payout address: ' + h.sent.join(' | '));
  } finally { h.close(); }
});

test('a password-locked node (status "locked"): the guard refuses, the reason is kept for the screen, the pause is said once in the node log, and lifts', async () => {
  const h = await harness({ locked: true });
  try {
    await h.api.init();
    const r = await ask(h.ctx(), 'getaddress');
    assert.equal(r.status, false); assert.match(r.error, /^WALLET_LOCKED/);
    assert.ok(!h.sent.includes('getaddress'), 'nothing reached the node');
    const why = h.api.lastNodeFailure(); assert.equal(why.guard, true); assert.match(why.error, /^WALLET_LOCKED/);
    assert.ok(await until(() => /WALLET_LOCKED/.test(h.api.status().paused)), 'status() says the service is paused');
    assert.equal(h.logged.filter((l) => /^\[pandapools\] paused: WALLET_LOCKED/.test(l)).length, 1, h.logged.join(' | '));
    h.nodeStub.health = { locked: false };
    assert.equal((await ask(h.ctx(), 'getaddress')).status, true);
    assert.equal(h.api.status().paused, '');
    assert.ok(h.logged.includes('[pandapools] running again'));
  } finally { h.close(); }
});
