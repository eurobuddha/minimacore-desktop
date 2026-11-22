// 0.19.383: main/pandapools.js carries one seam for the manual private-chain proof (scripts/e2e-pandapools-private-chain.cjs):
// _setCreateTokenForPrivateChainProof, the token createPool makes pools of (MxUSD does not exist on a throwaway -test chain).
// These tests hold that the packaged app cannot reach it, and that without it createPool still makes MxUSD pools only.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const desktop = process.env.PP_DESKTOP_ROOT || path.resolve(__dirname, '..');
const MXUSD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90', OTHER = '0x' + 'AB'.repeat(32);

function load(isPackaged) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-seam-')), sent = [];
  const sandbox = { module: { exports: {} }, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, require: (n) => {
    if (n === 'electron') return { app: { getPath: () => dir, getVersion: () => 'test', isPackaged } };
    if (n === './config') return { rpcSecret: () => '' };
    if (n === './node-manager') return { rpcPort: () => 0, health: { locked: false }, log() {} };
    if (n === './rpc') return { rpcCall: async () => { throw new Error('TEST LEAK: rpcCall'); } };
    if (n === './netfetch') return { fetchJson: async () => null };
    if (n.startsWith('./')) return require(path.join(desktop, 'main', n));
    return require(n);
  } };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(path.join(desktop, 'main/pandapools.js'), 'utf8'), sandbox, { filename: 'main/pandapools.js' });
  const api = sandbox.module.exports; api._setDataDir(dir);
  api._setRunner(async (q) => { sent.push(q); return { status: false, error: 'stand-in' }; });
  return { api, sent, close: () => { try { api.stopLoop(); } catch (e) {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('the seam is refused in a packaged app', () => {
  const h = load(true);
  try { assert.throws(() => h.api._setCreateTokenForPrivateChainProof(OTHER), /not available in a packaged app/); } finally { h.close(); }
});

test('without the seam createPool refuses any token but MxUSD before anything is sent', async () => {
  const h = load(false);
  try {
    h.api.init = async () => {};   // not reached: the refusal comes first
    await assert.rejects(h.api.createPool(OTHER, 8, '1', '1'), /MINIMA \/ MxUSD pools only/);
    assert.ok(!h.sent.some((q) => /^(newaddress|txn|tokens)/.test(q)), h.sent.join(' | '));
  } finally { h.close(); }
});

test('no app code path names the seam: only the proof script does', () => {
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (!/node_modules|\.git|dist/.test(f.name)) walk(p); } else if (/\.(c?js|html)$/.test(f.name) && fs.readFileSync(p, 'utf8').includes('_setCreateTokenForPrivateChainProof')) hits.push(path.relative(desktop, p)); } };
  for (const d of ['main', 'renderer', 'preload.js'].map((x) => path.join(desktop, x)).filter(fs.existsSync)) fs.statSync(d).isDirectory() ? walk(d) : (fs.readFileSync(d, 'utf8').includes('_setCreateTokenForPrivateChainProof') && hits.push(path.relative(desktop, d)));
  assert.deepEqual(hits, ['main/pandapools.js']);
  const pkg = require(path.join(desktop, 'package.json'));
  assert.ok(!Object.values(pkg.scripts).some((s) => s.includes('e2e-pandapools-private-chain')), 'the proof is never a package script (never in CI)');
  const files = (pkg.build && pkg.build.files) || [];
  assert.ok(files.length && !files.some((f) => /^(scripts|\*\*)/.test(String(f))), 'the packaged app takes main/, renderer/ and named modules only: never scripts/');
});
