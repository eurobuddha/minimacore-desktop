// Browser test with the desktop's offline preview bridge.
"use strict";
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url");
const assert=require("node:assert/strict"),test=require("node:test");
function fixture(){
  const m=window.mcd;
  const config={setupDone:false,walletDone:false,params:{},network:"mainnet",heapMb:0,basePort:17001,megammrHost:"example.test:9001"};
  window.setupFixture=config;
  Object.assign(m,{getConfig:async()=>({...config}),saveConfig:async p=>({...Object.assign(config,p)}),flavor:async()=>({id:"pandamonium"}),
    keyMode:async()=>({supported:true,mode:""}),recordKeyMode:async m=>m,nodeStart:async()=>true,
    nodeRestart:async(_,p)=>{Object.assign(config,p);return true;},setupSnapshot:async()=>{config.guideStage="network";},
    setupAudit:async(...args)=>{if(args.length!==3 || args[1]!=="classic" || args[2]!==true || args[0]!==Array(24).fill("ABANDON").join(" "))throw Error("unexpected audit arguments");return {ticket:"test",classic:64,block:32,minimum:256,reused:0};},
    setupSnapshotProgress:async()=>null});
}
async function exercise(){
  try{
    const pause=()=>new Promise(r=>setTimeout(r,35));
    const click=async name=>{const b=[...document.querySelectorAll("#setupBody button")].find(b=>b.textContent===name);if(!b)throw Error(name);b.click();await pause();};
    await pause();
    await click("I have a wallet");await click("I’m not sure");if(!el("guideNote").textContent.includes("KeyUses"))throw Error("missing help");
    await click("Minima Classic · 64 keys");await click("Move to block-based keys");await click("Continue");await click("Restore Wallet");
    if(!el("setupBody").querySelector(".we-box") || guideRoute!=="migrate")throw Error("migration restore");
    if(document.querySelector("#setupBody .guide-content > label input"))throw Error("restore requested another input");
    for(const box of document.querySelectorAll("#setupBody .we-box")){box.value="abandon";box.dispatchEvent(new Event("input"));}
    await click("Check wallet and key uses");
    if(!el("setupBody").textContent.includes("Checked 64 classic and 32 block-based addresses"))throw Error("seed-only audit failed");
    const input=el("setupBody").querySelector("input[inputmode=numeric]");
    if(!input || parseFloat(getComputedStyle(input).borderTopWidth)<1 || getComputedStyle(input).borderTopStyle==="none" || document.activeElement===input)throw Error("key-use field needs a visible resting border");
    guideWelcome();await click("I have a wallet");await click("Minima Classic · 64 keys");await click("Keep my classic addresses");
    if(guideRoute!=="classic")throw Error("classic retention");
    guideWelcome();await click("I have a wallet");await click("Block key uses · 32 keys");
    if(guideRoute!=="block")throw Error("block restore");
    guideWelcome();await click("I’m new to Minima");await click("Continue");await click("Create my wallet");
    const c=window.setupFixture;
    if(!c.params.server || !c.params.keetschatonly || !c.params.keets || !c.params.megammr || !c.contribute || c.params.megaprune || c.params.megaprunestate || c.params.megaprunetokens || c.guideSource!=="spartacus")throw Error("wrong defaults");
    CFG=await api.saveConfig({walletDone:true});running=true;
    const s={state:"running",health:{block:45,incoming:0},portmap:{state:"no_gateway",lanIp:"192.168.1.8"}};
    guideTick(s);await pause();guideTick(s);
    if(!el("guideRouter").textContent.includes("17001") || !el("guideRouter").textContent.includes("192.168.1.8"))throw Error("forwarding details");
    if(!c.params.keetschatonly)throw Error("switched just because a router was quiet");
    guideTick({...s,portmap:{state:"double_nat"}});await pause();
    if(c.params.keetschatonly || !c.params.keets || !c.params.server || c.guideFallback)throw Error("fallback");
    CFG=await api.saveConfig({guideStage:"download",guideSource:"eurobuddha",guideFallback:false});
    let fail;
    api.setupSnapshot=()=>new Promise((_,reject)=>{fail=reject;});
    api.setupSnapshotProgress=async()=>({bytes:20,total:100,url:"https://eurobuddha.com/mega.mmr"});
    const job=guideDownload();
    if(!el("guideFileSource").textContent.includes("eurobuddha.com"))throw Error("selected source missing");
    guideTick(s);await pause();
    if(!el("guideFileSource").textContent.includes("/mega.mmr") || el("guideNote").textContent!=="20%")throw Error("resolved file missing");
    fail(Error("fixture"));await job;
    if(!el("setupBody").textContent.includes("/mega.mmr"))throw Error("missing file on retry screen");
    document.documentElement.dataset.setupTest="passed";
  }catch(e){document.documentElement.dataset.setupTest=e.message;}
}
const chrome=[process.env.CHROME_BIN,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/usr/bin/google-chrome","/usr/bin/chromium"].find(f=>f&&fs.existsSync(f));
function browserExercise(run) {
  const renderer=path.resolve(__dirname,"../renderer"),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"pandamonium-setup-ui-"));
  try{
    const stub=pathToFileURL(path.join(__dirname,"dev-preview","stub.js"));
    const page=fs.readFileSync(path.join(renderer,"index.html"),"utf8")
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,"")
      .replace("<head>",`<head><base href="${pathToFileURL(renderer+path.sep)}">`)
      .replace('<script src="i18n.js">',`<script src="${stub}"></script><script>(${fixture})();</script><script src="i18n.js">`)
      .replace("</body>",`<script>(${run})();</script></body>`);
    const file=path.join(tmp,"wallet.html");fs.writeFileSync(file,page);
    const html=execFileSync(chrome,["--headless","--disable-gpu","--no-first-run","--user-data-dir="+path.join(tmp,"profile"),"--allow-file-access-from-files","--window-size=680,690","--virtual-time-budget=8500","--dump-dom",pathToFileURL(file).href],{encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:5e6,timeout:45000});
    assert.match(html.slice(0,1800),/data-setup-test="passed"/,html.slice(0,500));
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}

