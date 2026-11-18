// The wallet's Consolidate must not run while a pool owner key cannot safely sign: core's `consolidate` picks its own
// input coins, so it could sign with that key (PandaPools Android: OwnerKeyRecovery.checkConsolidation).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const desktop = process.env.PP_DESKTOP_ROOT || path.resolve(__dirname, '..');
const actualSql = require(path.join(desktop, 'main/pandapools/sqlshim'));
const loader = require(path.join(desktop, 'main/pandapools/loader'));
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');

async function harness(keysReply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-consolidate-')), contexts = [], stores = [], commands = [];
  const exports = {};
  const sandbox = { module: { exports }, exports, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, require: (n) => {
    if (n === 'electron') return { app: { getPath: () => dir, getVersion: () => 'test' } };
    if (n === './config') return { rpcSecret: () => '' }; if (n === './node-manager') return { rpcPort: () => 0 };
    if (n === './rpc') return { rpcCall: async () => ({ status: false }) }; if (n === './netfetch') return { fetchJson: async () => null };
    if (n === './pandapools/loader') return { ...loader, createContext: (...args) => { const c = loader.createContext(...args); contexts.push(c); return c; } };
    if (n === './pandapools/sqlshim') return { makeSqlShim: async (file) => { const sql = await actualSql.makeSqlShim(file); stores.push(sql); return sql; } };
    return require(n);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(desktop, 'main/pandapools.js'), 'utf8'), sandbox, { filename: 'main/pandapools.js' });
  const api = sandbox.module.exports; api._setDataDir(dir);
  api._setRunner(async (q) => { commands.push(q); if (q === 'block') return { status: true, response: { block: 0 } }; if (q === 'keys') return keysReply(); return { status: false }; });
  return { api, contexts, commands, close: () => { api.stopLoop(); for (const c of contexts) c.ActivityChain.stop(); for (const sql of stores) { try { sql.flush(); sql._db.close(); } catch (e) {} } fs.rmSync(dir, { recursive: true, force: true }); } };
}
const pool = (c) => { const p = { address: hash(1), opk: hash(2), oadr: hash(3), tok: hash(4), tokDecimals: 8, kmin: '50', minimumOwnerUses: 846, signingStateUnverified: false }; p.script = c.Covenant.script(p.opk, p.oadr, p.tok, p.kmin); return p; };
const row = (uses) => ({ status: true, response: { keys: [{ publickey: hash(2), uses, size: 64, depth: 3 }] } });

test('no pools of ours: the wallet may consolidate', async () => {
  const h = await harness(() => ({ status: false }));
  try { assert.equal(await h.api.consolidationCheck(), null); } finally { h.close(); }
});

test('a pool owner key the node holds with a counter at or past its recorded floor: the wallet may consolidate', async () => {
  const h = await harness(() => row(900));
  try { await h.api.init(); const c = h.contexts.at(-1); assert(await new Promise((r) => c.Store.ownRecord(pool(c), r)));
    assert.equal(await h.api.consolidationCheck(), null); } finally { h.close(); }
});

test('the owner key counter has gone BACK below the recorded floor: consolidation is refused, with the reason', async () => {
  const h = await harness(() => row(10));
  try { await h.api.init(); const c = h.contexts.at(-1); assert(await new Promise((r) => c.Store.ownRecord(pool(c), r)));
    const why = await h.api.consolidationCheck();
    assert.match(why, /^Nothing consolidated: your wallet holds a pool owner key that cannot sign\./);
    assert.ok(why.length > 120, 'the engine\'s own explanation follows');
    assert.ok(!h.commands.some((q) => /^consolidate\b/.test(q)), 'the check itself never consolidates'); } finally { h.close(); }
});

test('the node cannot list its keys: consolidation is refused (fails closed)', async () => {
  const h = await harness(() => ({ status: false }));
  try { await h.api.init(); const c = h.contexts.at(-1); assert(await new Promise((r) => c.Store.ownRecord(pool(c), r)));
    assert.match(await h.api.consolidationCheck(), /^Nothing consolidated: /); } finally { h.close(); }
});
