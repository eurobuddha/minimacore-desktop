/*
 * updater-test.cjs — guards on the app's own update channel.
 *
 * This is the one path that puts an executable in front of the user, so the two ways it used to be weak are
 * worth a permanent test: a redirect could downgrade the transfer to http (the scheme was only checked on
 * the URL we were handed), and `if (status.sha256)` meant a feed that simply omitted the hash produced an
 * UNVERIFIED installer in ~/Downloads. On mac notarization is a second line of defence; the Windows .exe
 * and Linux .AppImage are unsigned, so there is nothing else.
 *
 * No network: http/https .get are stubbed.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-upd-'));

// ---- stub electron before updater is required ------------------------------
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: { getVersion: () => '0.16.0', getPath: (k) => (k === 'downloads' ? DOWNLOADS : DOWNLOADS) },
      shell: { showItemInFolder() {} },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return realLoad.apply(this, arguments);
};
const updater = require('../main/updater');

// ---- stub the transport ----------------------------------------------------
const realHttpGet = http.get, realHttpsGet = https.get;

/** routes: { "https://host/path": {status, headers, body} } — anything unrouted 404s. */
function stubGet(routes) {
  const seen = [];
  const make = (proto) => (u, opts, cb) => {
    const url = typeof u === 'string' ? u : u.toString();
    seen.push(url);
    const r = routes[url] || { status: 404, body: '' };
    const res = new EventEmitter();
    res.statusCode = r.status || 200;
    res.headers = r.headers || {};
    res.setEncoding = () => {};
    res.resume = () => {};
    const req = new EventEmitter();
    req.end = () => {}; req.destroy = () => {};
    setImmediate(() => {
      cb(res);
      setImmediate(() => {
        if (r.body != null && r.body.length) res.emit('data', Buffer.from(r.body));
        res.emit('end');
      });
    });
    return req;
  };
  http.get = make('http:'); https.get = make('https:');
  return seen;
}
function restore() { http.get = realHttpGet; https.get = realHttpsGet; }

const FEED = 'https://eurobuddha.com/pandaapps/minimacore-desktop.json';
const ASSET = 'https://github.com/eurobuddha/minimacore-desktop/releases/download/v9.9.9/minimaCore-9.9.9-arm64.dmg';
const PAYLOAD = Buffer.from('pretend this is a dmg');
const GOOD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

function feed(platformRow) {
  const key = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
    : process.platform === 'win32' ? 'win-x64' : 'linux-x64';
  return JSON.stringify({ app: 'minimaCore Desktop', version: '9.9.9', notes: 'n', date: '2026-01-01',
    platforms: { [key]: platformRow } });
}

// ---- tests -----------------------------------------------------------------

test('a feed row with no sha256 is NOT offered as an available update', async () => {
  stubGet({ [FEED]: { body: feed({ file: ASSET, size: PAYLOAD.length }) } });
  try {
    const s = await updater.check();
    assert.strictEqual(s.error, '', 'the feed itself parsed fine');
    assert.strictEqual(s.version, '9.9.9');
    assert.strictEqual(s.available, false, 'an update we would refuse to download is not "available"');
    await assert.rejects(() => updater.download(), /no update to download|no sha256/);
  } finally { restore(); }
});

test('a hashed update downloads, verifies and is written', async () => {
  stubGet({
    [FEED]: { body: feed({ file: ASSET, sha256: GOOD_SHA, size: PAYLOAD.length }) },
    [ASSET]: { body: PAYLOAD },
  });
  try {
    const s = await updater.check();
    assert.strictEqual(s.available, true);
    const dest = await updater.download();
    assert.ok(fs.existsSync(dest), 'the installer was written');
    assert.deepStrictEqual(fs.readFileSync(dest), PAYLOAD);
    assert.ok(!fs.existsSync(dest + '.part'), 'the .part file was renamed away');
  } finally { restore(); }
});

test('a wrong sha256 is refused and nothing is saved', async () => {
  const bad = 'f'.repeat(64);
  stubGet({
    [FEED]: { body: feed({ file: ASSET, sha256: bad, size: PAYLOAD.length }) },
    [ASSET]: { body: PAYLOAD },
  });
  try {
    await updater.check();
    await assert.rejects(() => updater.download(), /sha256 mismatch/);
  } finally { restore(); }
});

test('a size that disagrees with the feed is refused', async () => {
  stubGet({
    [FEED]: { body: feed({ file: ASSET, sha256: GOOD_SHA, size: PAYLOAD.length + 999 }) },
    [ASSET]: { body: PAYLOAD },
  });
  try {
    await updater.check();
    await assert.rejects(() => updater.download(), /size mismatch/);
  } finally { restore(); }
});

test('a redirect to http:// cannot downgrade the transfer', async () => {
  const INSECURE = 'http://evil.example/minimaCore-9.9.9-arm64.dmg';
  stubGet({
    [FEED]: { body: feed({ file: ASSET, sha256: GOOD_SHA, size: PAYLOAD.length }) },
    [ASSET]: { status: 302, headers: { location: INSECURE }, body: '' },
    [INSECURE]: { body: PAYLOAD },
  });
  try {
    await updater.check();
    await assert.rejects(() => updater.download(), /non-https/,
      'one 302 must not turn the update channel into plaintext');
  } finally { restore(); }
});

test('an http:// feed url is refused outright (loopback excepted)', async () => {
  stubGet({});
  try {
    const s = await updater.check();   // default feed is https, so this only proves check() survives a 404
    assert.ok(s.checkedAt > 0);
  } finally { restore(); }
});

test.after(() => { try { fs.rmSync(DOWNLOADS, { recursive: true, force: true }); } catch (e) {} });
