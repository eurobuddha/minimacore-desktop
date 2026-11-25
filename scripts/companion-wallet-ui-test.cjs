// Offline browser regression for the APK wallet screens. Uses only scripts/dev-preview/stub.js.
"use strict";
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url");
const assert=require("node:assert/strict"),test=require("node:test");
function fixture(){
const raw=window.mcd,fn=raw.cmd;
const addr=window.walletFixtureAddress="Mx"+"A".repeat(50),tid="0x"+"9".repeat(64);
const many=Array.from({length:240},(_,i)=>({coinid:"0x"+i.toString(16).padStart(64,"0"),address:"0x"+"1".repeat(64),miniaddress:addr,eligible:true,amount:"0.000099998",tokenid:"0x00",state:[]}));
Object.assign(raw,{
flavor:async()=>({id:"pandamonium",name:"Pandamonium"}),
mwHome:async()=>({id:"fixture",source:"manual",mode:"classic",balances:[{tokenid:"0x00",amount:"7",count:2},{tokenid:tid,token:{name:"Test Token"},amount:"4",count:2}],addresses:[addr],destination:addr,history:[],coins:[]}),
mwReview:async(id,r)=>({ticket:"r",kind:r.kind,to:addr,totals:[{tokenid:"0x00",amount:"7"}],transactions:1,keys:[{index:0,chain:12,local:11,last:999,minimum:12,count:1,miniaddress:addr},{index:1,chain:8,local:8,last:999,minimum:8,count:1,miniaddress:addr}]}),
nftList:async()=>[1,2].map(i=>({coinid:"0x"+String(i).padStart(64,"0"),tokenid:tid,wallet:"fixture",address:addr,token:{name:{name:"Edition fixture"},decimals:"0"},state:[{port:0,data:String(i)}],age:4,collection:true,edition:String(i),amount:"1"})),nftJobs:async()=>({id:"fixture",collections:[],payments:[],distributions:[]}),nftCoins:async()=>many,
cmd:async c=>c==="keys action:list"?{status:true,response:{keys:[{publickey:tid}]}}:c==="scripts"?{status:true,response:[{default:true,address:many[0].address,miniaddress:addr}]}:c.startsWith("coins relevant:")?{status:true,response:[]} : c==="block"?{status:true,response:{block:2428212}}:fn(c)
});

}
function exercise(){
setTimeout(async()=>{const result=[];
function check(k,truth){if(!truth)throw Error(k);result.push(k)}
try{
selectTab("minimawallet");await renderMinimaWallet();check("assets",document.querySelectorAll(".apk-balance").length===2);
[...el("mwTabs").children].find(b=>b.textContent==="Settings").click();el("mwSweep").click();el("mwTo").form.requestSubmit();await new Promise(r=>setTimeout(r,30));
const typed=[...document.querySelectorAll("[data-key]")];check("two empty floors",typed.length===2&&typed.every(i=>i.value===""));const confirm=typed[0].form.querySelector("button");
typed[0].value="11";typed[1].value="8";el("mwRepeat").value=window.walletFixtureAddress;typed[0].form.oninput();check("low blocked",confirm.disabled);typed[0].value="12";typed[0].form.oninput();check("floors accepted",!confirm.disabled);
selectTab("nftwallet");await renderNftWallet();check("seven sections",nf("tabs").children.length===7);
nftTab="Coins";await renderNftWallet();check("240 coins",nf("walletContainer").querySelectorAll("input").length===240);
nf("walletContainer").querySelector("input").click();nf("sendBtn").click();await new Promise(r=>setTimeout(r,60));check("advanced selection",nf("sendFromList").querySelectorAll(".apk-selected").length===1);
nf("modeQuickBtn").click();check("no coins on Quick Send",nf("sendFromBlock").hidden&&!nf("pager").querySelector(".apk-coin")&&!!nf("previewBtn"));
check("recipient and amount visible",[nf("sendAddress"),nf("sendAmount")].every(e=>e.getBoundingClientRect().height>0&&e.getBoundingClientRect().top<innerHeight));
check("pane fits",nf("pager").scrollWidth<=nf("pager").clientWidth+1);
const go=async name=>{nftTab=name;await renderNftWallet();};
await go("Balances");check("balance cards",document.querySelectorAll(".apk-token-card").length>0);
await go("Gallery");check("gallery",!!el("nfCollected")&&!!el("nfFavourites"));
document.querySelector("[data-gallery-open]").click();check("edition drill-down",document.querySelectorAll("[data-view]").length===2);document.querySelector("[data-view]").click();check("full-screen artwork",!!el("chatLb"));el("chatLbClose").click();
await go("Mint");check("three mint actions",nf("mintRoot").children.length===3);nf("mintRoot").children[2].click();check("collection mint",!!el("nfImagesMode"));
await go("Receive");check("receive QR",!!nf("rcvQr").querySelector("img")&&nf("rcvAddress").textContent===window.walletFixtureAddress);
await go("History");check("history in wallet",el("nftHistorySlot").contains(el("histSearch")));
await go("Settings");check("history restored",el("view-history").contains(el("histSearch")));check("precision settings",!!el("nfPrecision")&&!el("nfPrecision").textContent.includes("%1"));el("nfPrecision").value="2";el("nfPrecision").onchange({target:el("nfPrecision")});check("dust visible",nftDisplay("0.0000001")==="<0.01");
await go("Send");

} catch(e){document.documentElement.dataset.error=e.stack;}document.documentElement.dataset.walletTest=JSON.stringify(result);},1100);
}
const chrome=[process.env.CHROME_BIN,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/usr/bin/google-chrome","/usr/bin/chromium"].find(f=>f&&fs.existsSync(f));
test("APK wallet navigation, key-use review and Quick Send with 240 coins",{skip:chrome?false:"Chrome unavailable"},()=>{
  const renderer=path.resolve(__dirname,"../renderer"),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"pandamonium-ui-"));
  try{
    const stub=pathToFileURL(path.join(__dirname,"dev-preview","stub.js"));
    const page=fs.readFileSync(path.join(renderer,"index.html"),"utf8")
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,"")
      .replace("<head>",`<head><base href="${pathToFileURL(renderer+path.sep)}">`)
      .replace('<script src="i18n.js">',`<script src="${stub}"></script><script>(${fixture})();</script><script src="i18n.js">`)
      .replace("</body>",`<script>(${exercise})();</script></body>`);
    const file=path.join(tmp,"wallet.html");fs.writeFileSync(file,page);
    const html=execFileSync(chrome,["--headless","--disable-gpu","--no-first-run","--user-data-dir="+path.join(tmp,"profile"),"--allow-file-access-from-files","--window-size=680,690","--virtual-time-budget=8500","--dump-dom",pathToFileURL(file).href],{encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:5e6,timeout:45000});
    assert.doesNotMatch(html.slice(0,1800),/data-error=/);
    const checks=/data-wallet-test="([^"]+)"/.exec(html);
    assert.ok(checks,"The wallet exercise finished");
    assert.equal(JSON.parse(checks[1].replaceAll("&quot;",'"')).length,21);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
