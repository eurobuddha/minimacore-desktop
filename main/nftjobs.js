"use strict";
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
const {spawn} = require("node:child_process");
const {app} = require("electron");
const {checkedCommand} = require("./webwallet");
const {oneCommand} = require("./cmdverb");
const COLLECTION_KIND = "Collection";
const HEX = /^0x[0-9a-f]{64}$/i;
const root = () => path.join(app.getPath("userData"), "nftwallet");
let queue = Promise.resolve(), ticking = false, lastTick = "";
function serial(fn) {
  const result = queue.then(fn);
  queue = result.catch(()=>{});
  return result;
}
async function identity() {
  const keys = (await checkedCommand("keys action:list")).keys;
  const first = keys?.find(k => /^(?:0x)?0+$/i.test(k.modifier));
  if (!HEX.test(first?.publickey)) throw Error("Could not verify the node wallet identity.");
  return first.publickey.toUpperCase().replace(/^0X/,"0x");
}
function file(id) { if (!HEX.test(id)) throw Error("Invalid wallet identity"); return path.join(root(), id + ".json"); }
function read(id) {
  let s; try { s = fs.readFileSync(file(id),"utf8"); } catch (e) { if(e.code === "ENOENT") return {collections:[],pending:{},payments:[],distributions:[]}; throw e; }
  const state = JSON.parse(s);
  if (!Array.isArray(state.collections) || !state.pending || !Array.isArray(state.payments) || !Array.isArray(state.distributions)) throw Error("Could not read NFTwallet jobs.");
  return state;
}
function save(id, state) {
  const dest=file(id), tmp=dest+".tmp";
  fs.mkdirSync(root(),{recursive:true,mode:0o700});
  const fd=fs.openSync(tmp,"w",0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp,dest);
  if (process.platform !== "win32") {
    const dir=fs.openSync(root(),"r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}
async function assertIdentity(id) {
  if (!HEX.test(id) || await identity() !== id) throw Error("The node wallet changed. Review the action again.");
}
async function withWallet(id, fn) {
  return serial(async () => {
    const actual = await identity();
    if (id && id !== actual) throw Error("The node wallet changed. Review the action again.");
    const state = read(actual);
    return fn(state, () => save(actual,state), actual);
  });
}
function safeText(value, max) {
  if (typeof value !== "string" || value.length > max || /[;\x00-\x1F\x7F]/.test(value)) throw Error("Invalid mint metadata.");
  return value;
}
function url(value) {
  if (!value) return "";
  safeText(value,2048);
  if (!/^(https?:\/\/|ipfs:\/\/)[a-z0-9/%#?&.,:!_~+=@-]+$/i.test(value)) throw Error("Invalid image or validation URL.");
  return value;
}
function image(value, max) {
  if (!value) return "";
  if (/^(?:https?|ipfs):/i.test(value)) return url(value);
  if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9+/]+=*$/.test(value)) throw Error("Image exceeds its on-chain size budget.");
  return value;
}
async function mint(id, opts) {
  await assertIdentity(id);
  return withWallet(id,async (state,persist) => {
    const {kind} = opts;
    if (!["Token","NFT","Collection"].includes(kind)) throw Error("Unknown mint type.");
    const name=safeText(opts.name,128).trim(), description=safeText(opts.description || "",1024);
    if (!name) throw Error("Enter a token name.");
    const address = await checkedCommand("getaddress");
    if (!HEX.test(address?.publickey) || !HEX.test(address?.address)) throw Error("Could not verify the creator key.");
    const metadata={name,description}, icon=image(opts.icon,kind === COLLECTION_KIND ? 6000 : 16000);
    const webvalidate=url(opts.webvalidate), external=url(opts.external);
    if (webvalidate) metadata.webvalidate=webvalidate;
    if (external) metadata.external_url=external;
    if (icon) metadata.url=/^(https?|ipfs):/.test(icon) ? icon : "<artimage>"+icon+"</artimage>";
    if (kind==="NFT"){metadata.nft="true";if(opts.creator)metadata.owner=safeText(opts.creator,128);}
    if (opts.ticker) metadata.ticker=safeText(opts.ticker,24);
    if (kind === COLLECTION_KIND) {
      const size=Number(opts.size), mode=opts.mode;
      if (!Number.isInteger(size) || size<2 || size>20 || !["embed","url"].includes(mode)) throw Error("Choose 2 to 20 collection items.");
      const base=mode === "url" ? url(opts.base) : "", ext=mode==="url" ? safeText(opts.ext || ".png",10) : "";
      if (mode==="url" && (!base || !/^\.[a-z0-9]+$/i.test(ext))) throw Error("Enter a valid edition image URL and extension.");
      if (mode==="embed" && (!Array.isArray(opts.images) || opts.images.length !== size)) throw Error("Choose one image for each edition.");
      const items=Array.from({length:size},(_,i)=>{
        const art=mode==="url" ? base+(i+1)+ext : image(opts.images[i],8000);
        if (!art || (mode==="embed" && art.includes(":"))) throw Error("Choose an embedded image for each edition.");
        return {idx:i+1,image:art,coinid:""};
      });
      const job={id:Math.max(0,...state.collections.map(r=>r.id))+1,name,description,mode,size,base,ext,icon,webvalidate,externalurl:external,
        creatoraddr:address.address,creatorpk:address.publickey,tokenid:"",phase:"CREATE",items,posted:0,postedat:0,error:""};
      state.collections.push(job);persist();lastTick="";return {job:job.id};
    }
    const amount=String(opts.amount), decimals=Number(opts.decimals);
    if (!/^[1-9]\d{0,19}$/.test(amount) || !Number.isInteger(decimals) || decimals<0 || decimals>16 || (kind==="NFT" && (decimals!==0 || !icon))) throw Error("Invalid token supply, decimals or NFT image.");
    if (opts.extra && typeof opts.extra === "object") {
      for (const [k,v] of Object.entries(opts.extra)) {
        if (!/^[a-z][a-z0-9_]{0,31}$/i.test(k) || ["__proto__","constructor","prototype"].includes(k) || Object.hasOwn(metadata,k)) throw Error("Invalid or duplicate metadata field.");
        metadata[k]=safeText(v,512);
      }
    }
    const burn=String(opts.burn || "0");
    if (!/^\d{1,18}(?:\.\d{1,16})?$/.test(burn)) throw Error("Invalid burn amount.");
    const command="tokencreate name:"+JSON.stringify(metadata)+" amount:"+amount+" decimals:"+decimals+" burn:"+burn+
      (webvalidate ? " webvalidate:"+webvalidate : "")+(kind==="NFT" || opts.sign ? " signtoken:"+address.publickey : "");
    const row={id:require("node:crypto").randomUUID(),name,kind,status:"submitting",time:Date.now()};
    state.payments.push(row);persist();
    try {
      await assertIdentity(id);
      const result=await checkedCommand(oneCommand(command));
      row.status="submitted"; row.txpowid=result?.txpowid || "";persist();return {submitted:true};
    } catch (e) { row.status="unconfirmed";persist();throw e; }
  });
}
async function status() {
  return withWallet(null,(s,_save,id)=>({id,collections:s.collections.map(({items,...rest})=>({...rest,stamped:items.filter(i=>i.coinid).length, editable:items.filter(i=>!i.coinid).map(i=>i.idx)})),
    payments:s.payments.slice(-100), distributions:s.distributions}));
}
function tickJava(state,persist,id) {
  const resources=app.isPackaged ? process.resourcesPath : path.join(__dirname,"../resources");
  const child=spawn(require("./node-manager").javaPath(),["-Xmx128m","-cp",path.join(resources,"nftwallet.jar"),"com.eurobuddha.nftwallet.DesktopMint"],
    {windowsHide:true,env:require("./keymode").childEnv(process.env),stdio:["pipe","pipe","ignore"]});
  return new Promise((resolve,reject)=>{
    let done=false;
    const timeout=setTimeout(()=>child.kill(),180000);
    const abort=e=>{child.kill();reject(e);};
    child.on("error",abort);child.stdin.on("error",abort);
    child.on("close",code=>{clearTimeout(timeout);if (code===0 && done) resolve(); else reject(Error("NFT mint worker stopped."));});
    child.stdin.write(JSON.stringify({collections:state.collections,pending:state.pending})+"\n");
    const lines=readline.createInterface({input:child.stdout});
    lines.on("line",async line=>{
      try {
        const event=JSON.parse(line);
        if (event.op==="done") { done=true;child.stdin.end();return; }
        if (event.op==="save") {
          state.collections=event.payload.collections; state.pending=event.payload.pending; persist();
          child.stdin.write('{"status":true}\n');return;
        }
        if (event.op!=="cmd" || !/^(?:block|balance|tokens|tokencreate|coins|send|txn(?:create|delete|check|input|output|state|sign|basics|post))(?: |$)/.test(event.payload)) throw Error("Unexpected NFT mint operation.");
        if (await identity()!==id) throw Error("Node wallet changed during mint.");
        let result;
        try {result={status:true,response:await checkedCommand(oneCommand(event.payload))};}
        catch (e) {result={status:false,error:String(e.message)};}
        child.stdin.write(JSON.stringify(result)+"\n");
      } catch(e) {abort(e);}
    });
  });
}
async function tick() {
  if (ticking || !fs.existsSync(root())) return;
  ticking=true;
  try {
    await withWallet(null,async(state,persist,id)=>{
      await require("./nftcoins").reconcile(state,persist);
      await require("./nftcoins").advance(state,persist,id);
      const active = row=>!row.stuck && !["DONE","BURY","BURIED","STOPPED"].includes(row.phase);
      if (!state.collections.some(active)) return;
      const block=await checkedCommand("block"), stamp=id+":"+block.block;
      if (lastTick===stamp) return;
      const first=state.collections.findIndex(active);
      // Each Android engine tick advances one row. Rotate it so a parked creation or missing image cannot starve another collection.
      const [next]=state.collections.splice(first,1);
      state.collections.unshift(next);
      await tickJava(state,persist,id);
      const index=state.collections.findIndex(row=>row.id===next.id);
      if(index>=0)state.collections.push(...state.collections.splice(index,1));
      persist();lastTick=stamp;
    });
  } finally {ticking=false;}
}
module.exports={status,mint,tick,withWallet,identity,assertIdentity,recover};

async function recover(id, jobId, action, opts = {}) {
  return withWallet(id, async (state,persist) => {
    if (typeof jobId==="string") {
      const distribution=state.distributions.find(j=>j.id===jobId);
      if (!distribution) throw Error("Unknown distribution");
      if (action==="stop" && ["ready","waiting"].includes(distribution.status)) {
        distribution.previous=distribution.status;distribution.status="paused";
      } else if (action==="resume" && distribution.status==="paused") {
        distribution.status=distribution.previous || "ready";distribution.error="";
      } else throw Error("Unavailable distribution action.");
      persist();return;
    }
    const row=state.collections.find(r => r.id === jobId);
    if (!row) throw Error("Unknown collection");
    if (action === "stop" && !["DONE","BURY","BURIED","STOPPED"].includes(row.phase)) {
      row.previousPhase=row.phase;
      row.phase="STOPPED";
    } else if (action === "resume" && row.phase==="STOPPED") {
      row.phase=row.previousPhase;
    } else if (action === "retry" && row.phase==="CREATE" && row.createstuck===1) {
      row.posted=0; row.postedat=0; row.createstuck=0;
    } else if (action==="image" && row.mode==="embed") {
      const item=row.items.find(i=>i.idx===opts.index && !i.coinid);
      const art=image(opts.image,8000);
      if (!item || !art || art.includes(":")) throw Error("Invalid edition image.");
      item.image=art;
    } else throw Error("This action is unavailable for this collection.");
    row.error=""; row.stuck=0; persist();lastTick="";
  });
}
