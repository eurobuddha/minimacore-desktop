const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const root=process.env.PP_ENGINE_ROOT||path.resolve(__dirname,'../main/pandapools');
const desktop=process.env.PP_DESKTOP_ROOT||path.resolve(__dirname,'..');
const {makeSqlShim}=require(path.join(desktop,'main/pandapools/sqlshim.js'));
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const addr=hash(100),opk=hash(101),oadr=hash(102),tok=hash(103);
const good=response=>({status:true,response});
function coin(n,token='0x00',amount='10'){return {coinid:hash(n),address:addr,tokenid:token,amount,tokenamount:amount,spent:false,state:[],created:1000,token:{name:'Test',decimals:8}};}
const invoke=(fn,...args)=>new Promise(r=>fn(...args,r));
async function harness(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-reserve-test-')),file=path.join(dir,'pool.sqlite'),sql=await makeSqlShim(file);
 const trace=[],timers=new Set();let responder=()=>({status:false}),sqlFail=()=>false,disk=true;
 const c={console,setTimeout:(f,ms)=>{const t=setTimeout(()=>{timers.delete(t);f();},ms);timers.add(t);return t;},clearTimeout:t=>{timers.delete(t);clearTimeout(t);},setInterval,clearInterval};
 c.MDS={sql:(q,cb)=>sqlFail(q)?cb({status:false}):sql.sql(q,cb),cmd:(q,cb)=>{trace.push(q);const r=responder(q,cb);if(r!==undefined&&cb)cb(r);},log(){},init(){},persistRecovery:cb=>cb(disk&&sql.flushChecked())};
 c.self=c;vm.createContext(c);
 for(const f of ['decimal.js','covenant.js','curve.js','router.js','book.js','store.js','poolmgr.js','reserve-recovery.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c,{filename:f});
 await invoke(c.Store.init);
 const e={addr,opk,oadr,tok,dec:8,kmin:'50',opkuses:590,script:c.Covenant.script(opk,oadr,tok,'50')};
 const p={address:addr,opk,oadr,tok,tokDecimals:8,kmin:'50',script:e.script,minimumOwnerUses:590,signingStateUnverified:false};
 return {c,sql,file,e,p,trace,set:f=>responder=f,failSql:f=>sqlFail=f,disk:v=>disk=v,close:()=>{for(const t of timers)clearTimeout(t);sql.flush();sql._db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
function standard(h,cs=[]){return q=>{
 if(q==='txnlist')return good([]);
 if(q==='checkmode')return good({writemode:true});
 if(q.startsWith('runscript '))return good({parseok:true,script:{address:addr}});
 if(q.startsWith('newscript '))return good({address:addr});
 if(q.startsWith('balance '))return good([{coins:cs.length}]);
 if(q.startsWith('coins address:'))return good(cs);
 if(q.startsWith('coins coinid:'))return good(cs.filter(c=>q.includes(c.coinid)));
 if(q==='status')return good({megammr:false});
 if(q==='keys'||q.startsWith('keys action:list'))return good([{publickey:opk,uses:846,modifier:'0x40'}]);
 if(q.startsWith('scripts address:'))return good({address:q.split(':')[1],simple:true,publickey:opk});
 return {status:false};};}
async function restore(h,archive=null){return invoke(h.c.ReserveRecovery.restore,JSON.stringify({pandapools_backup:3,pools:[h.e]}),archive,null);}
test('current live reserves beat expired proofs; restore quarantines even a higher current counter',async()=>{
 const h=await harness();try{h.e.cm='0xdead';h.set(standard(h,[coin(1),coin(2,tok)]));const r=await restore(h);assert.equal(r.restored,1);assert(!h.trace.some(q=>q.startsWith('coinimport')||q.startsWith('coincheck')));const ps=await invoke(h.c.Store.ownAll);assert(ps[0].signingStateUnverified);assert.equal(ps[0].minimumOwnerUses,590);const error=await invoke(h.c.ReserveRecovery.checkSignature,[hash(1)],'auto');assert.match(error,/paused/);assert(!h.trace.some(q=>/^(sign|txnsign|txnpost|newaddress)/.test(q)));}finally{h.close();}
});
test('stale snapshot falls back to current archive IDs, validated by receiver before import',async()=>{
 const h=await harness();try{let cs=[];const fresh=[coin(3),coin(4,tok)],base=()=>standard(h,cs);h.e.cm='0xdead';h.set(q=>{if(q.startsWith('coincheck'))return good(q.includes('dead')?{valid:false}:{valid:true,coin:q.endsWith('0xaa')?fresh[0]:fresh[1]});if(q.startsWith('coinimport')){cs.push(q.endsWith('0xaa')?fresh[0]:fresh[1]);return good({});}return base()(q);});const commands=[];const archive=(q,cb)=>{commands.push(q);if(q==='status')cb(good({megammr:true}));else if(q.startsWith('balance'))cb(good([{coins:2}]));else if(q.startsWith('coins'))cb(good(fresh));else cb(good({data:q.includes(hash(3))?'0xaa':'0xbb'}));};const r=await restore(h,archive);assert.equal(r.restored,1);assert(commands.includes('coinexport coinid:'+hash(3)));assert(h.trace.indexOf('coincheck data:0xaa')<h.trace.indexOf('coinimport track:true data:0xaa'));}finally{h.close();}
});
test('wrong-address proof, failed imports and archive outage preserve unresolved recipe and report zero',async()=>{
 for(const kind of ['wrong','importfail','outage']){const h=await harness();try{h.e.cm='0xaa';h.e.ct='0xbb';const base=standard(h);h.set(q=>q.startsWith('coincheck')?good({valid:true,coin:kind==='wrong'?{...coin(1),address:hash(999)}:q.endsWith('aa')?coin(1):coin(2,tok)}):base(q));const r=await restore(h,(_q,cb)=>cb(null));assert.equal(r.restored,0,kind);assert.equal((await invoke(h.c.Store.ownAll)).length,1);if(kind==='wrong')assert(!h.trace.some(q=>q.startsWith('coinimport')));}finally{h.close();}}
});
test('invalid recipe and covenant address mismatch never track, import or save',async()=>{
 for(const kind of ['injection','address']){const h=await harness();try{if(kind==='injection')h.e.opk+=';send amount:1';h.set(q=>q.startsWith('runscript')?good({parseok:true,script:{address:hash(999)}}):{status:false});assert.equal((await restore(h)).restored,0);assert.equal((await invoke(h.c.Store.ownAll)).length,0);assert(!h.trace.some(q=>/^(newscript|coinimport)/.test(q)));}finally{h.close();}}
});
test('failed durable recipe write prevents tracking/import and retains signing hold in memory',async()=>{
 const h=await harness();try{h.disk(false);h.set(standard(h,[coin(1),coin(2,tok)]));assert.equal((await restore(h)).restored,0);assert(!h.trace.some(q=>/^(newscript|coinimport)/.test(q)));assert((await invoke(h.c.Store.ownAll))[0].signingStateUnverified);}finally{h.close();}
});
test('crowded address uses saved exact IDs and ordinary reads preserve owner metadata',async()=>{
 const h=await harness();try{Object.assign(h.p,{coinidM:hash(1),coinidT:hash(2),reserveM:new h.c.Decimal(10),reserveT:new h.c.Decimal(10),signingStateUnverified:true});assert(await invoke(h.c.Store.ownRecord,h.p));const p={...h.p,coinidM:'',coinidT:'',minimumOwnerUses:-1,signingStateUnverified:false};const base=standard(h,[coin(1),coin(2,tok)]);h.set(q=>q.startsWith('balance')?good([{coins:999}]):base(q));assert(await invoke(h.c.ReserveRecovery.readReserves,p));assert(!h.trace.some(q=>q.startsWith('coins address:')));assert.equal(p.minimumOwnerUses,590);assert(p.signingStateUnverified);const ps=await invoke(h.c.Store.ownAll);assert.equal(ps[0].coinidM,hash(1));assert.equal(ps[0].minimumOwnerUses,590);}finally{h.close();}
});
test('dust and raw token amount never count as fully recovered reserves',async()=>{
 const h=await harness();try{h.set(standard(h,[coin(1,'0x00','0.001'),coin(2,tok,'0.001')]));assert.equal((await restore(h)).restored,0);const c=coin(2,tok);delete c.tokenamount;assert.equal(h.c.ReserveRecovery.coinFor(h.p,c),false);}finally{h.close();}
});
test('actual input script key is checked after delayed key read and newly installed hold',async()=>{
 const h=await harness();try{let delayed;const base=standard(h,[{...coin(1),address:hash(999)}]);h.set((q,cb)=>{if(q==='keys'){delayed=cb;return;}return base(q);});const pending=invoke(h.c.ReserveRecovery.checkSignature,[hash(1)],'auto');assert(delayed);h.p.signingStateUnverified=true;await invoke(h.c.Store.ownRecord,h.p);delayed(good([{publickey:opk,uses:846}]));assert.match(await pending,/paused/);}finally{h.close();}
});
test('failed signing confirmation keeps latch even if rollback SQL fails; successful retry clears it durably',async()=>{
 const h=await harness();try{h.p.signingStateUnverified=true;await invoke(h.c.Store.ownRecord,h.p);h.set(standard(h,[coin(1),coin(2,tok)]));h.disk(false);h.failSql(q=>q.startsWith('UPDATE pp_ownpools SET signing_unverified=1'));assert.equal(await invoke(h.c.ReserveRecovery.confirmKey,opk),false);assert(h.c.Store.confirmationFailed(opk));assert.match(await invoke(h.c.ReserveRecovery.checkSignature,[hash(1)],'auto'),/paused/);h.disk(true);h.failSql(()=>false);assert.equal(await invoke(h.c.ReserveRecovery.confirmKey,opk),true);assert.equal(await invoke(h.c.ReserveRecovery.checkSignature,[hash(1)],'auto'),null);const reopened=await makeSqlShim(h.file);assert.equal(reopened.sql('SELECT signing_unverified,opkuses FROM pp_ownpools').rows[0].SIGNING_UNVERIFIED,0);reopened._db.close();}finally{h.close();}
});
test('backup discards proofs if reserves move mid-export and retains current counter floor',async()=>{
 const h=await harness();try{await invoke(h.c.Store.ownRecord,h.p);let moved=false;h.set(q=>{if(q.startsWith('coinexport')){const c=q.includes(hash(1))?coin(1):coin(2,tok);if(q.includes(hash(2)))moved=true;return good({data:'0xaa',coinproof:{coin:c,proof:{blocktime:1100}}});}return standard(h,moved?[coin(3),coin(4,tok)]:[coin(1),coin(2,tok)])(q);});const r=await invoke(h.c.ReserveRecovery.backup,1200),e=JSON.parse(r.json).pools[0];assert(!e.cm&&!e.ct);assert.match(e.proof_warning,/moved/);assert.equal(e.opkuses,846);assert.equal((await invoke(h.c.Store.ownAll))[0].minimumOwnerUses,846);}finally{h.close();}
});
test('archive endpoint and command whitelist reject credential and command injection',async()=>{
 const h=await harness();try{const r=h.c.ReserveRecovery;assert(r.validEndpoint('https://archive.example.com:123/path'));for(const url of ['http://example.com','https://user:pass@example.com','https://127.0.0.1','https://node.local','https://example.com?cmd=send','https://example.com/#x'])assert(!r.validEndpoint(url),url);assert(r.allowedArchive('coins coinid:'+hash(1)+' megammr:true'));assert(!r.allowedArchive('coinexport coinid:'+hash(1)+';send'));}finally{h.close();}
});
test('headless shipped service blocks signatures for quarantined actual auto signer',async()=>{
 const h=await harness();try{h.p.signingStateUnverified=true;await invoke(h.c.Store.ownRecord,h.p);h.set(standard(h,[coin(1)]));const c={MDS:h.c.MDS};vm.createContext(c);vm.runInContext(['decimal.js','covenant.js','curve.js','reserve-recovery.js','service.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n'),c);const cmds=['txninput id:test coinid:'+hash(1),'txnsign id:test publickey:auto'];const ok=await invoke(c.runCmds,cmds,1);assert.equal(ok,false);assert(!h.trace.some(q=>q.startsWith('txnsign')));}finally{h.close();}
});
test('old-schema upgrade quarantines existing recipes while an explicitly new pool is trusted',async()=>{
 const h=await harness();try{
  h.sql.sql('DROP TABLE pp_ownpools');h.sql.sql('CREATE TABLE pp_ownpools(address varchar(80) primary key,mx text,opk text,oadr text,tok text,tdec int,kmin text,script text)');
  h.sql.sql(`INSERT INTO pp_ownpools VALUES('${addr}','','${opk}','${oadr}','${tok}',8,'50','${h.e.script}')`);
  await invoke(h.c.Store.init);let ps=await invoke(h.c.Store.ownAll);assert(ps[0].signingStateUnverified);
  await invoke(h.c.Store.ownRecord,h.p);assert((await invoke(h.c.Store.ownAll))[0].signingStateUnverified);
  const fresh={...h.p,address:hash(555),opk:hash(556),signingStateUnverified:false};assert(await invoke(h.c.Store.ownRecord,fresh));ps=await invoke(h.c.Store.ownAll);assert.equal(ps.find(p=>p.address===fresh.address).signingStateUnverified,false);
 }finally{h.close();}
});
test('read-only MDS signing never creates pending commands; restore cancels only owned pool transaction IDs',async()=>{
 const h=await harness();try{const base=standard(h,[coin(1),coin(2,tok)]);h.set(q=>q==='checkmode'?good({writemode:false}):base(q));assert.match(await invoke(h.c.ReserveRecovery.checkSignature,[hash(1)],'auto'),/WRITE mode/);assert(!h.trace.some(q=>q.startsWith('txnsign')));
 h.set(q=>q==='txnlist'?good([{id:'ppclose_123_ab'},{id:'other_app_123'}]):q.startsWith('txndelete ')?good({}):base(q));assert.equal((await restore(h)).restored,1);assert(h.trace.includes('txndelete id:ppclose_123_ab'));assert(!h.trace.includes('txndelete id:other_app_123'));assert(h.trace.indexOf('txndelete id:ppclose_123_ab')<h.trace.findIndex(q=>q.startsWith('runscript')));
 }finally{h.close();}
});
test('corrupt existing Desktop database cannot be silently replaced',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-bad-db-')),file=path.join(dir,'pool.sqlite');fs.writeFileSync(file,'corrupt saved recipe database');
 try{await assert.rejects(async()=>{const s=await makeSqlShim(file);s.sql('SELECT * FROM sqlite_master');s._db.close();});assert.equal(fs.readFileSync(file,'utf8'),'corrupt saved recipe database');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('MDS archive stream rejects oversized content and aborts the request',async()=>{
 const h=await harness();try{await invoke(h.c.ReserveRecovery.saveArchive,'https://archive.example.com');let aborted=false,cancelled=false;h.c.AbortController=class{constructor(){this.signal={};}abort(){aborted=true;}};h.c.TextDecoder=TextDecoder;
 h.c.fetch=async()=>({ok:true,headers:{get:()=>null},body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(256001)}),cancel:async()=>{cancelled=true;}})}});
 const archive=await invoke(h.c.ReserveRecovery.configuredArchive);assert.equal(await invoke(archive,'status'),null);assert(aborted&&cancelled);
 }finally{h.close();}
});
test('headless refresh validates KMIN and preserves oldest leg age without browser timers',async()=>{
 const h=await harness();try{const c={MDS:h.c.MDS};vm.createContext(c);vm.runInContext(['decimal.js','covenant.js','curve.js','reserve-recovery.js','service.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n'),c);
 const p={...h.p};assert(c.fillReservesSvc(p,good([{...coin(1),created:100},{...coin(2,tok),created:1999}])));assert.equal(Math.min(p.reserveBlockM,p.reserveBlockT),100);
 assert.equal(c.fillReservesSvc(p,good([coin(1),coin(2,tok,'0.001')])),false);const raw=coin(2,tok);delete raw.tokenamount;assert.equal(c.fillReservesSvc(p,good([coin(1),raw])),false);
 }finally{h.close();}
});
test('discovery preserves a confirmed signing state; unknown new discovery remains held',async()=>{
 const h=await harness();try{assert(await invoke(h.c.Store.ownRecord,h.p));const found={...h.p};delete found.signingStateUnverified;assert(await invoke(h.c.Store.ownRecord,found));assert.equal((await invoke(h.c.Store.ownAll))[0].signingStateUnverified,false);found.address=hash(777);assert(await invoke(h.c.Store.ownRecord,found));assert((await invoke(h.c.Store.ownAll)).find(p=>p.address===found.address).signingStateUnverified);}finally{h.close();}
});
test('foreign cleanup never untracks a recipe restored while a coin reply was delayed',async()=>{
 const h=await harness();try{let waiting;h.set((q,cb)=>{if(q.startsWith('coins relevant:true')){waiting=cb;return;}return standard(h)(q);});const c={MDS:h.c.MDS};vm.createContext(c);vm.runInContext(['decimal.js','covenant.js','curve.js','reserve-recovery.js','service.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n'),c);
 c.untrackNextAddress([{address:addr,opk,script:h.e.script,track:false}],0);assert(waiting);h.p.signingStateUnverified=true;await invoke(h.c.Store.ownRecord,h.p);waiting(good([coin(1)]));assert(!h.trace.some(q=>q.startsWith('cointrack')||q.startsWith('newscript trackall:false')));
 }finally{h.close();}
});
test('foreign and unchanged owned reserve scans never flush the whole database',async()=>{
 const h=await harness();try{h.set(standard(h,[coin(1),coin(2,tok)]));let writes=0;const persist=h.c.MDS.persistRecovery;h.c.MDS.persistRecovery=cb=>{writes++;persist(cb);};
 assert(await invoke(h.c.ReserveRecovery.readReserves,{...h.p}));assert.equal(writes,0);
 await invoke(h.c.Store.ownRecord,h.p);assert(await invoke(h.c.ReserveRecovery.readReserves,h.p));const after= writes;
 assert(await invoke(h.c.ReserveRecovery.readReserves,h.p));assert.equal(writes,after);
 }finally{h.close();}
});
test('Book discovery populates both young reserve ages for the foreground refresh gate',async()=>{
 const h=await harness();try{const base=standard(h,[{...coin(1),created:1998},{...coin(2,tok),created:1999}]);h.set(q=>q==='scripts'?good([{script:h.e.script,address:addr,track:true}]):q.startsWith('coins simplestate:')?good([]):base(q));
 const pools=await invoke(h.c.Book.scan);assert.equal(pools.length,1);assert.equal(pools[0].reserveBlockM,1998);assert.equal(pools[0].reserveBlockT,1999);assert(2000-Math.min(pools[0].reserveBlockM,pools[0].reserveBlockT)<900);assert(!h.trace.some(q=>q.startsWith('txnsign')));
 }finally{h.close();}
});
test('MDS and Desktop cards retain full unresolved address and recovery/signing actions',async()=>{
 const h=await harness();try{h.p.signingStateUnverified=true;await invoke(h.c.Store.ownRecord,h.p);
 const donor=process.env.PP_MDS_ROOT||path.resolve(desktop,'../../mds/pandapools-mds');
 const html=fs.readFileSync(path.join(donor,'index.html'),'utf8'),elements={};
 Object.assign(h.c,{POOLS:[],pendingCreate:null,mine:()=>true,withSnapshots:(_ps,cb)=>cb(),D:h.c.Decimal,el:id=>elements[id]||(elements[id]={})});
 vm.runInContext(html.slice(html.indexOf('    function renderMyLp()'),html.indexOf('    function withSnapshots'))+'\n'+html.split('\n').find(l=>l.includes('function btn(label,'))+'\n'+html.split('\n').find(l=>l.includes('function esc(s)')),h.c);
 h.c.renderMyLp();const card=elements.lpList.innerHTML;assert(card.includes(addr));assert(card.includes('Recover reserves'));assert(card.includes('Owner signing paused'));assert.equal(elements.lpValue.innerText,'Reserves unavailable');
 const renderer=fs.readFileSync(path.join(desktop,'renderer/app.js'),'utf8'),c={TOK:{shortId:s=>s},esc:s=>String(s).replace(/</g,'&lt;'),short:s=>s};vm.createContext(c);vm.runInContext(renderer.slice(renderer.indexOf('function ppNum('),renderer.indexOf('function wirePpMineActions(')),c);
 const desktopCard=c.ppMineHtml([{address:addr,opk,tok,unresolved:true,signingStateUnverified:true}]);assert(desktopCard.includes(addr));assert(desktopCard.includes('data-pprecover'));assert(desktopCard.includes('data-ppconfirm'));assert(!desktopCard.includes('data-ppwd'));
 }finally{h.close();}
});