test("Guided wallet routes, server defaults, port help and NAT fallback",{skip:chrome?false:"Chrome unavailable"},()=>browserExercise(exercise));

async function checkRecoveryScreen() {
  try {
    await new Promise(r=>setTimeout(r,50));
    CFG=await api.saveConfig({walletDone:true,setupDone:true});
    running=true;
    const progress={host:"example.test:9001",active:true,connected:true,proofs:16,result:"",lines:["Import CoinProofs.. 16"]};
    LAST_STATUS={state:"running",hostResync:progress};
    bkOpen("resync");
    if(el("bkProg").hidden || !el("bkGo").disabled || !el("bkStage").textContent.includes("Connected to example.test:9001") || !el("bkStage").textContent.includes("Coin proofs received: 16"))throw Error("missing live evidence");
    running=false;LAST_STATUS.state="stopped";bkOpen("");bkOpen("resync");
    if(!el("bkLog").textContent.includes("Import CoinProofs.. 16"))throw Error("restart lost proof log");
    progress.result="complete";progress.active=false;LAST_STATUS.state="running";paintHostProgress(LAST_STATUS);
    if(!el("bkStage").textContent.includes("Resync complete") || el("bkGo").disabled)throw Error("completion missing");
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"><rect width="7" height="9" fill="red"/></svg>';
    const coin={collection:true,edition:"1",token:{name:{mode:"embed"}},state:[{port:1,data:"["+btoa(svg)+"]"}]};
    const tile=document.createElement("div");tile.innerHTML=nftPicture(coin);
    const img=tile.querySelector("img");await img.decode();
    if(img.naturalWidth!==7 || img.naturalHeight!==9 || !img.src.startsWith("data:image/svg+xml;base64,"))throw Error("SVG failed to display");
    document.documentElement.dataset.setupTest="passed";
  }catch(e){document.documentElement.dataset.setupTest=e.message;}
}
test("Host resync log survives navigation and restart, and the gallery decodes sealed SVG artwork",{skip:chrome?false:"Chrome unavailable"},()=>browserExercise(checkRecoveryScreen));

async function checkIncomingCounts() {
  try {
    await new Promise(r=>setTimeout(r,50));
    CFG=await api.saveConfig({walletDone:true,setupDone:true});
    running=true;activeView="node";
    LAST_STATUS={state:"running",bootTs:12345,health:{},keetsEnabled:true};
    let active=1, late=null;
    const live={connections:[{incoming:true,valid:true,host:"192.0.2.7"},{incoming:true,valid:true,host:"127.113.2.2"}]};
    const previous=api.cmd;
    api.cmd=async c=>{
      if(c==="network")return {status:true,response:live};
      if(c==="keets action:info"){
        if(late)return await late;
        return {status:true,response:{dht:{diag:{inConnected:99,bridge:{incomingActive:active}}}}};
      }
      return previous(c);
    };
    const tick=()=>new Promise(r=>setTimeout(r,25));
    renderNode(LAST_STATUS);await tick();
    const expect=(c,k)=>{if(el("classicIncoming").textContent!==c||el("keetsIncoming").textContent!==k)throw Error("incoming counts "+el("classicIncoming").textContent+"/"+el("keetsIncoming").textContent);};
    expect("1","1");
    let resolve;
    late=new Promise(r=>{resolve=r;});peerPoll=null;refreshPeerCounts();
    late=null;active=0;
    for(let i=0;i<8;i++)appendLog("[KEETS] incoming Minima bridges changed");
    await tick();
    if(el("keetsIncoming").textContent!=="–")throw Error("stale pending peer count");
    resolve({status:true,response:{dht:{diag:{bridge:{incomingActive:1}}}}});await tick();expect("1","0");
    live.connections=[];peerPoll=null;refreshPeerCounts();await tick();expect("0","0");
    document.documentElement.dataset.setupTest="passed";
  }catch(e){document.documentElement.dataset.setupTest=e.message;}
}
test("Node tab drops departed Keets and classic peers and ignores an older in-flight reply",{skip:chrome?false:"Chrome unavailable"},()=>browserExercise(checkIncomingCounts));
