// 0.18.317 (as Pandamonium Desktop 0.19.418): a stranger's coin state can no longer become a node command through an engine. The node splits a command text on
// every ";" (StringTokenizer, quotes or not) and runs each piece: a PandaPools beacon whose state port 2 was
// `0x00;send … ;` made ONE runscript FOUR admin sends (the token appears 4 times in the covenant), and a P2P Chance taker's
// state 9 `0;SEND …` ran through auto-reveal. These tests drive the REAL host shims (main/pandapools.js, main/casino.js)
// over the REAL vendored engines against a stand-in node that splits commands exactly like the real one
// (scripts/node-standin.cjs), and the lowest layer (main/rpc.js) and the Terminal directly.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const { standin } = require('./node-standin.cjs');
const desktop = path.resolve(__dirname, '..');
const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(64, '0');
const ATTACKER = hex(666), SEND = 'send amount:1000 address:' + ATTACKER + ' tokenid:0x00', SENTINEL = '0x50414E4441504F4F4C53';
const MXUSD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';
const until = async (f, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const clean = (n) => { assert.deepEqual(n.sends(), [], 'an injected send ran'); assert(!n.texts.some((t) => /[;\r\n\u0000]/.test(t) || t.includes(ATTACKER) || /amount:1000\b/.test(t)), 'stranger text reached the node: ' + JSON.stringify(n.texts.filter((t) => t.includes(ATTACKER) || /[;\r\n]/.test(t)))); };

function load(file, stubs) {
  const exports = {}, sandbox = { module: { exports }, exports, console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, Buffer, process,
    require: (n) => (n in stubs ? stubs[n] : require(n.startsWith('./') ? path.join(desktop, 'main', n) : n)) };
  vm.runInNewContext(fs.readFileSync(path.join(desktop, file), 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}

test('PandaPools: poisoned sentinel beacons through the real Book.scan and the real desk shim send nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-inject-')), loader = require(path.join(desktop, 'main/pandapools/loader')), contexts = [], stores = [];
  const actualSql = require(path.join(desktop, 'main/pandapools/sqlshim'));
  const beacon = (p2, p3, p4, p5) => ({ coinid: hex(9), address: SENTINEL, amount: '0.000000001', tokenid: '0x00', created: '100', state: [{ port: 2, data: p2 }, { port: 3, data: p3 }, { port: 4, data: p4 }, { port: 5, data: p5 }] });
  const POISON = [beacon('0x00;' + SEND + ';', hex(2), hex(1), '50'), beacon(MXUSD, hex(2), '[x;' + SEND + ';]', '50'), beacon(MXUSD, hex(2), hex(1), '50;' + SEND), beacon(MXUSD, hex(2) + ' amount:1000', hex(1), '50')];
  const n = standin((p, v) => {
    if (v === 'block') return { status: true, response: { block: 1 } };
    if (v === 'status') return { status: true, response: { locked: false } };
    if (v === 'runscript') return { status: true, response: { parseok: true, script: { address: hex(77) } } };
    if (v === 'coins' && p.includes('address:' + SENTINEL)) return { status: true, response: POISON.concat([beacon(MXUSD, hex(2), hex(1), '50')]) };
    if (v === 'keys') return { status: true, response: { publickey: '0x3FFDB1A06A2DCA90BEE0D7C0F5BA62B9AF23BF5D73A23D63555492F88D1E3828' } };
    return { status: true, response: [] };
  });
  const api = load('main/pandapools.js', { electron: { app: { getPath: () => dir, getVersion: () => 'test', isPackaged: false } }, './config': { rpcSecret: () => '' },
    './node-manager': { rpcPort: () => 0, kind: () => 'minima', log() {} }, './rpc': { rpcCall: async () => { throw new Error('TEST LEAK: rpcCall'); } }, './netfetch': { fetchJson: async () => null },
    './pandapools/loader': { ...loader, createContext: (...a) => { const c = loader.createContext(...a); contexts.push(c); return c; } },
    './pandapools/sqlshim': { makeSqlShim: async (f) => { const s = await actualSql.makeSqlShim(f); stores.push(s); return s; } } });
  api._setDataDir(dir); api._setRunner(async (q) => new Promise((r) => n.cmd(q, r)));
  try {
    await api.init(); const ctx = contexts.at(-1); let pools = null;
    ctx.Book.scan((p) => { pools = p; });
    assert(await until(() => pools !== null), 'the scan finished');
    clean(n);
    assert.equal(n.ran.filter((p) => p.startsWith('runscript')).length >= 1, true);
    assert(n.ran.filter((p) => p.startsWith('runscript')).every((p) => p.includes(hex(1)) && p.includes(hex(2)) && p.includes(MXUSD)), 'only the honest beacon is derived');
    // and the engine's own wrapper refuses outright (nothing reaches the shim)
    n.texts.length = 0; const r = await new Promise((res) => ctx.MDS.cmd('runscript script:"RETURN TRUE;' + SEND + '"', res));
    assert.equal(r.status, false); assert.deepEqual(n.texts, []);
  } finally { try { api.stopLoop(); } catch (e) {} for (const c of contexts) c.ActivityChain.stop(); for (const s of stores) { try { s.flush(); s._db.close(); } catch (e) {} } fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P2P Chance: a taker\'s ";" in state 8-12 through the real desk shim and engine (auto-reveal, auto-resolve) sends nothing', async () => {
  const ME = hex(1), secrets = new Map();
  const coin = (phase, poison) => { const st = { 0: ME, 1: hex(2), 2: hex(3), 3: '2', 4: '2', 5: '1', 6: String(phase), 7: '256', 8: ME, 9: hex(4), 10: hex(5), 11: '0', 12: hex(6), ...poison };
    return { coinid: hex(9), address: '0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F', amount: '2', tokenid: '0x00', state: Object.keys(st).map((p) => ({ port: Number(p), data: st[p] })) }; };
  const n = standin((p, v) => v === 'hash' ? { status: true, response: { hash: hex(7) } } : v === 'keys' ? { status: true, response: [{ publickey: ME }] } : { status: true, response: {} });
  const casino = load('main/casino.js', { electron: { app: { getPath: () => os.tmpdir(), getVersion: () => 'test' } }, './config': { rpcSecret: () => '', getSecret: (k) => secrets.get(k) || hex(8), setSecret: (v, k) => { secrets.set(k, v); return true; }, deleteSecret() {} },
    './node-manager': { rpcPort: () => 0 } });
  casino._setRunner(async (q) => new Promise((r) => n.cmd(q, r)));
  await casino.init(); const ctx = casino._ctx(); vm.runInContext('MY_KEYS[' + JSON.stringify(ME) + ']=true', ctx);
  for (const poison of [{ 9: '0;' + SEND }, { 9: '0;SEND amount:1000 address:' + ATTACKER + ' tokenid:0x00' }, { 8: ME + ';' + SEND }, { 10: hex(5) + ';' + SEND }, { 12: hex(6) + ';' + SEND }, { 9: hex(4) + ' amount:1000' }]) {
    n.texts.length = 0; n.ran.length = 0;
    ctx.doReveal(coin(1, poison)); ctx.doResolve(coin(2, poison));
    await new Promise((r) => setTimeout(r, 30));
    clean(n);
  }
  // a clean bet still settles, as two commands (no ";" chain): txnbasics, then txnpost
  n.texts.length = 0; ctx.doReveal(coin(1, {})); await until(() => n.texts.some((t) => t.startsWith('txnpost id:')));
  assert(n.texts.some((t) => /^txnbasics id:svc_reveal_\d+$/.test(t)) && n.texts.some((t) => /^txnpost id:svc_reveal_\d+$/.test(t)));
});

test('main/rpc.js: under every caller, ";", CR, LF and NUL are refused before any connection, and the source is told', async () => {
  const V = require('../main/cmdverb'), rpc = require('../main/rpc'), told = [];
  V.onRefused((source, command) => told.push([source, command]));
  try {
    for (const c of ['status;' + SEND, 'runscript script:"RETURN TRUE;' + SEND + '"', 'status\n' + SEND, 'status\r', 'status\u0000']) {
      await assert.rejects(rpc.rpcCall(1, 'x', c), (e) => e.message === V.UNSAFE);
    }
    assert.equal(told.length, 5);
  } finally { V.onRefused(null); }
  assert.match(V.UNSAFE, /send the commands one at a time/);
});

test('the Terminal refuses a chain before any question, and the app notifies the source of every other refusal', () => {
  const src = fs.readFileSync(path.join(desktop, 'main/main.js'), 'utf8'), at = src.indexOf('ipcMain.handle("mcd:cmd"');
  assert(at > 0 && /^ipcMain\.handle\("mcd:cmd", async \(_e, command\) => \{\n  \{ const why = require\("\.\/cmdverb"\)\.refuse\("", command\); if \(why\) throw new Error\(why\); \}/.test(src.slice(at)), 'mcd:cmd refuses first');
  assert(src.includes('require("./cmdverb").onRefused((source) =>'), 'a refusal from an app or engine is said in a notification');
  for (const f of ['main/pandapools.js', 'main/atomix.js', 'main/casino.js']) assert(/require\("\.\/cmdverb"\)\.refuse\("|V\.refuse\("P2P Chance"/.test(fs.readFileSync(path.join(desktop, f), 'utf8')), f + ' refuses in its shim');
});

test('checkmode on the plain minima node kind is answered from `status` (writemode, and the wallet lock): PandaPools can write there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-checkmode-')), loader = require(path.join(desktop, 'main/pandapools/loader')), contexts = [], stores = [], sent = [];
  const actualSql = require(path.join(desktop, 'main/pandapools/sqlshim')); let locked = false;
  const api = load('main/pandapools.js', { electron: { app: { getPath: () => dir, getVersion: () => 'test' } }, './config': { rpcSecret: () => '' },
    './node-manager': { rpcPort: () => 0, kind: () => 'minima', log() {} }, './rpc': { rpcCall: async () => { throw new Error('TEST LEAK: rpcCall'); } }, './netfetch': { fetchJson: async () => null },
    './pandapools/loader': { ...loader, createContext: (...a) => { const c = loader.createContext(...a); contexts.push(c); return c; } },
    './pandapools/sqlshim': { makeSqlShim: async (f) => { const s = await actualSql.makeSqlShim(f); stores.push(s); return s; } } });
  api._setDataDir(dir);
  api._setRunner(async (q) => { sent.push(q); if (q === 'status') return { status: true, response: { locked } }; if (q === 'checkmode') return { status: false, error: 'Command not found' }; if (q === 'block') return { status: true, response: { block: 0 } }; if (q === 'getaddress') return { status: true, response: { address: hex(500) } }; return { status: false }; });
  try {
    await api.init(); const ctx = contexts.at(-1), ask = (q) => new Promise((r) => ctx.MDS.cmd(q, r));
    let r = await ask('getaddress'); assert.equal(r.status, true, JSON.stringify(r)); assert(!sent.includes('checkmode'), 'checkmode is answered by the host');
    locked = true; sent.length = 0; r = await ask('getaddress'); assert.equal(r.status, false); assert.match(r.error, /WALLET_LOCKED/); assert(!sent.includes('getaddress'));
  } finally { try { api.stopLoop(); } catch (e) {} for (const c of contexts) c.ActivityChain.stop(); for (const s of stores) { try { s.flush(); s._db.close(); } catch (e) {} } fs.rmSync(dir, { recursive: true, force: true }); }
});
