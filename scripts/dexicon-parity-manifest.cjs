/*
 * dexicon-parity-manifest.cjs — the donor-ABSENT half of the Dexicon engine parity gate (the model is
 * pandapools-parity-manifest.cjs).
 *
 * main/dexicon/{lib,crypto,vendor,resting}/ is copied verbatim from the Dexicon MiniDapp (eurobuddha/dexicon,
 * ../../mds/dexicon). CI does not check that repo out, so CI verifies this COMMITTED manifest: every engine file's
 * sha256, the donor version, branch and commit, and the sha256 of the donor's service.js, which
 * main/dexicon/service.desktop.js mirrors by hand (a donor service.js that changes must be re-read, not re-copied).
 *
 *   node scripts/dexicon-parity-manifest.cjs --verify    (default; CI)
 *   node scripts/dexicon-parity-manifest.cjs --update    (after re-copying from the donor)
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const engineDir = path.join(root, 'main/dexicon');
const manifestPath = path.join(__dirname, 'dexicon-parity.manifest.json');
const donor = process.env.DEXICON_DONOR || path.resolve(root, '../../mds/dexicon');

// Exactly the files service.desktop.js loads, in its load order. loader.js and service.desktop.js are Desktop-only
// and deliberately NOT here. Not copied at all: doors/ and lib/door.js (the AtomiX doors are never started here),
// the page's own files (ui/, lib/calm.js, lib/activity.js, resting/{export,zip,explorer,balance}.js).
const FILES = ['lib/rhino_shim.js', 'vendor/nacl.js', 'vendor/blake.js', 'vendor/sha256.js', 'vendor/sha512.js', 'vendor/decimal.js',
  'lib/hex.js', 'lib/flow.js', 'crypto/ax_sodium.js', 'lib/identity.js', 'lib/mdsw.js', 'lib/prng.js', 'lib/envelope.js', 'lib/relay.js',
  'lib/fill.js', 'lib/maker.js', 'lib/ladder.js',
  'resting/safety.js', 'resting/covenant.js', 'resting/input-claims.js', 'resting/funding.js', 'resting/signlock.js', 'resting/book.js',
  'resting/pool.js', 'resting/composite.js', 'resting/txn.js', 'resting/tape.js', 'resting/maker.js', 'resting/price.js',
  'resting/verifier.js', 'resting/pending.js', 'resting/stats.js', 'resting/split.js', 'resting/chain.js', 'resting/history.js',
  'resting/pd_service.js', 'lib/autocross.js'];

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const fail = (...lines) => { for (const l of lines) console.error(l); process.exit(1); };

function digestEngine() {
  const out = {};
  for (const f of FILES) {
    const p = path.join(engineDir, f);
    if (!fs.existsSync(p)) fail('FAIL missing engine file: main/dexicon/' + f);
    const buf = fs.readFileSync(p);
    out[f] = { sha256: sha256(buf), bytes: buf.length };
  }
  return out;
}
/** One digest for the whole engine: sha256 over "path sha256\n" of every file, in FILES order. */
const overall = files => sha256(FILES.map(f => f + ' ' + files[f].sha256 + '\n').join(''));

/** A file under main/dexicon/ that is neither an engine file nor one of the two Desktop files would be loadable by MDS.load. */
function strays() {
  const keep = new Set(FILES.concat(['loader.js', 'service.desktop.js'])), out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (!keep.has(r)) out.push(r);
    }
  })(engineDir, '');
  return out;
}

function git(...args) { try { return execFileSync('git', ['-C', donor, ...args], { encoding: 'utf8' }).trim(); } catch (e) { return ''; } }

function update() {
  if (!fs.existsSync(path.join(donor, 'service.js'))) fail('FAIL --update needs the donor MiniDapp tree; not found at ' + donor, '     Set DEXICON_DONOR.');
  // Refuse to stamp a manifest over an engine that does not match the donor: --update must never launder local drift.
  const drift = FILES.filter(f => !fs.readFileSync(path.join(engineDir, f)).equals(fs.readFileSync(path.join(donor, f))));
  if (drift.length) fail('FAIL engine differs from the donor, so the manifest was NOT updated: ' + drift.join(', '), '     Re-copy those files from ' + donor + ' first.');
  // The donor's COMMITTED state is what is recorded: an uncommitted edit there must not become the recorded source.
  const dirty = git('status', '--porcelain', '--', 'lib', 'resting', 'crypto', 'vendor', 'service.js');
  if (dirty) fail('FAIL the donor has uncommitted changes in its engine files, so the manifest was NOT updated:', dirty);
  const files = digestEngine();
  const m = /"version"\s*:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(donor, 'dapp.conf'), 'utf8'));
  const manifest = {
    _comment: 'Digests of the Dexicon engine files copied verbatim from the MiniDapp. Regenerate ONLY with '
      + '`node scripts/dexicon-parity-manifest.cjs --update` beside a deliberate re-copy. Desktop-only differences belong in '
      + 'main/dexicon/loader.js, main/dexicon/service.desktop.js or main/dexicon.js, never in an engine file.',
    donor: { root: path.relative(root, donor), mdsVersion: m ? m[1] : '', branch: git('rev-parse', '--abbrev-ref', 'HEAD'), gitSha: git('rev-parse', 'HEAD'),
      serviceJsSha256: sha256(fs.readFileSync(path.join(donor, 'service.js'))) },
    digest: overall(files),
    files
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('UPDATED ' + path.relative(root, manifestPath) + ' (' + FILES.length + ' files, digest ' + manifest.digest + ')');
  console.log('        donor MDS ' + manifest.donor.mdsVersion + ', ' + manifest.donor.branch + ' @ ' + manifest.donor.gitSha);
}

function verify() {
  if (!fs.existsSync(manifestPath)) fail('FAIL no manifest at ' + path.relative(root, manifestPath));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')), recorded = manifest.files || {}, actual = digestEngine(), problems = [];
  for (const f of FILES) {
    if (!recorded[f]) problems.push(f + ': not in the manifest');
    else if (recorded[f].sha256 !== actual[f].sha256) problems.push(f + ': sha256 ' + actual[f].sha256 + ' does not match the recorded ' + recorded[f].sha256
      + ' (' + actual[f].bytes + ' bytes on disk vs ' + recorded[f].bytes + ' recorded)');
  }
  for (const f of Object.keys(recorded)) if (!FILES.includes(f)) problems.push(f + ': in the manifest but no longer an engine file');
  for (const f of strays()) problems.push(f + ': under main/dexicon/ but not an engine file (MDS.load could run it)');
  if (!problems.length && manifest.digest !== overall(actual)) problems.push('overall digest ' + overall(actual) + ' does not match the recorded ' + manifest.digest);
  if (problems.length) fail('FAIL the Dexicon engine does not match the committed manifest:', ...problems.map(p => '     ' + p), '',
    '     The files under main/dexicon/{lib,crypto,vendor,resting}/ are copied verbatim from the MiniDapp and must stay',
    '     byte-identical to it. Desktop-only behaviour belongs in loader.js, service.desktop.js or main/dexicon.js.',
    '     If this IS a deliberate re-copy, run --update against the donor and commit both changes together.');
  const d = manifest.donor || {};
  console.log('PASS ' + FILES.length + ' Dexicon engine files match the committed manifest (donor MDS ' + d.mdsVersion + ', ' + d.gitSha + ', digest ' + manifest.digest + ')');
}

module.exports = { FILES, engineDir, donor, manifestPath, sha256 };
if (require.main === module) { if (process.argv.includes('--update')) update(); else verify(); }
