const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const desktop=process.env.PP_DESKTOP_ROOT||path.resolve(__dirname,'..');
const actualSql=require(path.join(desktop,'main/pandapools/sqlshim'));
const loader=require(path.join(desktop,'main/pandapools/loader'));
const hash=n=>'0x'+n.toString(16).padStart(64,'0');
async function harness(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-lifecycle-')),contexts=[],stores=[],commands=[];let disk=true;
 const exports={};const sandbox={module:{exports},exports,console,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},require:n=>{
  if(n==='electron')return {app:{getPath:()=>dir,getVersion:()=> 'test'}};
  if(n==='./config')return {rpcSecret:()=>''};if(n==='./node-manager')return {rpcPort:()=>0};
  if(n==='./rpc')return {rpcCall:async()=>({status:false})};if(n==='./netfetch')return {fetchJson:async()=>null};
  if(n==='./pandapools/loader')return {...loader,createContext:(...args)=>{const c=loader.createContext(...args);contexts.push(c);return c;}};
  if(n==='./pandapools/sqlshim')return {makeSqlShim:async file=>{const sql=await actualSql.makeSqlShim(file),flush=sql.flushChecked;sql.flushChecked=()=>disk&&flush();stores.push(sql);return sql;}};
  return require(n);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(desktop,'main/pandapools.js'),'utf8'),sandbox,{filename:'main/pandapools.js'});
 const api=sandbox.module.exports;api._setDataDir(dir);api._setRunner(async q=>{commands.push(q);if(q==='block')return {status:true,response:{block:0}};return {status:false};});
 return {api,contexts,stores,commands,dir,disk:v=>disk=v,close:()=>{api.stopLoop();for(const c of contexts)c.ActivityChain.stop();for(const sql of stores){try{sql.flush();sql._db.close();}catch(e){}}fs.rmSync(dir,{recursive:true,force:true});}};
}
test('wallet reset preserves recipes and floors, and failed quarantine persistence blocks every reinitialization',async()=>{
 const h=await harness();try{await h.api.init();const c=h.contexts.at(-1),p={address:hash(1),opk:hash(2),oadr:hash(3),tok:hash(4),tokDecimals:8,kmin:'50',minimumOwnerUses:846,signingStateUnverified:false};p.script=c.Covenant.script(p.opk,p.oadr,p.tok,p.kmin);
 assert(await new Promise(r=>c.Store.ownRecord(p,r)));h.disk(false);
 await assert.rejects(h.api.invalidate(),/signing holds/);await assert.rejects(h.api.init(),/signing holds/);
 const before=await actualSql.makeSqlShim(path.join(h.dir,'pandapools.sqlite'));assert.equal(before.sql('SELECT opkuses,signing_unverified FROM pp_ownpools').rows[0].SIGNING_UNVERIFIED,0);before._db.close();
 assert(!h.commands.some(q=>/^(txnsign|sign|consolidate|send|txnpost)\b/.test(q)));
 h.disk(true);await h.api.init();const after=await actualSql.makeSqlShim(path.join(h.dir,'pandapools.sqlite'));const row=after.sql('SELECT opkuses,signing_unverified FROM pp_ownpools').rows[0];assert.equal(row.OPKUSES,846);assert.equal(row.SIGNING_UNVERIFIED,1);after._db.close();
 const mine=await h.api.myPools();assert.equal(mine.length,1);assert(mine[0].unresolved&&mine[0].signingStateUnverified);
 }finally{h.close();}
});
test('invalidation before first initialization also quarantines an existing saved database',async()=>{
 const h=await harness();try{const file=path.join(h.dir,'pandapools.sqlite'),sql=await actualSql.makeSqlShim(file);sql.sql('CREATE TABLE pp_ownpools(address text primary key,mx text,opk text,oadr text,tok text,tdec int,kmin text,script text,opkuses int,signing_unverified int,lastcoinm text,lastcoint text)');sql.sql(`INSERT INTO pp_ownpools VALUES('${hash(1)}','','${hash(2)}','${hash(3)}','${hash(4)}',8,'50','script',846,0,'','')`);assert(sql.flushChecked());sql._db.close();
 await h.api.invalidate();const reopened=await actualSql.makeSqlShim(file);assert.equal(reopened.sql('SELECT signing_unverified FROM pp_ownpools').rows[0].SIGNING_UNVERIFIED,1);reopened._db.close();
 }finally{h.close();}
});
