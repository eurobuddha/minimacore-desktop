/*
 * keets-test.cjs — the keets integration holds together across its four pieces.
 *
 * keets rides on agreements between files that nothing type-checks: the params manifest must expose
 * the user flags but keep sidecar/runtime app-managed, node-manager must refuse every keets flag for
 * the Parlons jar (its embedded node line throws on unknown flags — startup death), the bundled jar
 * must actually contain the KeetsManager, and the sidecar bundle must exist where buildArgs points.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const KEETS_FLAGS = ['keets', 'keetssidecar', 'keetsnode', 'keetsbootstrap', 'keetsconnect', 'keetsmaxconns'];

test('params.js: user keets flags in the manifest, sidecar/runtime app-managed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/params.js'), 'utf8');
  for (const f of ['keets', 'keetsbootstrap', 'keetsconnect', 'keetsmaxconns']) {
    assert.ok(new RegExp('flag:\\s*"' + f + '"').test(src), `params.js must declare flag "${f}"`);
  }
  const managed = src.match(/var MANAGED = \[([^\]]*)\]/)[1];
  for (const f of ['keetssidecar', 'keetsnode']) {
    assert.ok(managed.includes('"' + f + '"'), `MANAGED must include "${f}"`);
  }
});

test('node-manager.js: both kinds wire keets; only sidecar/runtime stay app-managed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/node-manager.js'), 'utf8');
  const refused = src.match(/const PARLONS_REFUSED = new Set\(\[([\s\S]*?)\]\)/)[1];
  // 0.18.6: the pinned jar (0.2.124+) embeds the keets Minima line, so -keets and the
  // user tuning flags flow through to the Parlons kind; only the app-managed pair is refused.
  for (const f of ['keetssidecar', 'keetsnode']) {
    assert.ok(refused.includes('"' + f + '"'), `PARLONS_REFUSED must include "${f}"`);
  }
  for (const f of ['"keets"', '"keetsbootstrap"', '"keetsconnect"', '"keetsmaxconns"']) {
    assert.ok(!refused.includes(f), `PARLONS_REFUSED must NOT include ${f} (jar is keets-capable)`);
  }
  assert.ok(src.includes('"-keetssidecar"') && src.includes('"-keetsnode"'),
    'buildArgs must pass -keetssidecar and -keetsnode');
  // the parlons branch appends the same app-managed pair inside -Dparlons.node.args
  const parlons = src.match(/buildParlonsArgs\(cfg, dataDir\) \{([\s\S]*?)\n  \}/)[1];
  assert.ok(parlons.includes('-keetssidecar') && parlons.includes('-keetsnode')
      && parlons.includes('keets-sidecar'),
    'buildParlonsArgs must wire the bundled sidecar + Electron runtime');
});

test('0.18.16: KeetChat is this app\'s on BOTH kinds - the jar\'s keets bridge is told to stand down', () => {
  const nm = fs.readFileSync(path.join(ROOT, 'main/node-manager.js'), 'utf8');
  const parlons = nm.match(/buildParlonsArgs\(cfg, dataDir\) \{([\s\S]*?)\n  \}/)[1];
  assert.ok(parlons.includes('"-Dparlons.node.keetschat=off"'),
    'buildParlonsArgs must pass -Dparlons.node.keetschat=off (single-drainer rule: this app drains)');
  const chat = fs.readFileSync(path.join(ROOT, 'main/chat.js'), 'utf8');
  const start = chat.match(/function startLoop\(\) \{([\s\S]*?)\n\}/)[1];
  assert.ok(!/kind\(\) === "parlons"/.test(start), 'chat.startLoop must not gate on the parlons kind any more');
  const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert.ok(!/chatTab"\); if \(chtab\) chtab\.hidden = CFG\.nodeKind/.test(app),
    'renderer must not hide the Chat tab by node kind');
});

test('resources: sidecar source present, jar contains the keets classes', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'resources/keets-sidecar/index.js')), 'sidecar index.js bundled');
  assert.ok(fs.existsSync(path.join(ROOT, 'resources/keets-sidecar/package-lock.json')), 'its dependencies are pinned by a committed lockfile');
  const listing = execSync('unzip -l ' + path.join(ROOT, 'resources/minima.jar'), { encoding: 'utf8' });
  assert.ok(listing.includes('org/minima/system/network/keets/KeetsManager'),
    'resources/minima.jar must contain KeetsManager (keets-enabled build)');
});

// The sidecar's node_modules are never in git (scripts/fetch-keets-sidecar.sh installs them from the lockfile: a
// download). Until 0.18.141 this was one test with the two above, so it failed in every checkout that had not run
// the fetch, which hid nothing and proved nothing. A checkout without them cannot be PACKAGED, and that is what
// must fail: so the check is required in CI and wherever KEETS_REQUIRE_DEPS=1 (set it before a local release build),
// and says plainly that it was skipped anywhere else.
test('resources: sidecar dependencies installed (needed to package the app)', (t) => {
  const have = fs.existsSync(path.join(ROOT, 'resources/keets-sidecar/node_modules/hyperswarm'));
  if (!have && !process.env.CI && process.env.KEETS_REQUIRE_DEPS !== '1')
    return t.skip('resources/keets-sidecar/node_modules is not installed in this checkout: run `npm run fetch:keets` (a download) before packaging; KeetChat cannot start from this tree until then');
  assert.ok(have, 'hyperswarm bundled: run `npm run fetch:keets`');
});

test('package.json: sidecar ships via extraResources', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.extraResources.some(r => r.from === 'resources/keets-sidecar'),
    'extraResources must bundle resources/keets-sidecar');
});

// ---- 0.19.441: the Keets setting is one of three (chat and network, chat only, classic only), as on the phone ----
const PARAMS441 = require(path.join(ROOT, 'renderer/params.js'));

test('0.19.441: the setting owns -keets, -keetschatonly and -keetssidecarargs: refused when typed, dropped WITH their value when stored', () => {
  for (const typed of ['-keets', '-keetschatonly', '-KeetsChatOnly true', '--keetssidecarargs --chat-only', '-megammr -keetschatonly=true'])
    assert.ok(PARAMS441.reservedArg(typed), typed + ' must be refused in the extra arguments');
  for (const fine of ['-keetsconnect abc', '-keetsbootstrap h:1', '-keetsmaxconns 4', '-megammr', ''])
    assert.equal(PARAMS441.reservedArg(fine), '', fine + ' stays the user\'s');
  const strip = (s) => PARAMS441.withoutKeetsOwned(s.split(' ').filter(Boolean)).join(' ');
  assert.equal(strip('-megammr -keets false -archive'), '-megammr -archive', 'the value goes with the flag (the phone left "-megammr false")');
  assert.equal(strip('-keetschatonly true -keetsconnect abc'), '-keetsconnect abc');
  assert.equal(strip('-keetssidecarargs --chat-only -megammr'), '-megammr');
  assert.equal(strip('-keets -megammr'), '-megammr', 'a flag that follows is not taken for a value');
  assert.equal(strip('-keetssidecarargs -megammr -archive'), '-megammr -archive', '0.19.442: nor after -keetssidecarargs (0.19.441 swallowed -megammr)');
  assert.equal(strip('-keetssidecarargs x -megammr'), '-megammr');
  // 0.19.442: at node start a STORED value is not a reason to refuse (the start drops these flags); typed, it still is
  for (const stored of ['-keets', '-keetsmaxconns 4 -keets', '-keetschatonly', '-keetssidecarargs x']) assert.equal(PARAMS441.reservedArg(stored, true), '', stored);
  assert.equal(PARAMS441.reservedArg('-data /x', true), '-data', 'what the app manages is refused either way');
  assert.equal(strip('-keetsconnect abc -keetsmaxconns 4'), '-keetsconnect abc -keetsmaxconns 4', 'the user\'s keets flags are kept');
  // the three settings, and classic only winning over a stale chat-only value
  assert.equal(PARAMS441.keetsMode({ keets: true, keetschatonly: false }), 'full');
  assert.equal(PARAMS441.keetsMode({ keets: true, keetschatonly: true }), 'chat');
  assert.equal(PARAMS441.keetsMode({ keets: false, keetschatonly: true }), 'classic');
  assert.deepEqual(PARAMS441.setKeetsMode({}, 'chat'), { keets: true, keetschatonly: true });
  assert.deepEqual(PARAMS441.setKeetsMode({ keetschatonly: true }, 'classic'), { keets: false, keetschatonly: false });
  assert.deepEqual(PARAMS441.setKeetsMode({ keetschatonly: true }, 'full'), { keets: true, keetschatonly: false });
  assert.equal(PARAMS441.defaultParams().keetschatonly, false, 'a new install is chat and network, as before');
});

test('0.19.441: the bundled sidecar is 1.3.5 and knows --chat-only (the node passes it when it has -keetschatonly)', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'resources/keets-sidecar/index.js'), 'utf8');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/keets-sidecar/package.json'), 'utf8')).version, '1.3.5');
  assert.ok(idx.includes("process.argv.includes('--chat-only')"), 'index.js reads --chat-only');
});

test('0.19.441: what the node is started with, for the three settings, on both node kinds; chat only never without the capability', () => {
  const Module = require('module'), os = require('os');
  let USERDATA = '';
  const fakeElectron = { app: { getPath: () => USERDATA, isPackaged: false, getVersion: () => '0' }, safeStorage: null };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : realLoad.call(this, request, ...rest); };
  try {
    const config = require(path.join(ROOT, 'main/config.js')); config.rpcSecret = () => 'test-secret';
    const node = require(path.join(ROOT, 'main/node-manager.js')); node.blockKeysSupported = () => true;
    const argsOf = (kind, mode, capable, extraArgs) => {
      USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'keets-mode-test-'));
      config.keetsChatOnlySupported = () => capable;
      config.recordKeyMode('classic');
      config.save({ nodeKind: kind, setupDone: true, params: PARAMS441.setKeetsMode(PARAMS441.defaultParams(), mode) });
      if (extraArgs) {   // a value stored before the setting owned these flags: written past the save's refusal
        const f = path.join(USERDATA, 'config.json'), j = JSON.parse(fs.readFileSync(f, 'utf8')); j.extraArgs = extraArgs; fs.writeFileSync(f, JSON.stringify(j));
      }
      const a = node.buildArgs();
      return kind === 'minima' ? a.join(' ') : a.find(x => x.startsWith('-Dparlons.node.args=')).slice('-Dparlons.node.args='.length);
    };
    const count = (s, flag) => (s.match(new RegExp('(^|\\s)' + flag + '(?=\\s|$)', 'g')) || []).length;
    for (const kind of ['minima', 'parlons']) {
      const full = argsOf(kind, 'full', true), chat = argsOf(kind, 'chat', true), classic = argsOf(kind, 'classic', true);
      assert.deepEqual([count(full, '-keets'), count(full, '-keetschatonly'), count(full, '-keetssidecar')], [1, 0, 1], kind + ', chat and network: ' + full);
      assert.deepEqual([count(chat, '-keets'), count(chat, '-keetschatonly'), count(chat, '-keetssidecar')], [1, 1, 1], kind + ', chat only (the sidecar still runs): ' + chat);
      assert.deepEqual([count(classic, '-keets'), count(classic, '-keetschatonly'), count(classic, '-keetssidecar')], [0, 0, 0], kind + ', classic only: ' + classic);
      // a flavour whose jars do not know the flag is never given it: such a node refuses to start
      assert.equal(count(argsOf(kind, 'chat', false), '-keetschatonly'), 0, kind + ', no capability');
      // a stored extra argument cannot double the flag, bring it back, or hand the sidecar arguments
      const old = argsOf(kind, 'classic', true, '-keets -keetschatonly true -keetssidecarargs --chat-only -keetsmaxconns 4');
      assert.deepEqual([count(old, '-keets'), count(old, '-keetschatonly'), count(old, '-keetssidecarargs'), count(old, '--chat-only'), count(old, '-keetsmaxconns')], [0, 0, 0, 0, 1], kind + ', stored extras: ' + old);
      assert.equal(count(argsOf(kind, 'chat', true, '-keetschatonly'), '-keetschatonly'), 1, kind + ', not doubled');
    }
    assert.throws(() => config.save({ extraArgs: '-keetschatonly' }), /-keetschatonly cannot be set in the extra arguments/);
    // 0.19.442 (review of 0.19.441, MAJOR): the node START must not be refused for such a stored value. 0.19.441 said "is in the
    // extra arguments ... Remove it in Startup Params" and did not start the node; the test above called buildArgs past that gate.
    for (const kind of ['minima', 'parlons']) for (const extra of ['-keets', '-keetsmaxconns 4 -keets', '-keetschatonly', '-keetssidecarargs --chat-only']) {
      argsOf(kind, 'full', true, extra);
      assert.equal(node.keyModeProblem(), '', kind + ': the start is not refused for a stored ' + extra);
    }
    argsOf('minima', 'full', true, '-data /elsewhere');
    assert.match(node.keyModeProblem(), /-data is in the extra arguments/, 'a flag the app manages still stops the start');
  } finally { Module._load = realLoad; }
});

test('0.19.441: a flavour that says its jars know chat only has jars that do (asked without starting a node)', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { execFileSync } = require('child_process');
  let checked = 0;
  for (const [id, f] of Object.entries(pkg.flavors || {})) {
    if (f.keetsChatOnly !== true) continue;
    assert.ok(f.jars && f.jars.dir, id + ' names its jars');
    for (const jar of ['minima.jar', 'parlons-node.jar']) {
      const file = path.join(ROOT, f.jars.dir, jar);
      if (!fs.existsSync(file)) continue;   // the flavour's jars are not in git (scripts/build-flavor.cjs checks their sha256 at build)
      const keys = execFileSync('unzip', ['-p', file, 'org/minima/system/params/ParamConfigurer$ParamKeys.class'], { maxBuffer: 1 << 24 }).toString('latin1');
      assert.ok(keys.includes('keetschatonly'), id + '/' + jar + ' must know -keetschatonly');
      const mgr = execFileSync('unzip', ['-p', file, 'org/minima/system/network/keets/KeetsManager.class'], { maxBuffer: 1 << 24 }).toString('latin1');
      assert.ok(mgr.includes('--chat-only'), id + '/' + jar + ' must hand --chat-only to the sidecar it starts');
      checked++;
    }
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).flavors.pandamonium.keetsChatOnly, true);
  if (!checked) t.skip('the flavour\'s jars are not in this checkout (not in git): nothing to open');
});

// 0.19.442 (review of 0.19.441, MAJOR): the page keeps the config a SAVE answers with; without the capability on it the three options
// turned back into the on/off switch after any save (a new wallet, the theme, plain Save), until the app was started again
test('0.19.442: the page is told the chat-only capability on every config it gets, the answer of a save too; a -conf file cannot set the owned flags', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  assert.ok(/ipcMain\.handle\("mcd:getConfig"[^\n]*c\.keetsChatOnly = config\.keetsChatOnlySupported\(\); return c;/.test(main), 'getConfig');
  const save = main.slice(main.indexOf('function saveConfigPatch(patch) {'), main.indexOf('\n}', main.indexOf('function saveConfigPatch(patch) {')));
  assert.ok(/c\.keetsChatOnly = !!\(config\.keetsChatOnlySupported && config\.keetsChatOnlySupported\(\)\);[^\n]*\n\s*return c;\s*$/.test(save), 'saveConfigPatch answers with it');
  // and for real: the function lifted out of main.js, with a config that has the capability
  const lifted = new Function('config', 'notBusy', 'nativeTheme', 'reserveMode', 'loginitem', 'app', 'NODE_START_KEYS', 'let firstRunOpen = false;\n' + save + '\n}\nreturn saveConfigPatch;')(
    { save: (p) => Object.assign({ theme: 'system' }, p), keetsChatOnlySupported: () => true, themeSource: () => 'system' }, () => {}, {}, () => {}, { apply: () => ({}) }, {}, []);
  assert.equal(lifted({ labels: {} }).keetsChatOnly, true, 'a save of anything answers with the capability');
  const km = fs.readFileSync(path.join(ROOT, 'main/keymode.js'), 'utf8');
  assert.ok(km.includes('PARAMS.MANAGED.concat(["conf"], PARAMS.KEETS_OWNED)'), 'the -conf file check knows the three owned names');
  assert.ok(km.includes('PARAMS.reservedArg(o.extraArgs, true)'), 'the start gate reads the stored value as stored');
});

test('classic incoming excludes Keets, outgoing, invalid, disconnected and self connections', () => {
  const {classicIncoming} = require('../renderer/params');
  const peer = {incoming:true, valid:true, isconnected:true, host:'192.0.2.7'};
  const connections = [peer, {...peer,host:'192.0.2.8'}, {...peer,keets:true}, {...peer,host:'127.113.1.2'},
    {...peer,host:'::ffff:127.0.0.1'}, {...peer,host:'198.51.100.9'}, {...peer,valid:false},
    {...peer,isconnected:false}, {...peer,incoming:false}];
  assert.equal(classicIncoming({details:{p2p:{address:'198.51.100.9:9001'}},connections}), 2);
  assert.equal(classicIncoming({connections:[]}), 0);
  assert.equal(classicIncoming(null), null);
});

test('an incoming Keets bridge counts only until either end disconnects', () => {
  const {EventEmitter} = require('node:events');
  const diag = require('../resources/keets-sidecar/diag');
  const conn = new EventEmitter(), tcp = new EventEmitter(), other = new EventEmitter(), otherTcp = new EventEmitter();
  const count = () => diag().bridge.incomingActive;
  assert.equal(count(),0);
  diag.trackIncomingBridge(conn,tcp);
  diag.trackIncomingBridge(other,otherTcp);
  assert.equal(count(),2);
  tcp.emit('close');
  assert.equal(count(),1);
  conn.emit('end');conn.emit('close');
  assert.equal(count(),1);
  other.emit('end');
  assert.equal(count(),0);
  otherTcp.emit('close');
  diag.trackIncomingBridge(Object.assign(new EventEmitter(),{destroyed:true}),new EventEmitter());
  assert.equal(count(),0);
});

test('the incoming Keets bridge preserves a fragmented greeting while the local socket opens', async (t) => {
  const { EventEmitter } = require('node:events');
  const { Duplex } = require('node:stream');
  const { setImmediate: nextTurn } = require('node:timers/promises');
  const { createRequire } = require('node:module');
  const entry = path.join(ROOT, 'resources/keets-sidecar/index.js');
  const { Duplex: PeerStream } = createRequire(entry)('streamx');
  const source = fs.readFileSync(entry, 'utf8');
  // Exercise the shipped connection handler with control over when the TCP connect event fires.
  const handler = source.slice(source.indexOf('let conns ='), source.indexOf('const topic = sha256'));
  const swarm = new EventEmitter();
  const received = [];
  const tcp = new Duplex({ read() {}, write(chunk, _, done) { received.push(Buffer.from(chunk)); done(); } });
  const conn = new PeerStream({ write(_, done) { done(null); } });
  const header = Buffer.from('local preamble');
  const diagSnapshot = { trackIncomingBridge() {}, bridgeClosed() {} };
  require('node:vm').runInNewContext(handler, { swarm, Buffer, setTimeout, clearTimeout, PORT: 9001,
    MAXCONNS: 6, CHAT_ONLY: false, net: { connect: () => tcp }, preamble: () => header,
    diagSnapshot, console: { log() {} } });
  t.after(() => { conn.destroy(); tcp.destroy(); });
  const chunks = Array.from({length: 4}, (_, i) => Buffer.alloc(10000, i));
  swarm.emit('connection', conn, {publicKey: Buffer.alloc(32)});
  conn.push(chunks[0]);
  await nextTurn();
  conn.push(chunks[1]);
  conn.push(chunks[2]);
  await nextTurn();
  tcp.emit('connect');
  conn.push(chunks[3]);
  await nextTurn();
  assert.deepEqual(Buffer.concat(received), Buffer.concat([header, ...chunks]));
});
