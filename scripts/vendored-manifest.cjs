/*
 * vendored-manifest.cjs: the donor-ABSENT half of the AtomiX and P2P Chance parity gates (0.19.264; the model is
 * dexicon-parity-manifest.cjs). main/atomix/ and main/casino/ hold files copied verbatim from their donors
 * (atomix-mds; the universal-casino MiniDapp). CI checks neither donor out, and scripts/atomix-parity-check.sh /
 * casino-parity-check.sh need them, so CI verifies this COMMITTED manifest instead: every copied file's sha256, the
 * donor version and commit, and that no other file sits beside them (a stray file the loader could run).
 *
 *   node scripts/vendored-manifest.cjs atomix|casino --verify    (default; CI)
 *   node scripts/vendored-manifest.cjs atomix|casino --update    (after a deliberate re-copy from the donor)
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const firstDir = (...c) => c.find(d => d && fs.existsSync(d)) || c.filter(Boolean)[0];
const ENGINES = {
  atomix: {
    dir: path.join(root, 'main/atomix'),
    donor: firstDir(process.env.ATOMIX_DONOR, path.join(os.homedir(), 'Projects/minima/mds/atomix-mds'), path.join(os.homedir(), 'Projects/atomix-mds')),
    // service.js's own MDS.load list, service.js itself and the two files the glue loads (as atomix-parity-check.sh)
    files: (dir) => [...fs.readFileSync(path.join(dir, 'service.js'), 'utf8').matchAll(/MDS\.load\('([^']+)'\)/g)].map(m => m[1]).concat(['service.js', 'lib/wallet.js', 'lib/inspect.js']),
    desktop: ['loader.js'],
    // ponytail: lib/ui.js is an old copy of the donor's page script that nothing here loads (the AtomiX panel was removed in
    // 0.18.141) and it no longer matches the donor; it is left in place (vendored files are not edited here) and named so
    // the stray check passes. Deleting it is the owner's call.
    unloaded: ['lib/ui.js'],
    version: (donor) => { try { return /"version"\s*:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(donor, 'dapp.conf'), 'utf8'))[1]; } catch (e) { return ''; } }
  },
  casino: {
    dir: path.join(root, 'main/casino'),
    donor: firstDir(process.env.CASINO_DONOR, path.join(os.homedir(), 'Projects/archive/Ideas/universal-casino/mds'), path.join(os.homedir(), 'Projects/Ideas/universal-casino/mds')),
    files: () => ['service.js', 'timeout-claims.js', 'offer-keepalive.js'],
    // engine.js lifts the donor's command strings but is not a whole-file copy: reviewed, not byte-checked (casino-parity-check.sh)
    desktop: ['loader.js', 'engine.js'],
    version: () => ''
  }
};
const name = process.argv[2], E = ENGINES[name];
const fail = (...l) => { for (const x of l) console.error(x); process.exit(1); };
if (!E) fail('usage: node scripts/vendored-manifest.cjs atomix|casino [--verify|--update]');
const manifestPath = path.join(__dirname, name + '-parity.manifest.json');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const FILES = E.files(E.dir);
function digest() {
  const out = {};
  for (const f of FILES) { const p = path.join(E.dir, f); if (!fs.existsSync(p)) fail('FAIL missing engine file: main/' + name + '/' + f); const b = fs.readFileSync(p); out[f] = { sha256: sha256(b), bytes: b.length }; }
  return out;
}
const overall = (files) => sha256(Object.keys(files).sort().map(f => f + ' ' + files[f].sha256 + '\n').join(''));
function strays() {
  const keep = new Set(FILES.concat(E.desktop, E.unloaded || [])), out = [];
  (function walk(dir, rel) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (!keep.has(r) && e.name !== '.DS_Store') out.push(r); } })(E.dir, '');   // Finder's folder file is no code (0.19.280)
  return out;
}
const git = (...a) => { try { return execFileSync('git', ['-C', E.donor, ...a], { encoding: 'utf8' }).trim(); } catch (e) { return ''; } };
function update() {
  if (!E.donor || !fs.existsSync(E.donor)) fail('FAIL --update needs the donor tree; not found at ' + E.donor);
  const drift = FILES.filter(f => !fs.existsSync(path.join(E.donor, f)) || !fs.readFileSync(path.join(E.dir, f)).equals(fs.readFileSync(path.join(E.donor, f))));
  if (drift.length) fail('FAIL the copy differs from the donor, so the manifest was NOT updated: ' + drift.join(', '));
  const dirty = git('status', '--porcelain', '--', ...FILES);
  if (dirty) fail('FAIL the donor has uncommitted changes in the copied files, so the manifest was NOT updated:', dirty);
  const files = digest();
  const m = { _comment: 'Digests of the ' + name + ' files copied verbatim from the donor. Regenerate ONLY with `node scripts/vendored-manifest.cjs ' + name + ' --update` beside a deliberate re-copy. Desktop-only code belongs in ' + E.desktop.map(f => 'main/' + name + '/' + f).join(', ') + ' or main/' + name + '.js.',
    donor: { root: path.basename(path.dirname(E.donor)) + '/' + path.basename(E.donor), version: E.version(E.donor), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), gitSha: git('rev-parse', 'HEAD') },
    digest: overall(files), files };
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
  console.log('UPDATED ' + path.relative(root, manifestPath) + ' (' + FILES.length + ' files, digest ' + m.digest + ', donor ' + m.donor.gitSha + ')');
}
function verify() {
  if (!fs.existsSync(manifestPath)) fail('FAIL no manifest at ' + path.relative(root, manifestPath));
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')), rec = m.files || {}, act = digest(), problems = [];
  for (const f of FILES) { if (!rec[f]) problems.push(f + ': not in the manifest'); else if (rec[f].sha256 !== act[f].sha256) problems.push(f + ': sha256 ' + act[f].sha256 + ' does not match the recorded ' + rec[f].sha256 + ' (' + act[f].bytes + ' bytes on disk vs ' + rec[f].bytes + ' recorded)'); }
  for (const f of Object.keys(rec)) if (!FILES.includes(f)) problems.push(f + ': in the manifest but no longer a copied file');
  for (const f of strays()) problems.push(f + ': under main/' + name + '/ but neither a copied file nor desktop glue');
  if (!problems.length && m.digest !== overall(act)) problems.push('overall digest ' + overall(act) + ' does not match the recorded ' + m.digest);
  if (problems.length) fail('FAIL main/' + name + '/ does not match the committed manifest:', ...problems.map(p => '     ' + p), '',
    '     Those files are copied verbatim from the donor and must stay byte-identical to it. If this IS a deliberate',
    '     re-copy, run --update against the donor and commit both changes together.');
  console.log('PASS ' + FILES.length + ' ' + name + ' files match the committed manifest (donor ' + (m.donor.version ? m.donor.version + ', ' : '') + m.donor.gitSha + ', digest ' + m.digest + ')');
}
module.exports = { ENGINES };
if (require.main === module) { if (process.argv.includes('--update')) update(); else verify(); }
