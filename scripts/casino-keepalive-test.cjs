const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const donor=process.env.CASINO_DONOR||path.join(require('node:os').homedir(),'Projects/archive/Ideas/universal-casino/mds');
const policy=fs.readFileSync(path.join(donor,'timeout-claims.js'),'utf8'),offers=fs.readFileSync(path.join(donor,'offer-keepalive.js'),'utf8');
const USD='0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90',ADDR='0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F';
function coin(id='0x01',tokenid='0x00',age=500){const amount='0.123456789123456789';return{coinid:id,tokenid,amount:tokenid==='0x00'?amount:'0.000000000000000001',tokenamount:tokenid==='0x00'?undefined:amount,age,state:['0xAA','0xBB','0xCC','2','2',amount,'0','1500'].map((data,port)=>({port,data}))};}
function fixture(c=coin(),mem){mem=mem||{'casino_secret_for_0xCC':'0xDD','casino_hexaddr':'0xBB'};const commands=[];let mode='WRITE',fail='',onCommand=()=>{},writeOK=true;
 const mds={keypair:{get:(k,cb)=>cb({value:mem[k]}),set:(k,v,cb)=>{if(writeOK)mem[k]=v;if(cb)cb({status:writeOK});}},cmd:(command,cb)=>{commands.push(command);onCommand(command);if(command===fail||command.split(' ')[0]===fail)return cb&&cb({status:false});if(command==='checkmode')return cb({status:true,response:{mode}});if(command.startsWith('maths '))return cb({status:true,response:{result:'0.123456789123456789'}});if(cb)cb({status:true});},load(){},init(){},log(){},notify(){},notifycancel(){}};
 const ctx=vm.createContext({MDS:mds});vm.runInContext(policy+offers,ctx);
 return{ctx,mds,mem,commands,c,run(){let result;ctx.CasinoOffers.maintain(mds,c,k=>k==='0xAA','',(err,value)=>result={err,value});return result;},set mode(v){mode=v;},set fail(v){fail=v;},set onCommand(fn){onCommand=fn;},set writeOK(v){writeOK=v;}};
}
test('both currencies renew the exact collateral with one input/output, unchanged ports and no secret disclosure',()=>{
 for(const tok of ['0x00',USD]){const f=fixture(coin('0x01',tok));assert.equal(f.run().err,null);const cmds=f.commands;assert.equal(cmds.filter(s=>s.startsWith('txninput ')).length,1);const out=cmds.find(s=>s.startsWith('txnoutput '));assert.ok(out.includes('amount:0.123456789123456789 address:'+ADDR+' tokenid:'+tok+' storestate:true'));for(let p=0;p<8;p++)assert.ok(cmds.some(s=>s.includes('port:'+p+' value:'+f.c.state[p].data)));assert.ok(!cmds.some(s=>s.startsWith('send ')||s.includes('port:12')||s.includes('value:0xDD')));assert.ok(cmds.some(s=>s.startsWith('txnpost ')));assert.ok(cmds.at(-1).startsWith('txndelete '));}
});
test('young, foreign, invalid, missing-secret and READ-mode offers never post',()=>{
 let f=fixture(coin('0x01','0x00',499));assert.equal(f.run().err,null);assert.ok(!f.commands.some(s=>s.startsWith('txncreate ')));
 for(const mutation of [f=>f.c.age=-1,f=>f.c.state[0].data='0xEE',f=>f.c.state[1].data='[x];maths calculate:1+1;[x]',f=>f.c.state[6].data='1',f=>delete f.mem.casino_secret_for_0xCC,f=>f.mode='READ',f=>f.c.amount='1']){f=fixture();mutation(f);f.run();assert.ok(!f.commands.some(s=>s.startsWith('txnpost ')));}
});
test('every failed preparation step aborts without posting and cleans the temporary transaction',()=>{
 for(const fail of ['txncreate','txninput','txnoutput','txnstate','txnsign','txnbasics']){const f=fixture();f.fail=fail;assert.ok(f.run().err);assert.ok(!f.commands.some(s=>s.startsWith('txnpost ')));assert.ok(f.commands.at(-1).startsWith('txndelete '));}
});
test('durable cancellation aborts a renewal just before posting',()=>{
 const f=fixture();f.onCommand=cmd=>{if(cmd.startsWith('txnbasics '))f.ctx.CasinoOffers.requestCancel(f.mds,f.c,err=>assert.equal(err,null));};assert.match(f.run().err,/cancellation requested/);assert.ok(!f.commands.some(s=>s.startsWith('txnpost ')));
});
test('if renewal wins the race, cancellation follows its young successor after restart',()=>{
 const f=fixture();assert.equal(f.run().err,null);f.ctx.CasinoOffers.requestCancel(f.mds,f.c,err=>assert.equal(err,null));
 const next=fixture(coin('0x02',USD,1),f.mem);assert.equal(next.run().value.cancelled,true);assert.ok(next.commands.some(s=>s.startsWith('txninput ')&&s.endsWith('coinid:0x02')));assert.ok(next.commands.some(s=>s.startsWith('txnoutput ')&&s.includes('address:0xBB tokenid:'+USD+' storestate:false')));assert.ok(!next.commands.some(s=>s.startsWith('txnstate ')));
 const taken=fixture(coin('0x03',USD,1),f.mem);taken.c.state[6].data='1';taken.run();assert.ok(!taken.commands.some(s=>s.startsWith('txnpost ')));
});
test('failed cancellation persistence never acknowledges intent',()=>{
 const f=fixture();f.writeOK=false;let result;f.ctx.CasinoOffers.requestCancel(f.mds,f.c,e=>result=e);assert.ok(result);assert.equal(f.mem.casino_cancel_for_0xCC,undefined);assert.deepEqual(f.commands,[]);
});
test('actual service renews both currencies with the UI heartbeat fresh, bounded to two per scan',()=>{
 const f=fixture();let coins=[coin('0x01'),coin('0x02',USD),coin('0x03')];const old=f.mds.cmd;
 f.mds.cmd=(s,cb)=>s.startsWith('coins address:')?cb({status:true,response:coins}):old(s,cb);
 f.mds.load=rel=>vm.runInContext(fs.readFileSync(path.join(donor,rel),'utf8'),f.ctx);
 vm.runInContext(fs.readFileSync(path.join(donor,'service.js'),'utf8'),f.ctx);f.ctx.WRITE_MODE=true;f.ctx.SCRIPT_OK=true;f.ctx.MY_KEYS['0xAA']=true;f.mem.casino_tab_hb=String(Date.now());
 f.ctx.processCoins();assert.equal(f.commands.filter(s=>s.startsWith('txnpost ')).length,2);
 coins=[coin('0x11','0x00',1),coin('0x12',USD,1),coin('0x03','0x00',501)];f.ctx.processCoins();assert.equal(f.commands.filter(s=>s.startsWith('txnpost ')).length,3);
});
test('service discovers wallet keys created after startup before processing a new block',()=>{
 const f=fixture();let init;const old=f.mds.cmd;
 f.mds.init=cb=>init=cb;f.mds.cmd=(s,cb)=>s==='keys'?cb({status:true,response:{keys:[{publickey:'0xAA'}]}}):s.startsWith('coins address:')?cb({status:true,response:[f.c]}):old(s,cb);
 f.mds.load=rel=>vm.runInContext(fs.readFileSync(path.join(donor,rel),'utf8'),f.ctx);
 vm.runInContext(fs.readFileSync(path.join(donor,'service.js'),'utf8'),f.ctx);f.ctx.WRITE_MODE=true;f.ctx.SCRIPT_OK=true;
 assert.equal(f.ctx.MY_KEYS['0xAA'],undefined);init({event:'NEWBLOCK'});
 assert.equal(f.commands.filter(s=>s.startsWith('txnpost ')).length,1);
});
test('production APK and JS plans agree for every game/currency and pass the real Minima covenant',()=>{
 const {execFileSync}=require('node:child_process'),os=require('node:os');
 const apk=process.env.CASINO_APK||path.join(os.homedir(),'Projects/minima/apks/casino');
 const core=process.env.MINIMA_CORE_JAR||path.join(os.homedir(),'Projects/minima/core/minima-core/jar/minima.jar');
 assert.ok(fs.existsSync(core),'Set MINIMA_CORE_JAR to the real core jar for covenant validation');
 const cases=[];
 for(const token of ['0x00',USD])for(const range of [2,6,36]){
  const c=coin('0x01',token);c.state[3].data=c.state[4].data=String(range);
  const digits=String(123456789123456789n*BigInt(range-1)).padStart(19,'0');const collateral=digits.slice(0,-18)+'.'+digits.slice(-18);
  if(token==='0x00')c.amount=collateral;else c.tokenamount=collateral;
  const f=fixture(c),old=f.mds.cmd;f.mds.cmd=(s,cb)=>s.startsWith('maths ')?cb({status:true,response:{result:collateral}}):old(s,cb);
  assert.equal(f.run().err,null);cases.push({coin:c,commands:f.commands});
 }
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'casino-offer-oracle-'));
 try{
  fs.writeFileSync(path.join(tmp,'cases.json'),JSON.stringify(cases));
  const classes=path.join(apk,'app/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes'),cp=classes+path.delimiter+core;
  const src=path.join(apk,'app/src/main/java/com/eurobuddha/casino');
  execFileSync('javac',['-encoding','UTF-8','-cp',cp,'-d',tmp,path.join(src,'Bet.java'),path.join(src,'OfferKeepAlive.java'),path.join(__dirname,'CasinoOfferOracle.java')]);
  const result=execFileSync('java',['-cp',tmp+path.delimiter+cp,'com.eurobuddha.casino.CasinoOfferOracle',path.join(tmp,'cases.json')],{encoding:'utf8'});
  assert.match(result,/6 production APK\/JS plans identical/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('desktop Cancel persists intent before any transaction and aborts on persistence failure',()=>{
 const {createContext}=require('../main/casino/loader.js');
 for(const writeOK of [true,false]){
  const f=fixture();f.writeOK=writeOK;const old=f.mds.cmd;
  f.mds.cmd=(s,cb)=>s.startsWith('coins address:')?cb({status:true,response:[f.c]}):old(s,cb);
  f.onCommand=s=>{if(s.startsWith('txncreate '))assert.equal(f.mem.casino_cancel_for_0xCC,'1');};
  const ctx=createContext(f.mds);ctx.READY=true;ctx.MY_KEYS['0xAA']=true;ctx.MY_HEX_ADDR='0xBB';
  let error;ctx.CASINO.cancelBet(f.c.coinid,e=>error=e);
  assert.equal(!!error,!writeOK);assert.equal(f.commands.some(s=>s.startsWith('txncreate ')),writeOK);
 }
});
test('MDS Cancel persists intent before invoking the existing cancellation builder',()=>{
 const html=fs.readFileSync(path.join(donor,'index.html'),'utf8');
 for(const writeOK of [true,false]){
  const f=fixture();f.writeOK=writeOK;let started=false,error;
  Object.assign(f.ctx,{BETS:[f.c],getState:f.ctx.CasinoTimeouts.state,isMyKey:k=>k==='0xAA',document:{getElementById:()=>({})},showErr:(el,e)=>error=e,cancelBetNow:()=>{assert.equal(f.mem.casino_cancel_for_0xCC,'1');started=true;}});
  vm.runInContext(html.slice(html.indexOf('function cancelBet(coinid,'),html.indexOf('function cancelBetNow(')),f.ctx);
  f.ctx.cancelBet(f.c.coinid,'status',null);assert.equal(started,writeOK);assert.equal(!!error,!writeOK);
 }
});
