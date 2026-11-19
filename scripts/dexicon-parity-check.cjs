/*
 * Donor-present parity check (local gate; the model is pandapools-parity-check.cjs): every Dexicon engine file must be
 * byte-identical to the MiniDapp it is copied from, and the donor's service.js must still be the one
 * main/dexicon/service.desktop.js was written against. CI cannot see the donor (separate repo), so CI runs
 * dexicon-parity-manifest.cjs instead. This check must never pass without a donor.
 */
const fs = require('node:fs'), path = require('node:path');
const { FILES, engineDir, donor, manifestPath, sha256 } = require('./dexicon-parity-manifest.cjs');

if (!fs.existsSync(path.join(donor, 'service.js'))) {
  console.error('FAIL donor MiniDapp tree not found at ' + donor);
  console.error('     Set DEXICON_DONOR to the dexicon checkout, or run dexicon-parity-manifest.cjs (the donor-absent equivalent).');
  process.exit(1);
}
const drift = FILES.filter(f => !fs.readFileSync(path.join(engineDir, f)).equals(fs.readFileSync(path.join(donor, f))));
if (drift.length) { console.error('FAIL MDS/Desktop drift: ' + drift.map(f => 'main/dexicon/' + f).join(', ')); process.exit(1); }
const recorded = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).donor.serviceJsSha256, now = sha256(fs.readFileSync(path.join(donor, 'service.js')));
if (recorded !== now) {
  console.error('FAIL the donor service.js changed (sha256 ' + now + ', recorded ' + recorded + ').');
  console.error('     Read its diff, carry what applies into main/dexicon/service.desktop.js, then run the manifest --update.');
  process.exit(1);
}
console.log('PASS ' + FILES.length + ' byte-identical MDS/Desktop Dexicon engine files; donor service.js unchanged since service.desktop.js was written');
