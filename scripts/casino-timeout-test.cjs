// APK 0.7.1 TimeoutClaimsTest role/deadline vectors, exercised against production JS,
// both renderers, and the actual desktop VM. No node, network, wallet, or transaction post.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const desktop = process.env.CASINO_DESKTOP || path.resolve(__dirname, '..');
const donor = process.env.CASINO_DONOR || path.join(require('node:os').homedir(), 'Projects/archive/Ideas/universal-casino/mds');
const read = f => fs.readFileSync(f, 'utf8');
const policy = read(path.join(donor, 'timeout-claims.js'));
const ctx = vm.createContext({}); vm.runInContext(policy, ctx); const T = ctx.CasinoTimeouts;
const USD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';
const owns = k => k === 'house' || k === 'player';
function coin(id, phase = 1, tokenid = '0x00', age = 11) {
  return {coinid: id, tokenid, age, amount: '0.00000001', tokenamount: tokenid === '0x00' ? undefined : '2.123456789', state: [{port:0,data:'house'}, {port:2,data:'commit'}, {port:3,data:'2'}, {port:5,data:'1'}, {port:6,data:String(phase)}, {port:7,data:'10'}, {port:8,data:'player'}]};
}
test('both currencies: strict boundary, beneficiary, self-play, no claim on phase 0/unknown/unknown age', () => {
  for (const tok of ['0x00', USD]) for (const phase of [0,1,2,3]) for (const age of [undefined, null, '', -1, 0, 9, 10, 11]) for (const key of ['house', 'player', 'stranger', 'both']) {
    const c = coin('0x01', phase, tok); c.age = age;
    const ownsKey = k => key === 'both' ? owns(k) : k === key;
    const eligible = age === 11 && ((phase === 1 && ['player','both'].includes(key)) || (phase === 2 && ['house','both'].includes(key)));
    assert.equal(T.canClaim(c, ownsKey), eligible, `${tok}/${phase}/${age}/${key}`);
  }
});
test('all-currency snapshot deduplicates IDs and distinguishes new claims from removals', () => {
  const a=coin('0x01'), b=coin('0x02',2,USD);
  const snap=T.snapshot([a,b,a],owns);
  assert.equal(snap.summary, '2 timeout claims available (1 Minima · 1 USD)');
  assert.equal(snap.ids.length,2);
  assert.equal(T.hasNew(['0x01'],snap.ids),false);
  assert.equal(T.hasNew(['0x03'],snap.ids),true);
  a.age=10; assert.equal(T.snapshot([a],owns).ids.length,0);
});
test('background reminders survive restart, suppress duplicates/removal sounds, clear and re-alert', () => {
  const mem={}, notices=[];let cancels=0;
  const mds={keypair:{get:(k,cb)=>cb({value:mem[k]}),set:(k,v,cb)=>{mem[k]=v;if(cb)cb({status:true});}},notify:m=>notices.push(m),notifycancel:()=>cancels++};
  let update=T.notifier(mds);const both=T.snapshot([coin('0x01'),coin('0x02',2,USD)],owns);
  update(both,false);update(both,false);update=T.notifier(mds);update(both,false);
  assert.equal(notices.length,1);assert.equal(mem.casino_timeout_open,'1');
  update(T.snapshot([coin('0x01')],owns),false);assert.equal(notices.length,1);
  update(T.snapshot([],owns),false);assert.equal(cancels,1);assert.equal(mem.casino_timeout_open,'0');
  update(both,true);assert.equal(notices.length,1);
  update(both,false);assert.equal(notices.length,2);
});
test('service keeps claims on failed scans; foreground/READ mode never auto-posts', () => {
  const sent=[],notices=[],mem={};let response={status:true,response:[coin('0x01')]};
  const sandbox={Date,console,MDS:{init(){},log(){},cmd:(cmd,cb)=>{sent.push(cmd);cb(response);},keypair:{get:(k,cb)=>cb({value:mem[k]}),set:(k,v,cb)=>{mem[k]=v;if(cb)cb({status:true});}},notify:m=>notices.push(m),notifycancel(){}}};
  const c=vm.createContext(sandbox);sandbox.MDS.load=()=>vm.runInContext(policy,c);
  vm.runInContext(read(path.join(donor,'service.js')),c);c.MY_KEYS.player=true;
  c.processCoins();assert.equal(notices.length,1);const snapshot=mem.casino_timeout_claim_ids;
  response={status:false};c.processCoins();assert.equal(mem.casino_timeout_claim_ids,snapshot);
  response={status:true,response:{}};c.processCoins();assert.equal(mem.casino_timeout_claim_ids,snapshot);
  mem.casino_tab_hb=String(Date.now());response={status:true,response:[coin('0x02',2,USD)]};c.processCoins();
  assert.ok(sent.every(s=>s.startsWith('coins address:')));assert.equal(notices.length,1);
});
function sliceFunction(source, start, end) { const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b); }
test('MDS My Bets shows both currencies under either toggle, role-specific claims and banner', () => {
  const html=read(path.join(donor,'index.html'));
  const nodes={};const node=id=>nodes[id]||(nodes[id]={});
  const c=vm.createContext({CasinoTimeouts:T,BETS:[coin('0x01'),coin('0x02',2,USD)],TAKING:{},document:{getElementById:node,querySelector:node},getState:T.state,isMyKey:owns,coinTok:c=>c.tokenid,coinAmount:c=>c.tokenamount||c.amount,fmtAmt:String,suffixForTok:t=>t===USD?' USD':' Minima',nameForTok:t=>t===USD?'USD':'Minima',gameType:()=>({name:'Coin Flip',badge:''}),esc:String,pickLabel:()=>'',coinAnimHTML:()=>'',renderHistory(){}});
  vm.runInContext(sliceFunction(html,'function renderMyBets(){','// ===== Create Bet'),c);
  for (const dollar of [false,true]) {c.DOLLAR=dollar;c.renderMyBets();assert.match(node('myBetsList').innerHTML,/Minima/);assert.match(node('myBetsList').innerHTML,/USD/);assert.equal((node('myBetsList').innerHTML.match(/CLAIM TIMEOUT/g)||[]).length,2);assert.equal(node('timeoutBanner').hidden,false);}
  c.isMyKey=k=>k==='house';c.renderMyBets();assert.equal((node('myBetsList').innerHTML.match(/CLAIM TIMEOUT/g)||[]).length,1);
  c.BETS=[];c.renderMyBets();assert.equal(node('timeoutBanner').hidden,true);
  assert.match(html, /casino_timeout_open/);assert.match(html,/id="timeoutBanner"[^>]+switchTab\('mybets'\)/);
});
test('desktop actual VM read model and claim handler match roles, currencies, and strict deadline', async () => {
  const {createContext}=require(path.join(desktop,'main/casino/loader.js'));
  let coins=[coin('0x01'),coin('0x02',2,USD)],ok=true;const sent=[];
  const c=createContext({init(){},log(){},notify(){},notifycancel(){},keypair:{get:(k,cb)=>cb({}),set:(k,v,cb)=>cb&&cb({status:true})},cmd:(cmd,cb)=>{sent.push(cmd);if(cb)cb({status:ok,response:coins});}});
  c.READY=true;c.MY_KEYS.player=true;c.MY_KEYS.house=true;
  const mybets=()=>new Promise((resolve,reject)=>c.CASINO.myBets((e,v)=>e?reject(Error(e)):resolve(v)));
  for (const tok of ['0x00',USD]) {c.CASINO.setCurrency(tok);const rows=await mybets();assert.equal(rows.length,2);assert.equal(rows[1].amount,'2.123456789');assert.equal(rows.filter(b=>b.canClaimTimeout).length,2);}
  delete c.MY_KEYS.player;let rows=await mybets();assert.equal(rows.filter(b=>b.canClaimTimeout).length,1);
  coins=[coin('0x01',0),coin('0x02',2,USD,10),coin('0x03',1)];sent.length=0;
  for (const b of coins) await new Promise(resolve=>c.CASINO.claimTimeout(b.coinid,e=>{assert.ok(e);resolve();}));
  assert.ok(sent.every(s=>s.startsWith('coins address:')));
  ok=false;await assert.rejects(mybets,/scan unavailable/);
});
test('desktop My Bets displays mixed currencies and only eligible timeout buttons', async () => {
  const source=read(path.join(desktop,'renderer/app.js'));const host={innerHTML:'',querySelectorAll:()=>[]};
  const bets=[{coinid:'0x01',phase:1,amHouse:true,expired:true,canClaimTimeout:false,tokenid:'0x00',range:2,age:11,timeout:10,blocksUntilClaim:0},{coinid:'0x02',phase:2,amHouse:true,expired:true,canClaimTimeout:true,tokenid:USD,range:2,age:11,timeout:10,blocksUntilClaim:0}];
  const c=vm.createContext({api:{casinoMyBets:async()=>bets},el:()=>host,casinoOwnedBets:[],casinoTaking:{},casinoBusy:{},casinoCancelling:{},casinoGame:()=>({name:'Coin Flip',icon:''}),casinoFmtTok:()=>'',casinoCcyName:t=>t===USD?'USD':'Minima',esc:String,casinoAnimHTML:()=>''});
  vm.runInContext(sliceFunction(source,'async function renderCasinoMyBets()','async function casinoDoFallback'),c);
  await c.renderCasinoMyBets();assert.match(host.innerHTML,/Minima/);assert.match(host.innerHTML,/USD/);assert.equal((host.innerHTML.match(/casino-timeout/g)||[]).length,1);
  c.api.casinoMyBets=async()=>{throw Error('offline');};await c.renderCasinoMyBets();assert.match(host.innerHTML,/USD/);
});
test('APK production Java agrees with JavaScript on 160 role/deadline/currency vectors and covenant', () => {
  const {execFileSync}=require('node:child_process');
  const apk=process.env.CASINO_APK || path.resolve(desktop,'../../apks/casino');
  const classes=path.join(apk,'app/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes');
  assert.ok(fs.existsSync(path.join(classes,'com/eurobuddha/casino/Bet.class')), 'Build APK first: ./gradlew testDebugUnitTest (or set CASINO_APK)');
  const out=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'casino-java-parity-'));
  try {
    // Compile the current policy sources against the APK dependencies, not a reimplementation.
    const src=path.join(apk,'app/src/main/java/com/eurobuddha/casino');
    execFileSync('javac',['-encoding','UTF-8','-cp',classes,'-d',out,path.join(src,'Bet.java'),path.join(src,'TimeoutClaims.java'),path.join(desktop,'scripts/CasinoTimeoutParity.java')]);
    const lines=execFileSync('java',['-cp',out+path.delimiter+classes,'com.eurobuddha.casino.CasinoTimeoutParity'],{encoding:'utf8'}).trim().split('\n');
    const expected=[];
    for(const tok of ['0x00',USD])for(const phase of [0,1,2,3])for(const age of [-1,0,9,10,11])for(const role of ['house','player','stranger','both'])expected.push(String(T.canClaim(coin('0x01',phase,tok,age),k=>role==='both'?owns(k):k===role)));
    assert.deepEqual(lines.slice(0,-1),expected);
    const service=read(path.join(donor,'service.js'));const c=vm.createContext({MDS:{init(){},load(){}} , CasinoTimeouts:T});
    vm.runInContext(service,c);
    assert.equal(lines.at(-1),c.SCRIPT);
    assert.ok(read(path.join(donor,'index.html')).includes(c.SCRIPT));
  } finally {fs.rmSync(out,{recursive:true,force:true});}
});

