/*
 * Donor-present parity check: every PandaPools engine file must be byte-identical to the MDS MiniDapp it is
 * copied from. Run locally and before any Desktop release. CI cannot see the donor (separate repo), so CI runs
 * pandapools-parity-manifest.cjs instead — keep the two in step via `--update` on the manifest.
 *
 * poolmgr.js and service.js joined this list in 0.16.83. They had drifted ~200 lines each with Desktop BEHIND,
 * missing the serial signing gate, the SQL CoinLock and the $OADR funding exclusion — the complete native
 * 0.9.22 defect set. Every hunk was stale drift; there is NO intended platform difference in any engine file,
 * which is why byte-equality is the right rule and the old poolmgr/service substring spot-checks are gone.
 * Runtime differences belong in the injected `MDS` shim (main/pandapools/loader.js, sqlshim.js) or in the glue
 * (main/pandapools.js) — NEVER in an engine file.
 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const donor = process.env.PP_MDS_ROOT || path.resolve(root, '../../mds/pandapools-mds');
const files = ['decimal.js','covenant.js','curve.js','router.js','book.js','store.js','history.js','statement.js','sha3.js','receipt-recovery.js','activity-chain.js','poolmgr.js','reserve-recovery.js','service.js', 'combined-backup.js', 'full-backup.js', 'input-claims.js', 'runtime-guard.js', 'rescue-flow.js'];

// Fail loudly rather than vacuously when the donor tree is absent — a silent ENOENT would let drift ship.
if (!fs.existsSync(path.join(donor, 'poolmgr.js'))) {
  console.error('FAIL donor MDS tree not found at ' + donor);
  console.error('     Set PP_MDS_ROOT to the pandapools-mds checkout, or run pandapools-parity-manifest.cjs');
  console.error('     (the donor-absent equivalent). This check must never pass without a donor.');
  process.exit(1);
}
for (const f of files) assert.equal(fs.readFileSync(path.join(root,'main/pandapools',f),'utf8'),fs.readFileSync(path.join(donor,f),'utf8'),'MDS/Desktop drift: '+f);
console.log('PASS ' + files.length + ' byte-identical MDS/Desktop engine files');
// The Desktop receipts are room 2 of Dexicon now (renderer/dexicon-pp.js actItem / feedItem; the old panel's templates were
// removed with it in 0.18.141). The same properties, on what the room draws: real confirmation counts, the original
// submission whole, UTC times, a public withdrawal named as one, an observation marked unverified, and escaping.
const PP=require(path.join(root,'renderer/dexicon-pp.js'));
const row={type:'CLOSE',summary:'784.52331493 USDT',txpowid:'0x1234',originalTxpowid:'0xabcd',ts:1788896729000,timeLabel:'Transaction',verifiedAt:1788936000000,statusText:'853 confirmations · on-chain',confirmed:true};
const act=PP.actItem(row,1788936600000);
assert.equal(act.chip,'853 confirmations · on-chain');assert.deepEqual(act.ids,[['transaction','0x1234'],['original submission','0xabcd']]);
assert(act.lines[0].startsWith('Transaction ')&&act.lines[0].includes('08 Sep 2026')&&act.lines[0].endsWith('GMT'));
const seen=PP.feedItem({kind:'WITHDRAW',minimaAmt:'175157.93892489164',tokenAmt:'784.52331493',tokenLabel:'USDT',txpowid:row.txpowid,ts:row.ts,statusText:row.statusText,confirmed:true},1788936600000);
assert(seen.title.startsWith('Liquidity withdrawal'));assert.equal(seen.chip,'853 confirmations · on-chain');assert(!seen.title.includes('Sold 175157'));
const obs=PP.feedItem({kind:'WITHDRAW',minimaAmt:'175157',tokenAmt:'784',tokenLabel:'USDT',observed:true},1788936600000);
assert(obs.title.includes('observation (unverified)'));assert(obs.lines.join(' ').includes('Transaction time unknown'));
const src=fs.readFileSync(path.join(root,'renderer/dexicon-pp.js'),'utf8');
assert(src.includes('<b class="pp-ct">${esc(it.title)}</b>')&&src.includes('${esc(it.chip)}')&&src.includes('${esc(it.summary)}')&&src.includes('${esc(l)}'),'every part of a row is escaped where it is drawn');
console.log('PASS Desktop receipts, actual counts, UTC times, public withdrawal classification, observation provenance and escaping');
