/*
 * resync-host-test.cjs — the default MegaMMR/resync host must be a NAME, and existing installs must
 * actually move to it.
 *
 * THE BUG THIS EXISTS FOR. The host was hardcoded as the bare IP 31.125.188.214:9001. That address is the
 * Pi and has been reassigned to other duty, so it silently stopped being a Minima node — and a hardcoded
 * address that moves breaks seed RESTORE for every install with no way for the user to tell a moved host
 * from a broken restore.
 *
 * The second half is the part that is easy to get wrong. config.load() does
 * Object.assign({}, DEFAULTS, stored), so a STORED value beats a new default, and save() persists the whole
 * merged object — meaning any install that has ever saved its config pins the old host forever. Changing
 * DEFAULTS alone would have fixed only fresh installs. The migration is what reaches everyone else, and a
 * migration that silently no-ops looks exactly like a working one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RETIRED = '31.125.188.214:9001';
const EXPECTED = 'eurobuddha.com:9001';

test('the retired IP is never ASSIGNED as a value', () => {
  // It may legitimately appear in two places: a comment recording the history, and the migration's
  // equality test (which has to name the old address to recognise it). What must never happen again is
  // the IP being the VALUE of a default.
  for (const rel of ['main/config.js', 'main/node-manager.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const assigned = src.split('\n').filter(l =>
      l.includes(RETIRED) &&
      !l.trimStart().startsWith('//') &&
      !l.includes('===') &&                 // the migration comparison
      /[:=]\s*"[^"]*31\.125\.188\.214/.test(l));
    assert.deepStrictEqual(assigned, [],
      `${rel} assigns ${RETIRED} as a value:\n${assigned.join('\n')}`);
  }
});

test('the default host is a name, not a bare IP', () => {
  const { DEFAULTS } = require(path.join(ROOT, 'main/config.js'));
  assert.strictEqual(DEFAULTS.megammrHost, EXPECTED);
  assert.ok(!/^\d+\.\d+\.\d+\.\d+:/.test(DEFAULTS.megammrHost),
    'a bare IP cannot be moved without shipping a release');
});

test('the default peer is a name too', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/node-manager.js'), 'utf8');
  const m = src.match(/PARLONS_DEFAULT_ROOTNODE\s*=\s*"([^"]+)"/);
  assert.ok(m, 'PARLONS_DEFAULT_ROOTNODE not found');
  assert.strictEqual(m[1], EXPECTED);
});

test('an install already pinned to the retired IP is migrated, not left behind', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/config.js'), 'utf8');
  assert.ok(src.includes(`merged.megammrHost === "${RETIRED}"`),
    'load() must rewrite a STORED retired host — a stored value beats DEFAULTS, so without this ' +
    'every existing install keeps the dead address');
  assert.ok(src.includes('merged.megammrHost = DEFAULTS.megammrHost'),
    'the migration must adopt the current default rather than another hardcoded literal');
});

test('there is no root config.js duplicate to go stale', () => {
  // There used to be a byte-identical copy at the repo root. NOTHING loaded it - every require is
  // ./config from inside main/, and electron-builder packages only main/** and renderer/** - so its
  // only effect was to need hand-mirroring, which 0.17.26 (openAtLogin) silently missed. A duplicate
  // config nobody reads, quietly holding a dead megammrHost, is the exact trap 0.17.25 removed from
  // the value; deleting the file removes it from the file layout. Don't bring it back.
  assert.ok(!fs.existsSync(path.join(ROOT, 'config.js')),
    'a root config.js is back - nothing loads it, so it can only drift from main/config.js');
});
