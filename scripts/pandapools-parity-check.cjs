const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const donor = process.env.PP_MDS_ROOT || path.resolve(root, '../../mds/pandapools-mds');
const files = ['decimal.js','covenant.js','curve.js','router.js','book.js','store.js','history.js','statement.js','sha3.js','receipt-recovery.js','activity-chain.js','reserve-recovery.js'];
for (const f of files) assert.equal(fs.readFileSync(path.join(root,'main/pandapools',f),'utf8'),fs.readFileSync(path.join(donor,f),'utf8'),'MDS/Desktop drift: '+f);
for (const engine of [donor,path.join(root,'main/pandapools')]) {
  assert(fs.readFileSync(path.join(engine,'poolmgr.js'),'utf8').includes('ActivityChain.rememberSubmission(rp, posted'));
  assert(!fs.readFileSync(path.join(engine,'service.js'),'utf8').includes('    ingestFeed(funded);'));
}
console.log('PASS 12 byte-identical MDS/Desktop engine files');
const source=fs.readFileSync(path.join(root,'renderer/app.js'),'utf8');
const htmlCode=source.slice(source.indexOf('function ppSwapSummary'),source.indexOf('function wirePpPoolRows'));
const ctx={TOK:{shortId:s=>s,tidyAmount:s=>s},esc:s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')};vm.createContext(ctx);vm.runInContext(htmlCode,ctx);
const row={type:'CLOSE',summary:'784.52331493 USDT',txpowid:'0x1234',originalTxpowid:'0xabcd',ts:1788896729000,timeLabel:'Transaction',verifiedAt:1788936000000,statusText:'853 confirmations · on-chain',confirmed:true};
const html=ctx.ppActsHtml([row]);assert(html.includes('853 confirmations'));assert(html.includes('Original submission'));assert(html.includes('2026-09-08'));assert(html.includes('UTC'));assert(html.includes('data-copy="0xabcd"'));
const feed=ctx.ppFeedHtml([{kind:'WITHDRAW',minimaAmt:'175157.93892489164',tokenAmt:'784.52331493',tokenLabel:'USDT',txpowid:row.txpowid,ts:row.ts,statusText:row.statusText,confirmed:true},{kind:'WITHDRAW',minimaAmt:'175157',tokenAmt:'784',tokenLabel:'USDT',observed:true,ts:1788936000000}]);
assert(feed.includes('Liquidity withdrawal'));assert(feed.includes('853 confirmations'));assert(feed.includes('Transaction time unknown'));assert(!feed.includes('Sold 175157'));
assert(!ctx.ppActsHtml([{type:'<img src=x>',summary:'<script>',statusText:'<b>'}]).includes('<script>'));
console.log('PASS Desktop receipts, actual counts, UTC times, public withdrawal classification, observation provenance and escaping');