test('desktop interactive identity accepts the node bare-array keys shape', () => {
  const {createContext}=require(path.join(desktop,'main/casino/loader.js'));
  const c=createContext({init(){},log(){},keypair:{},cmd:(cmd,cb)=>cb({status:true,response:[{publickey:'older-key'}]})});
  c.loadWalletKeys(()=>{});assert.equal(c.MY_KEYS['older-key'],true);
});
test('the background service still processes both currencies automatically in WRITE mode', () => {
  const coins=[coin('0x01',1),coin('0x02',2,USD)],processed=[];
  const c=vm.createContext({Date,MDS:{init(){},load(){},keypair:{get:(k,cb)=>cb({})},cmd:(cmd,cb)=>cb({status:true,response:coins})},CasinoTimeouts:T});
  vm.runInContext(read(path.join(donor,'service.js')),c);
  c.MY_KEYS.house=true;c.MY_KEYS.player=true;c.SCRIPT_OK=true;c.WRITE_MODE=true;
  c.updateTimeoutReminder=()=>{};c.doReveal=b=>processed.push(b.coinid);c.doResolve=b=>processed.push(b.coinid);
  c.processCoins();assert.deepEqual(processed,['0x01','0x02']);
});
test('desktop reminder click opens My Bets and the last claim cancellation closes it', () => {
  const {EventEmitter}=require('node:events');const emitter=new EventEmitter(),sent=[],notices=[];
  class Notification {constructor(options){this.options=options;notices.push(this);}on(event,cb){this[event]=cb;}show(){}close(){this.closed=true;}}
  const c=vm.createContext({casino:{emitter},Notification,win:{isDestroyed:()=>false,isFocused:()=>true,isMinimized:()=>false,show(){},focus(){},webContents:{send:msg=>sent.push(msg)}}});
  vm.runInContext(sliceFunction(read(path.join(desktop,'main/main.js')),'let casinoClaimNotification =','// Casino background auto-processor'),c);
  emitter.emit('notify','claim');assert.equal(notices[0].options.silent,true);notices[0].click();assert.deepEqual(sent,['mcd:casinoClaims']);
  emitter.emit('notifycancel');assert.equal(notices[0].closed,true);
  assert.match(read(path.join(desktop,'renderer/app.js')),/onCasinoClaims\(\(\) => \{ casinoView = "mybets"; selectTab\("casino"\)/);
});
