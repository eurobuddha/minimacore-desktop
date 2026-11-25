"use strict";
let guideEnabled = false, guideRoute = "new", guideScreenId = "", guideWorking = false, guidePaused = false;
let guideRestarting = false;
const guideOptions = {server:true, chat:true, fallback:true, source:"spartacus"};

function guidePage(id,title,back,description="") {
  guideScreenId=id;
  const body=frScreen(t("Set up Pandamonium"),back);
  body.innerHTML='<div class="guide-page"><h2 class="ps-h"></h2><p class="ps-intro"></p><div class="guide-content"></div><p role="status" class="ps-note" id="guideNote"></p></div>';
  body.querySelector("h2").textContent=t(title);
  body.querySelector("p").textContent=t(description);
  return body.querySelector(".guide-content");
}
function guideAction(host,label,fn,primary=false) {
  const button=document.createElement("button");
  button.className="btn ps-btn "+(primary?"btn--primary":"btn--outline");
  button.textContent=t(label);
  button.onclick=async()=>{
    if(button.disabled)return;
    button.disabled=true;
    try {await fn();} catch(e){if(el("guideNote"))el("guideNote").textContent=ipcError(e);else toast(ipcError(e),"err");}
    finally{button.disabled=false;}
  };
  host.append(button);
  return button;
}
function guideWelcome() {
  if(CFG.setupDone && !CFG.walletDone && CFG.guideWallet){
    guideRoute=CFG.guideWallet;
    if(guideRoute!=="new")return guideWords();
    const host=guidePage("resume","Finish saving your recovery words",null);
    guideAction(host,"Show recovery words",()=>frStart(null),true);

    return;
  }
  const host=guidePage("welcome","Do you already have a Minima wallet?",null);
  guideAction(host,"I’m new to Minima",()=>{guideRoute="new";guideConnection();},true);
  guideAction(host,"I have a wallet",guideType);
  guideAction(host,"Language",chooseLanguage).id="frLang";
  guideAction(host,"Startup Params",()=>showSetup(true));
}
function guideType() {
  const host=guidePage("type","Which wallet do you have?",guideWelcome,"Check the key mode in the settings on your old node.");
  guideAction(host,"Minima Classic · 64 keys",guideClassic,true);
  guideAction(host,"Block key uses · 32 keys",()=>{guideRoute="block";guideConnection();});
  guideAction(host,"I’m not sure",()=>{el("guideNote").textContent=t("Open KeyUses on your old node. Look for Classic or Block under the signing keys. Keep the old node until the balances match.");});
}
function guideClassic() {
  const host=guidePage("classic","Keep your classic addresses?",guideType,"Moving gives your main wallet 32 block-based keys. minimaWallet opens your 64 classic addresses with the same recovery words. You review the coins before moving them.");
  guideAction(host,"Move to block-based keys",()=>{guideRoute="migrate";guideConnection();},true);
  guideAction(host,"Keep my classic addresses",()=>{guideRoute="classic";guideConnection();});
}
function guideConnection() {
  const host=guidePage("connection","How should this computer connect?",guideRoute==="new"?guideWelcome:guideRoute==="block"?guideType:guideClassic,
    "A server helps other Minima users connect. We’ll ask your router to open the node port.");
  function toggle(key,label,help) {
    const row=document.createElement("label"),box=document.createElement("input"),words=document.createElement("span"),title=document.createElement("strong"),detail=document.createElement("small");
    row.className="guide-option";box.type="checkbox";box.checked=guideOptions[key];box.onchange=()=>{guideOptions[key]=box.checked;if(key!=="fallback")guideConnection();};
    title.textContent=t(label);detail.textContent=t(help);words.append(title,detail);row.append(box,words);host.append(row);
  }
  toggle("server","Help the network","Accept incoming classic P2P connections.");
  toggle("chat","Use Keets Chat","Chat privately while Minima uses classic P2P.");
  if(guideOptions.server && guideOptions.chat)toggle("fallback","Use Keets if my router blocks connections","Keep classic P2P running and add a tunnel when needed.");
  guideAction(host,"Continue",guideSource,true);
}
const guideSources = {spartacus:"spartacusrex.com", eurobuddha:"eurobuddha.com"};
let guideFileUrl = "";
function guideSnapshotLabel() {
  return t("Snapshot file from {source}", {source:guideFileUrl || guideSources[CFG.guideSource] || "—"});
}
function guideSource() {
  const host=guidePage("source","Download the network snapshot",guideConnection,"Your node keeps coins with pruning off. The starting coins come from the snapshot you choose.");
  const label=document.createElement("label");label.className="ps-label";label.textContent=t("Download from");
  const select=document.createElement("select");select.className="field__input ps-field";
  for(const [value,txt] of Object.entries(guideSources))select.add(new Option(txt,value));
  select.value=guideOptions.source;select.onchange=()=>{guideOptions.source=select.value;};label.append(select);host.append(label);
  guideAction(host,guideRoute==="new"?"Create my wallet":"Restore Wallet",()=>guideRoute==="new"?guideStart(null):guideWords(),true);
}
function guideWords() {
  const mode=guideRoute==="block"?"block":"classic";
  const host=guidePage("words","Check your old wallet",CFG.setupDone?null:guideSource,
    "Enter your recovery words to check all 64 classic and 32 block-based addresses. Only public keys and addresses go to the Eurobuddha checker. Keep your old wallet offline during migration.");
  const wordLabel=document.createElement("label");wordLabel.textContent=t("Seed phrase");host.append(wordLabel);
  const entry=document.createElement("div");host.append(entry);
  const words=WordEntry.create(entry,{anyPhrase:true,clearClipboard:()=>api.clip("")});
  guideAction(host,"Check wallet and key uses",async()=>{
    const seed=await resolveSeed(words);if(!seed)return;
    const valid=resyncCommand({host:CFG.megammrHost,phrase:seed,anyphrase:true,keyuses:"0",needPhrase:true});
    if(valid.error)throw Error(valid.error);
    el("guideNote").textContent=t("Checking the wallet…");
    const report=await api.setupAudit(seed,mode,guideRoute==="migrate");
    if(!host.isConnected)return;
    words.clear();guideCounter(seed,mode,report);
  },true);
}
function guideCounter(seed,mode,report) {
  const host=guidePage("counter","Confirm the next key use",guideWords,
    "A signing position can only be used once. Find the highest next use recorded on every device that used these words. The chain can miss signatures. If you cannot check the old record, pause here.");
  const coverage=document.createElement("p");coverage.textContent=t("Checked {classic} classic and {block} block-based addresses for key reuse.",report);
  if(!report.reused)coverage.textContent+=" "+t("The archive found no repeated signatures.");
  host.append(coverage);
  const info=document.createElement("p");info.textContent=t("Minimum from the archive: {n}.", {n:report.minimum});host.append(info);
  if(report.reused){const warning=document.createElement("p");warning.className="guide-warning";warning.textContent=t("Repeated signatures found on {n} keys. Keep the old wallet offline. Moving funds cannot undo earlier reuse.",{n:report.reused});host.append(warning);}
  const label=document.createElement("label");label.textContent=t("Enter the higher of the old record and the archive minimum");
  const count=document.createElement("input");count.inputMode="numeric";count.autocomplete="off";count.className="field__input ps-field";label.append(count);host.append(label);
  guideAction(host,"Use these recovery words",async()=>{
    await api.setupFloor(report.ticket,count.value.trim());
    await guideStart({seed,mode:guideRoute==="classic"?"classic":"block",host:CFG.megammrHost,keyuses:count.value.trim()});
  },true);
}
async function guideStart(restore) {
  const mode=restore?.mode || "block";
  if((!KEYMODE.supported && mode==="block") || (KEYMODE.mode && KEYMODE.mode!==mode))throw Error(t("This install already has a different key mode."));
  if(!CFG.setupDone){
    const params=applyNetPreset({...CFG.params},"mainnet",guideOptions.server,"",CFG.peersUrl);
    Object.assign(params,{megammr:true,megaprune:false,megaprunestate:false,megaprunetokens:false});
    MINIMA_PARAMS.setKeetsMode(params,guideOptions.chat?"chat":"classic");
    CFG=await api.saveConfig({network:"mainnet",contribute:guideOptions.server,params,guideStage:"download",guideWallet:guideRoute,
      guideSource:guideOptions.source,guideFallback:guideOptions.chat && guideOptions.server && guideOptions.fallback});
  }
  FR_CLASSIC=mode==="classic";
  await frStart(restore);
}

