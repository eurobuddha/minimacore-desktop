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
    document.documentElement.dataset.setupTest="passed";
  }catch(e){document.documentElement.dataset.setupTest=e.message;}
}
const chrome=[process.env.CHROME_BIN,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/usr/bin/google-chrome","/usr/bin/chromium"].find(f=>f&&fs.existsSync(f));
test("Guided wallet routes, server defaults, port help and NAT fallback",{skip:chrome?false:"Chrome unavailable"},()=>{
  const renderer=path.resolve(__dirname,"../renderer"),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"pandamonium-setup-ui-"));
  try{
    const stub=pathToFileURL(path.join(__dirname,"dev-preview","stub.js"));
    const page=fs.readFileSync(path.join(renderer,"index.html"),"utf8")
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,"")
      .replace("<head>",`<head><base href="${pathToFileURL(renderer+path.sep)}">`)
      .replace('<script src="i18n.js">',`<script src="${stub}"></script><script>(${fixture})();</script><script src="i18n.js">`)
      .replace("</body>",`<script>(${exercise})();</script></body>`);
    const file=path.join(tmp,"wallet.html");fs.writeFileSync(file,page);
    const html=execFileSync(chrome,["--headless","--disable-gpu","--no-first-run","--user-data-dir="+path.join(tmp,"profile"),"--allow-file-access-from-files","--window-size=680,690","--virtual-time-budget=8500","--dump-dom",pathToFileURL(file).href],{encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:5e6,timeout:45000});
    assert.match(html.slice(0,1800),/data-setup-test="passed"/,html.slice(0,500));
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
