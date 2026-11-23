// 0.19.418: a stranger's coin state can no longer become a node command through an engine. The node splits a command text on
// every ";" (StringTokenizer, quotes or not) and runs each piece: a PandaPools beacon whose state port 2 was
// `0x00;send … ;` made ONE runscript FOUR admin sends (the token appears 4 times in the covenant), and a P2P Chance taker's
// state 9 `0;SEND …` ran through auto-reveal (P2P Chance was removed in 0.19.419). These tests drive the REAL host shim (main/pandapools.js)
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
    if (v === 'runscript') return { status: true, response: { parseok: true, script: { address: hex(77) } } };
    if (v === 'coins' && p.includes('address:' + SENTINEL)) return { status: true, response: POISON.concat([beacon(MXUSD, hex(2), hex(1), '50')]) };
    if (v === 'keys') return { status: true, response: { publickey: '0x3FFDB1A06A2DCA90BEE0D7C0F5BA62B9AF23BF5D73A23D63555492F88D1E3828' } };
    return { status: true, response: [] };
  });
  const api = load('main/pandapools.js', { electron: { app: { getPath: () => dir, getVersion: () => 'test', isPackaged: false } }, './config': { rpcSecret: () => '' },
    './node-manager': { rpcPort: () => 0, health: { locked: false }, log() {} }, './rpc': { rpcCall: async () => { throw new Error('TEST LEAK: rpcCall'); } }, './netfetch': { fetchJson: async () => null },
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
  } finally { api.stopLoop(); for (const c of contexts) c.ActivityChain.stop(); for (const s of stores) { try { s.flush(); s._db.close(); } catch (e) {} } fs.rmSync(dir, { recursive: true, force: true }); }
});

test('main/rpc.js: under every caller, ";", CR, LF and NUL are refused before any connection, and the source is told', async () => {
  const V = require('../main/cmdverb'), rpc = require('../main/rpc'), told = [];
  V.onRefused((source, command) => told.push([source, command]));
  try {
    for (const c of ['status;' + SEND, 'runscript script:"RETURN TRUE;' + SEND + '"', 'status\n' + SEND, 'status\r', 'status\u0000']) {
      await assert.rejects(rpc.rpcCall(1, 'x', c, { owner: 'pandapools' }), (e) => e.message === V.UNSAFE);
      await assert.rejects(rpc.rpcRead(1, 'x', c), (e) => e.message === V.UNSAFE);
    }
    assert.equal(told.length, 5); assert(told.every(([s]) => s === 'pandapools'));
  } finally { V.onRefused(null); }
  assert.match(V.UNSAFE, /send the commands one at a time/);
});

test('the Terminal refuses a chain before any question, and the app notifies the source of every other refusal', () => {
  const src = fs.readFileSync(path.join(desktop, 'main/main.js'), 'utf8'), at = src.indexOf('ipcMain.handle("mcd:cmd"');
  assert(at > 0 && /^ipcMain\.handle\("mcd:cmd", async \(_e, command\) => \{\n  \{ const why = cmdverb\.refuse\("", command\); if \(why\) throw new Error\(why\); \}/.test(src.slice(at)), 'mcd:cmd refuses first');
  assert(src.includes('cmdverb.onRefused((source) =>'), 'a refusal from an app or engine is said in a notification');
  const pp = fs.readFileSync(path.join(desktop, 'main/pandapools.js'), 'utf8');
  assert(/async function migrate\(addr, newX, newY\) \{\n  await init\(\);\n  var p = poolByAddress\(addr\); if \(!p\) throw new Error\("Pool not found\."\);\n[^\n]*\n[^\n]*\n  if \(!isMarketFed\(p\.tok\)/.test(pp), 'migrate refuses a pool whose token is not MxUSD');
  for (const f of ['main/pandapools.js', 'main/atomix.js', 'main/dexicon.js']) assert(/require\("\.\/cmdverb"\)\.refuse\("/.test(fs.readFileSync(path.join(desktop, f), 'utf8')), f + ' refuses in its shim');
});
