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
const files = ['decimal.js','covenant.js','curve.js','router.js','book.js','store.js','history.js','statement.js','sha3.js','receipt-recovery.js','activity-chain.js','poolmgr.js','reserve-recovery.js','service.js'];

// Fail loudly rather than vacuously when the donor tree is absent — a silent ENOENT would let drift ship.
if (!fs.existsSync(path.join(donor, 'poolmgr.js'))) {
  console.error('FAIL donor MDS tree not found at ' + donor);
  console.error('     Set PP_MDS_ROOT to the pandapools-mds checkout, or run pandapools-parity-manifest.cjs');
  console.error('     (the donor-absent equivalent). This check must never pass without a donor.');
  process.exit(1);
}
for (const f of files) assert.equal(fs.readFileSync(path.join(root,'main/pandapools',f),'utf8'),fs.readFileSync(path.join(donor,f),'utf8'),'MDS/Desktop drift: '+f);
console.log('PASS ' + files.length + ' byte-identical MDS/Desktop engine files');
// The Desktop receipt templates moved into the PandaPools panel module in 0.17.18 (APK parity). Same
// templates, same assertions — reached through the panel's own display-only exports.
const ctx={Math,Date,JSON,String,Number,Boolean,Array,Object,RegExp,Promise,console,setTimeout,clearTimeout,
  localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  document:{getElementById:()=>null,querySelectorAll:()=>[],createElement:()=>({style:{}}),body:{appendChild(){},insertAdjacentHTML(){}}}};
ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'renderer/pools.js'),'utf8'),ctx,{filename:'pools.js'});
ctx.PoolsPanel.init({TOK:{shortId:s=>s,tidyAmount:s=>s},esc:s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),
  el:()=>null,api:{},toast(){},copy(){},short:s=>s,showConfirm:async()=>false,showProgress:()=>({close(){}}),tryCmd:async()=>[],
  running:()=>true,activeView:()=>'pandapools'});
ctx.ppActsHtml=ctx.PoolsPanel._actsHtml;ctx.ppFeedHtml=ctx.PoolsPanel._feedHtml;
const row={type:'CLOSE',summary:'784.52331493 USDT',txpowid:'0x1234',originalTxpowid:'0xabcd',ts:1788896729000,timeLabel:'Transaction',verifiedAt:1788936000000,statusText:'853 confirmations · on-chain',confirmed:true};
const html=ctx.ppActsHtml([row]);assert(html.includes('853 confirmations'));assert(html.includes('Original submission'));assert(html.includes('2026-09-08'));assert(html.includes('UTC'));assert(html.includes('data-copy="0xabcd"'));
const feed=ctx.ppFeedHtml([{kind:'WITHDRAW',minimaAmt:'175157.93892489164',tokenAmt:'784.52331493',tokenLabel:'USDT',txpowid:row.txpowid,ts:row.ts,statusText:row.statusText,confirmed:true},{kind:'WITHDRAW',minimaAmt:'175157',tokenAmt:'784',tokenLabel:'USDT',observed:true,ts:1788936000000}]);
assert(feed.includes('Liquidity withdrawal'));assert(feed.includes('853 confirmations'));assert(feed.includes('Transaction time unknown'));assert(!feed.includes('Sold 175157'));
assert(!ctx.ppActsHtml([{type:'<img src=x>',summary:'<script>',statusText:'<b>'}]).includes('<script>'));
console.log('PASS Desktop receipts, actual counts, UTC times, public withdrawal classification, observation provenance and escaping');