async function guideSwitch() {
  if(guideRestarting || !running || nodeBusyNow() || !CFG.contribute || MINIMA_PARAMS.keetsMode(CFG.params)!=="chat")return;
  guideRestarting=true;
  try{
    if(!await nodeStopOk()){CFG=await api.saveConfig({guideFallback:false});return;}
    const params=MINIMA_PARAMS.setKeetsMode({...CFG.params},"full");
    await api.nodeRestart(stopAck(),{params,guideFallback:false});
    CFG=await api.getConfig();
    if(guideScreenId==="network")guideNetwork(LAST_STATUS);
    toast(t("Keets transport is on. Classic P2P stays on."),"ok");
  }finally{guideRestarting=false;}
}
function guideNetwork(s) {
  const host=guidePage("network","Connect your node",null);
  const note=document.createElement("p");note.id="guideNetworkStatus";host.append(note);
  const details=document.createElement("details");details.innerHTML='<summary></summary><div id="guideRouter"></div>';
  details.querySelector("summary").textContent=t("Help me forward the port");host.append(details);details.hidden=!CFG.contribute;
  if(CFG.contribute && MINIMA_PARAMS.keetsMode(CFG.params)==="chat")
    guideAction(host,"I can’t forward this port · use Keets",guideSwitch);
  guideAction(host,CFG.guideWallet==="migrate"?"Review my classic wallet":"Open my node",async()=>{
    if(guideRestarting || !running)throw Error(t("Waiting for the node…"));
    if(CFG.guideWallet==="migrate"){await guideMigration();return;}
    await guideFinish("node");
  },true);
  guideNetworkUpdate(s);
}
function guideNetworkUpdate(s){
  const note=el("guideNetworkStatus");if(!note)return;
  const pm=s.portmap||{};
  note.textContent=CFG.contribute?t("Classic P2P reachability")+" · "+contribHelp(s,s.health||{},pm).text:t("Light wallet");
  const router=el("guideRouter"),html=forwardHowTo(pm);if(router.innerHTML!==html)router.innerHTML=html;
}
async function guideMigration(){
  const host=guidePage("migration","Review your classic wallet",()=>guideNetwork(LAST_STATUS),
    "Check that the addresses, Minima, and tokens match your old wallet. Keep it offline. Sweep in minimaWallet asks you to confirm the receiving address and the key uses before signing.");
  const status=document.createElement("p");status.textContent=t("Loading…");host.append(status);
  try{
    const w=await api.mwHome(null);
    if(!host.isConnected)return;
    if(w.owned || w.mode!=="classic" || w.source!=="node" || w.addresses.length!==64)throw Error(t("Check the minimaWallet profile before moving coins."));
    status.textContent=w.balances.filter(b=>b.count>0).map(b=>String(b.amount)+" "+nftName(b)).join(" · ") || t("No coins found. Check against your old wallet before proceeding.");
    guideAction(host,"Open sweep review",()=>guideFinish("minimawallet"),true);
  }catch(e){status.textContent=ipcError(e);guideAction(host,"Retry",guideMigration);}
  guideAction(host,"Move coins later",()=>guideFinish("node"));
}
async function guideFinish(view){
  CFG=await api.saveConfig({guideStage:"",guidePublicKey:""});
  guideScreenId="";hideSetup();
  if(view==="minimawallet"){minimaTab="Settings";guideOpenSweep=true;}
  selectTab(view);
}
function guideTrouble(error){
  const host=guidePage("error","Snapshot needs attention",null);
  const source=document.createElement("p");source.textContent=guideSnapshotLabel();host.append(source);
  const note=document.createElement("p");note.textContent=error;host.append(note);
  guideAction(host,CFG.guideStage==="network"?"Continue":"Retry",async()=>{
    const s=await api.nodeStatus();
    if(s.megammrImport || s.megammrBroken || s.megafileBusy)throw Error(t("Open Backup & Recovery to review the import first."));
    if(CFG.guideStage==="network"){guideNetwork(s);return;}
    CFG=await api.saveConfig({guideStage:"download"});guideScreenId="";await guideDownload();
  },true);
  guideAction(host,"Backup & Recovery",()=>{guidePaused=true;hideSetup();BK_PAGE="megafile";selectTab("backup");});
  guideAction(host,"Settings",()=>{guidePaused=true;hideSetup();selectTab("settings");});
}
async function guideDownload(){
  if(guideWorking)return;
  guideWorking=true;
  guideFileUrl="";
  const host=guidePage("download","Setting up the full database",null,"You can leave this window open while the snapshot downloads and your node checks it.");
  const source=document.createElement("p");source.id="guideFileSource";source.textContent=guideSnapshotLabel();host.append(source);
  try{
    await api.setupSnapshot();
    CFG=await api.getConfig();guideScreenId="";
  }catch(e){CFG=await api.getConfig();guideTrouble(ipcError(e));}
  finally{guideWorking=false;}
}
function guideTick(s){
  if(!guideEnabled || !CFG.walletDone || guidePaused)return;
  const busy=s.megafileBusy || s.resyncing || s.megammrImport || s.megammrBroken;
  if((CFG.guideStage==="network" || (!CFG.guideStage && activeView==="node")) && !busy && s.state==="running" && CFG.guideFallback &&
      s.portmap?.state==="double_nat" && !(s.health?.incoming>0) && !guideRestarting && guideScreenId!=="migration")
    guideSwitch().catch(e=>toast(ipcError(e),"err"));
  if(!CFG.guideStage || guideScreenId==="error")return;
  if(guideWorking){
    const note=el("guideNote");
    if(note){
      if(s.megafileStep)note.textContent=MainSaid.say(s.megafileStep);
      api.setupSnapshotProgress().then(p=>{
        if(!p || !note.isConnected)return;
        if(p.url && p.url!==guideFileUrl){
          guideFileUrl=p.url;
          el("guideFileSource").textContent=guideSnapshotLabel();
        }
        if(!s.megafileStep)note.textContent=Math.floor(100*p.bytes/p.total)+"%";
      }).catch(()=>{});
    }
    return;
  }
  if(s.state==="error" && !guideWorking){guideTrouble(MainSaid.say(s.lastError || "node error"));return;}
  if(s.state!=="running")return;
  if(CFG.guideStage==="network" && s.megammrImport==="catchup" && !s.megafileBanner?.offer && !s.megammrBroken){
    if(guideScreenId!=="catchup")guidePage("catchup","Checking the imported chain",null);
    return;
  }
  if(CFG.guideStage==="importing" || busy){
    if(guideScreenId!=="error")guideTrouble(t("Open Backup & Recovery to review the import first."));
    return;
  }
  if(CFG.guideStage==="download"){
    if(Number(s.health?.block)>0)guideDownload();
    else if(guideScreenId!=="sync")guidePage("sync","Waiting for the first block",null);
  }else if(CFG.guideStage==="network"){
    if(guideScreenId==="network")guideNetworkUpdate(s);
    else if(guideScreenId!=="migration")guideNetwork(s);
  }
}
