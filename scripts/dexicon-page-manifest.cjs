/*
 * dexicon-page-manifest.cjs — the parity gate for the Dexicon PAGE (the taker's engine), beside the engine's own gate
 * (dexicon-parity-manifest.cjs, which this script only reads).
 *
 * renderer/dexicon/ holds the MiniDapp's page, byte for byte from mds/dexicon at the SAME commit as the engine:
 * index.html, ui/, and the files only the page loads (lib/activity.js, lib/calm.js, lib/takeable.js, resting/{balance,zip,
 * export,explorer}.js, and doors/sha3.js: the hash lib/takeable.js needs). mds.js is this app's own bridge and the only file
 * there that is not pinned. Every other door, and lib/door.js, must not be there at all.
 *
 *   node scripts/dexicon-page-manifest.cjs --verify    (default; CI: the committed digests)
 *   node scripts/dexicon-page-manifest.cjs --update    (beside a re-copy; needs the donor repo, checks every byte against its commit)
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), pageDir = path.join(root, 'renderer/dexicon');
const manifestPath = path.join(__dirname, 'dexicon-page.manifest.json');
const engine = JSON.parse(fs.readFileSync(path.join(__dirname, 'dexicon-parity.manifest.json'), 'utf8'));
const donor = process.env.DEXICON_DONOR || path.resolve(root, '../../mds/dexicon');
const OWN = 'mds.js';
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const fail = (...lines) => { for (const l of lines) console.error(l); process.exit(1); };

function listed() {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (r !== OWN) out.push(r);
    }
  })(pageDir, '');
  return out;
}
function digest() {
  const files = {};
  for (const f of listed()) {
    // doors/sha3.js only (0.19.406): AXSHA3, which lib/takeable.js needs for a script's address; it is a hash, no AtomiX door
    if ((/^doors\//.test(f) && f !== 'doors/sha3.js') || f === 'lib/door.js') fail('FAIL the AtomiX doors must not be in the page folder: renderer/dexicon/' + f);
    const buf = fs.readFileSync(path.join(pageDir, f));
    files[f] = { sha256: sha256(buf), bytes: buf.length };
  }
  return files;
}

const files = digest();
if (process.argv.includes('--update')) {
  for (const f of Object.keys(files)) {
    let theirs; try { theirs = execFileSync('git', ['-C', donor, 'show', engine.donor.gitSha + ':' + f], { maxBuffer: 64 * 1024 * 1024 }); } catch (e) { fail('FAIL the donor has no ' + f + ' at ' + engine.donor.gitSha + ' (donor: ' + donor + ')'); }
    if (sha256(theirs) !== files[f].sha256) fail('FAIL renderer/dexicon/' + f + ' differs from the donor at ' + engine.donor.gitSha);
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ _comment: 'Digests of the Dexicon page files copied verbatim from the MiniDapp, at the same commit as the engine (scripts/dexicon-parity.manifest.json). Regenerate ONLY with `node scripts/dexicon-page-manifest.cjs --update` beside a deliberate re-copy. This app\'s differences belong in renderer/dexicon/mds.js, never in a page file.',
    donor: { mdsVersion: engine.donor.mdsVersion, gitSha: engine.donor.gitSha }, files }, null, 2) + '\n');
  console.log('PASS wrote ' + path.relative(root, manifestPath) + ': ' + Object.keys(files).length + ' page files, each equal to the donor at ' + engine.donor.gitSha);
} else {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')), bad = [];
  if (m.donor.gitSha !== engine.donor.gitSha) bad.push('the page is pinned to ' + m.donor.gitSha + ' but the engine to ' + engine.donor.gitSha + ': they must be one commit');
  for (const f of Object.keys(m.files)) if (!files[f]) bad.push('missing: ' + f); else if (files[f].sha256 !== m.files[f].sha256) bad.push('changed: ' + f);
  for (const f of Object.keys(files)) if (!m.files[f]) bad.push('not in the manifest: ' + f);
  if (!fs.existsSync(path.join(pageDir, OWN))) bad.push('missing: ' + OWN);
  if (bad.length) fail('FAIL Dexicon page parity (renderer/dexicon):', ...bad.map(b => '  ' + b));
  console.log('PASS Dexicon page: ' + Object.keys(m.files).length + ' files match the committed digests (donor ' + m.donor.mdsVersion + ', ' + m.donor.gitSha + ')');
}
