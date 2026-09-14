/*
 * pandapools-parity-manifest.cjs — the donor-ABSENT half of the PandaPools engine parity gate.
 *
 * pandapools-parity-check.cjs proves byte-equality against the donor MDS tree, but that tree lives in a separate
 * repo (eurobuddha/pandapools-mds) which CI does not check out. Wiring the donor check into CI would therefore
 * either crash or, worse, pass vacuously. So CI verifies a COMMITTED digest manifest instead: every engine file's
 * sha256 plus the donor version and git SHA it came from.
 *
 * The only way the manifest changes is `--update`, run beside a deliberate engine re-copy. That makes every
 * engine change a reviewable two-part diff (engine bytes + manifest digests), and makes an unreviewed edit to a
 * copied engine file fail CI on all three build legs.
 *
 *   node scripts/pandapools-parity-manifest.cjs --verify    (default; CI)
 *   node scripts/pandapools-parity-manifest.cjs --update    (after re-copying from the donor)
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const engineDir = path.join(root, 'main/pandapools');
const manifestPath = path.join(__dirname, 'pandapools-parity.manifest.json');
const donor = process.env.PP_MDS_ROOT || path.resolve(root, '../../mds/pandapools-mds');

// The engine files copied verbatim from the MDS. loader.js and sqlshim.js are Desktop-only shims and are
// deliberately NOT here — they are where the runtime differences are allowed to live.
const FILES = ['decimal.js', 'covenant.js', 'curve.js', 'router.js', 'book.js', 'store.js', 'history.js',
  'statement.js', 'sha3.js', 'receipt-recovery.js', 'activity-chain.js', 'poolmgr.js', 'reserve-recovery.js',
  'service.js'];

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function digestEngine() {
  const out = {};
  for (const f of FILES) {
    const p = path.join(engineDir, f);
    if (!fs.existsSync(p)) { console.error('FAIL missing engine file: main/pandapools/' + f); process.exit(1); }
    const buf = fs.readFileSync(p);
    out[f] = { sha256: sha256(buf), bytes: buf.length };
  }
  return out;
}

function donorProvenance() {
  const info = { root: path.relative(root, donor) || donor };
  try {
    const conf = fs.readFileSync(path.join(donor, 'dapp.conf'), 'utf8');
    const m = /"version"\s*:\s*"([^"]+)"/.exec(conf);
    if (m) info.mdsVersion = m[1];
  } catch (e) { /* provenance is best-effort; the digests are the gate */ }
  try {
    info.gitSha = execFileSync('git', ['-C', donor, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (e) { /* donor may not be a git checkout */ }
  return info;
}

function update() {
  if (!fs.existsSync(path.join(donor, 'poolmgr.js'))) {
    console.error('FAIL --update needs the donor MDS tree; not found at ' + donor);
    console.error('     Set PP_MDS_ROOT. The manifest must only ever be regenerated from a real donor.');
    process.exit(1);
  }
  // Refuse to stamp a manifest over an engine that does not actually match the donor — otherwise --update
  // would launder local drift into an "approved" digest, which is the one thing this file exists to prevent.
  const drift = FILES.filter(f =>
    fs.readFileSync(path.join(engineDir, f), 'utf8') !== fs.readFileSync(path.join(donor, f), 'utf8'));
  if (drift.length) {
    console.error('FAIL engine differs from the donor, so the manifest was NOT updated: ' + drift.join(', '));
    console.error('     Re-copy those files from ' + donor + ' first.');
    process.exit(1);
  }
  const manifest = {
    _comment: 'Digests of the PandaPools engine files copied verbatim from the MDS MiniDapp. Regenerate ONLY '
      + 'with `node scripts/pandapools-parity-manifest.cjs --update` beside a deliberate engine re-copy. '
      + 'Desktop-only runtime differences belong in loader.js / sqlshim.js / main/pandapools.js, never here.',
    donor: donorProvenance(),
    files: digestEngine(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('UPDATED ' + path.relative(root, manifestPath) + ' (' + FILES.length + ' files)');
  if (manifest.donor.mdsVersion) console.log('        donor MDS ' + manifest.donor.mdsVersion);
  if (manifest.donor.gitSha) console.log('        donor git ' + manifest.donor.gitSha);
}

function verify() {
  if (!fs.existsSync(manifestPath)) {
    console.error('FAIL no manifest at ' + path.relative(root, manifestPath));
    console.error('     Generate it with --update against the donor MDS tree.');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const recorded = manifest.files || {};
  const actual = digestEngine();
  const problems = [];

  for (const f of FILES) {
    if (!recorded[f]) { problems.push(f + ': not in the manifest'); continue; }
    if (recorded[f].sha256 !== actual[f].sha256) {
      problems.push(f + ': sha256 ' + actual[f].sha256 + ' does not match the recorded ' + recorded[f].sha256
        + ' (' + actual[f].bytes + ' bytes on disk vs ' + recorded[f].bytes + ' recorded)');
    }
  }
  for (const f of Object.keys(recorded)) {
    if (!FILES.includes(f)) problems.push(f + ': in the manifest but no longer an engine file');
  }

  if (problems.length) {
    console.error('FAIL PandaPools engine does not match the committed manifest:');
    for (const p of problems) console.error('     ' + p);
    console.error('');
    console.error('     An engine file under main/pandapools/ was edited directly. Those files are copied');
    console.error('     verbatim from the MDS MiniDapp and must stay byte-identical to it. Put Desktop-only');
    console.error('     behaviour in loader.js, sqlshim.js or main/pandapools.js instead. If this IS a');
    console.error('     deliberate re-copy, run --update against the donor and commit both changes together.');
    process.exit(1);
  }

  const d = manifest.donor || {};
  console.log('PASS ' + FILES.length + ' PandaPools engine files match the committed manifest'
    + (d.mdsVersion ? ' (donor MDS ' + d.mdsVersion + ')' : ''));
}

const mode = process.argv.includes('--update') ? 'update' : 'verify';
if (mode === 'update') update(); else verify();
