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

test('resources: sidecar bundle present, jar contains the keets classes', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'resources/keets-sidecar/index.js')), 'sidecar index.js bundled');
  assert.ok(fs.existsSync(path.join(ROOT, 'resources/keets-sidecar/node_modules/hyperswarm')), 'hyperswarm bundled');
  const listing = execSync('unzip -l ' + path.join(ROOT, 'resources/minima.jar'), { encoding: 'utf8' });
  assert.ok(listing.includes('org/minima/system/network/keets/KeetsManager'),
    'resources/minima.jar must contain KeetsManager (keets-enabled build)');
});

test('package.json: sidecar ships via extraResources', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.extraResources.some(r => r.from === 'resources/keets-sidecar'),
    'extraResources must bundle resources/keets-sidecar');
});
