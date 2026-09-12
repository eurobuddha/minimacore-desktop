const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../main/parlons-calls.js'),'utf8');
async function fixture(){
 const events={},ses={},notices=[];let focused=0,panel=0;
 const w={isDestroyed:()=>false,isMinimized:()=>true,restore(){},show(){},focus(){focused++;},flashFrame(){}};
 const electron={app:{whenReady:()=>Promise.resolve(),on:(e,f)=>{events[e]=f;}},session:{fromPartition:()=>ses},systemPreferences:{askForMediaAccess:async()=>true},Notification:class{static isSupported(){return true;}constructor(){notices.push(this);}on(){}show(){}close(){}}};
 ses.setPermissionCheckHandler=f=>ses.check=f;ses.setPermissionRequestHandler=f=>ses.request=f;
 const ctx=vm.createContext({module:{exports:{}},require:n=>{assert.equal(n,'electron');return electron;},URL,process:{platform:'darwin'}});vm.runInContext(source,ctx);
 ctx.module.exports.install({port:()=>12345,window:()=>w,focusPanel:()=>panel++});await Promise.resolve();
 const listeners={},wc={getType:()=> 'webview',session:ses,getURL:()=> 'http://127.0.0.1:12345/',isDestroyed:()=>false,on:(e,f)=>listeners[e]=f};
 events['web-contents-created']({},wc);
 return {ses,wc,listeners,get focused(){return focused;},get panel(){return panel;},notices,isPanel:ctx.module.exports.isPanel};
}
test('media permission is restricted to the exact trusted guest and requesting origin',async()=>{
 const f=await fixture();assert.equal(f.ses.check(f.wc,'media','http://127.0.0.1:12345'),true);
 for(const origin of ['http://127.0.0.1:12345.evil','https://127.0.0.1:12345','http://127.0.0.1:12346','http://evil@127.0.0.1:12345'])assert.equal(f.ses.check(f.wc,'media',origin),false);
 assert.equal(f.ses.check(f.wc,'geolocation','http://127.0.0.1:12345'),false);
 const request=(details)=>new Promise(resolve=>f.ses.request(f.wc,'media',resolve,details));
 assert.equal(await request({requestingUrl:'http://127.0.0.1:12345/',isMainFrame:true,mediaTypes:['audio','video']}),true);
 assert.equal(await request({requestingUrl:'http://evil.example/',isMainFrame:true}),false);
 assert.equal(await request({requestingUrl:'http://127.0.0.1:12345/',isMainFrame:false}),false);
 f.wc.getType=()=> 'window';assert.equal(f.ses.check(f.wc,'media','http://127.0.0.1:12345'),false);
});
test('only the panel gets autoplay and unthrottled timers, and cannot share its partition with dapps',async()=>{
 const f=await fixture(),prefs={};let blocked=false;
 f.listeners['will-attach-webview']({preventDefault:()=>blocked=true},prefs,{src:'http://127.0.0.1:12345/open'});
 assert.equal(prefs.partition,'persist:parlons');assert.equal(prefs.backgroundThrottling,false);assert.equal(prefs.autoplayPolicy,'no-user-gesture-required');assert.equal(blocked,false);
 f.listeners['will-attach-webview']({preventDefault:()=>blocked=true},{},{src:'https://127.0.0.1:9003/dapp',partition:'persist:parlons'});assert.equal(blocked,true);
});
test('incoming state brings forward the panel once and refuses untrusted navigation',async()=>{
 const f=await fixture();f.listeners['page-title-updated']({},'Parlons — INCOMING_RINGING');f.listeners['page-title-updated']({},'Parlons — INCOMING_RINGING');assert.equal(f.focused,1);assert.equal(f.panel,1);
 f.listeners['page-title-updated']({},'Parlons — ENDED');f.wc.getURL=()=> 'https://evil.example';f.listeners['page-title-updated']({},'Parlons — INCOMING_RINGING');assert.equal(f.focused,1);
});
