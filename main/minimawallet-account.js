"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const {app} = require("electron");
const wallet = require("./webwallet");
const helper = require("./classic-webwallet");
const {toUnits, fromUnits} = require("./sendpin");
const {checkedCommand: cmd} = wallet;
const {isAmount,isTokenid,looksLikeMinimaAddress} = wallet._validators;
const HEX = /^0x[0-9a-f]{64}$/i;
let reviewed = null;

function receipts(root) {
  const dest = path.join(app.getPath("userData"), "minimawallet-" + root + ".json");
  let rows;
  try { rows = JSON.parse(fs.readFileSync(dest,"utf8")); }
  catch(e) { if(e.code !== "ENOENT") throw Error("Could not read minimaWallet payment history."); rows=[]; }
  if (!Array.isArray(rows)) throw Error("Invalid minimaWallet payment history.");
  function save() {
    const fd = fs.openSync(dest+".tmp","w",0o600);
    try { fs.writeFileSync(fd,JSON.stringify(rows)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(dest+".tmp",dest);
    if (process.platform !== "win32") {
      const dir = fs.openSync(path.dirname(dest),"r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  }
  return {rows,save};
}

async function inventory(book, spendable) {
  const mode = await wallet.isMegammr() ? "megammr:true" : "relevant:true";
  const rows = [], seen = new Set();
  const keys = [...book.values()];
  for (let i=0; i<keys.length; i+=4) {
    const batch = await Promise.all(keys.slice(i,i+4).map(async key => {
      const coins = await cmd("coins "+mode+" simplestate:false address:"+key.address+(spendable?" checkmempool:true coinage:3":""));
      if (!Array.isArray(coins) || coins.some(c=>c.address!==key.address || !HEX.test(c.coinid) || !isTokenid(c.tokenid)))
        throw Error("Could not verify the wallet coin list.");
      return coins;
    }));
    for(const coins of batch) for(const c of coins) {
      if(seen.has(c.coinid)) throw Error("Duplicate coin in wallet inventory.");
      seen.add(c.coinid); rows.push(c);
    }
  }
  return rows;
}

async function home(profile,book,native) {
  const coins = await inventory(book,false);
  const {balances} = await helper.run({action:"summary",coins});
  if (!balances.some(b=>b.tokenid==="0x00")) balances.unshift({tokenid:"0x00",amount:"0",count:0,token:null});
  const root=book.get(0), ledger=receipts(root.address);
  await require("./nftcoins").reconcile({payments:ledger.rows,collections:[]},ledger.save);
  const dest=await cmd("getaddress");
  return {id:profile.id,mode:profile.mode,source:profile.source,balances,owned:native.nativeKeys.has(root.publickey.toUpperCase()),
    addresses:[...book.values()].map(k=>k.miniaddress), destination:dest.miniaddress,
    coins:coins.map(c=>({coinid:c.coinid,tokenid:c.tokenid,token:c.token,amount:c.tokenamount || c.amount,address:c.miniaddress,state:c.state,age:c.age})),
    history:ledger.rows.slice(-100).reverse().map(({kind,tokenid,amount,to,time,status,txpowid})=>({kind,tokenid,amount,to,time,status,txpowid}))};
}

async function destination(value, sweep, nativeKeys) {
  if (!looksLikeMinimaAddress(value)) throw Error("Invalid recipient address.");
  const a=await cmd("checkaddress address:"+value);
  if (!HEX.test(a?.["0x"]) || !a.Mx) throw Error("Invalid recipient address.");
  if(sweep) {
    if(a.Mx!==value || a.simple!==true) throw Error("Enter the full Mx address of a wallet owned by the main node.");
    const scripts=await cmd("scripts");
    if(!scripts.some(s=>s.address===a["0x"] && nativeKeys.has(String(s.publickey).toUpperCase())))
      throw Error("The destination signing key does not belong to this node.");
  }
  return a;
}

async function review(profile,book,native,request) {
  reviewed=null;
  const sweep=request?.kind==="sweep", items=request?.kind==="items";
  const ids=items && Array.isArray(request.coinids)?new Set(request.coinids):null;
  if(items && (!ids || !ids.size || ids.size!==request.coinids.length || [...ids].some(id=>!HEX.test(id)) || !HEX.test(request.tokenid)))
    throw Error("Invalid NFT selection.");
  if(!sweep && !items && (request?.kind!=="send" || !isTokenid(request.tokenid) || !isAmount(request.amount)))
    throw Error("Enter a valid token and amount.");
  const root=book.get(0);
  if(native.nativeKeys.has(root.publickey.toUpperCase()))return {handoff:true};
  const to=await destination(request.to,sweep,native.nativeKeys);
  const ledger=receipts(root.address);
  const pending=new Set(ledger.rows.filter(r=>r.status!=="rejected").flatMap(r=>r.coinids));
  const all=await inventory(book,true);
  const held=c=>pending.has(c.coinid) || require("./reserve").sendHeld("wallet",c.coinid);
  const coins=all.filter(c=>!held(c) && (!sweep || c.address!==to["0x"]) && (!items || (ids.has(c.coinid) && c.tokenid===request.tokenid && String(c.token?.decimals)==="0")));
  if(items && coins.length!==ids.size)throw Error("A selected NFT is no longer spendable.");
  const indices=Object.fromEntries([...book].map(([index,k])=>[k.address,index]));
  let plan;
  try {plan=await helper.run({action:"plan",kind:items?"sweep":request.kind,coins,indices,tokenid:request.tokenid,amount:request.amount});}
  catch(e) {if(!sweep)throw Error("The spendable coins cannot cover that payment. Check the amount and token precision.");throw e;}
  if(items && (plan.skipped.length || plan.jobs.reduce((n,j)=>n+j.coinids.length,0)!==ids.size))
    throw Error("One or more selected editions cannot be transferred.");
  if (!plan.jobs.length) throw Error("There are no eligible coins to sweep.");
  const byId=new Map(coins.map(c=>[c.coinid,c]));
  const counts=new Map();
  for(const job of plan.jobs) {
    job.inputs=job.coinids.map(id=>({coinid:id,index:indices[byId.get(id).address]}));
    job.indices=[...new Set(job.inputs.map(c=>c.index))];
    for(const index of job.indices)counts.set(index,(counts.get(index)||0)+1);
  }
  const keys=[],blockRoot=profile.mode==="block"?root.address:null;
  let next=0;
  for(const [index,count] of counts) {
    const key=book.get(index);
    if(native.nativeKeys.has(key.publickey.toUpperCase()))return {handoff:true};
    const floor=await wallet.paymentFloor(key.address,key.publickey,blockRoot);
    const minimum=Math.max(next,floor.minimum);
    if(minimum+count-1>floor.last)throw Error("This payment would exhaust the signing key.");
    keys.push({index,count,...key,...floor,minimum});
    if(blockRoot)next=minimum+count;
  }
  const ticket=randomUUID();
  reviewed={ticket,profile:profile.id,identity:native.identity,kind:request.kind,to:to.Mx,keys,blockRoot,jobs:plan.jobs};
  const totals=new Map();
  for(const job of plan.jobs)totals.set(job.tokenid,(totals.get(job.tokenid)||0n)+toUnits(job.amount));
  return {ticket,to:to.Mx,kind:request.kind,keys,transactions:plan.jobs.length,skipped:plan.skipped,coinids:items?[...ids]:[],
    totals:[...totals].map(([tokenid,total])=>({tokenid,amount:fromUnits(total)}))};
}

async function assertNode(plan,root) {
  const keys=(await cmd("keys action:list")).keys;
  if (!keys?.length || keys[0].publickey!==plan.identity) throw Error("The node wallet changed. Review again.");
  const owned=new Set(keys.map(k=>k.publickey.toUpperCase()));
  if (owned.has(root.publickey.toUpperCase()) || plan.keys.some(k=>owned.has(k.publickey.toUpperCase())))
    throw Error("This node owns the signing key. Use the Wallet tab to send.");
  if(plan.kind==="sweep")await destination(plan.to,true,owned);
}

async function execute(profile,book,native,request) {
  const plan=reviewed;
  if(!plan || plan.profile!==profile.id || plan.ticket!==request?.ticket || plan.identity!==native.identity)
    throw Error("The wallet or payment changed. Review again.");
  if(plan.kind==="sweep" && request.confirmation!==plan.to)throw Error("Re-enter the full reviewed destination.");
  const root=book.get(0);
  await assertNode(plan,root);
  const eligible=new Set((await inventory(book,true)).filter(c=>!require("./reserve").sendHeld("wallet",c.coinid)).map(c=>c.coinid));
  if(plan.jobs.some(j=>j.inputs.some(c=>!eligible.has(c.coinid))))throw Error("A reviewed coin is no longer spendable. Review again.");
  const ledger=receipts(root.address);
  const next=await wallet.reserveWalletRanges(plan.keys,request.uses,plan.blockRoot);
  reviewed=null;
  let submitted=0, unknown=false, error="";
  for(const job of plan.jobs) {
    const id=randomUUID();
    try {
      await assertNode(plan,root);
      const proofs=[];
      for(const input of job.inputs) {
        const proof=await cmd("coinexport coinid:"+input.coinid);
        if(!/^0x(?:[a-f0-9]{2})+$/i.test(proof.data))throw Error("Invalid exported coin.");
        proofs.push({...input,data:proof.data});
      }
      const leaves=Object.fromEntries(job.indices.map(i=>[i,next[i]++]));
      const signed=await helper.run({action:"sign",seed:profile.seed,accountMode:profile.mode,keyIndex:"0",id,leaves,proofs,
        tokenid:job.tokenid,amount:job.amount,total:job.total,whole:job.whole,to:plan.to});
      if(!/^0x(?:[a-f0-9]{2})+$/i.test(signed.data))throw Error("Invalid signed wallet transaction.");
      await cmd("txnimport id:"+id+" data:"+signed.data);
      try {
        if((await cmd("txncheck id:"+id)).validtransaction!==true)throw Error("The node could not validate this transaction.");
        await assertNode(plan,root);
        const draft=(await cmd("txnlist id:"+id)).transaction;
        if(!HEX.test(draft?.transactionid))throw Error("Could not verify the signed transaction ID.");
        const row={id,transactionid:draft.transactionid,kind:plan.kind,to:plan.to,tokenid:job.tokenid,amount:job.amount,coinids:job.coinids,time:Date.now(),status:"unknown"};
        ledger.rows.push(row);ledger.save();
        unknown=true;
        const tx=await cmd("txnpost id:"+id+" mine:false");
        if(!HEX.test(tx?.txpowid))throw Error("Check the payment in History before retrying.");
        row.txpowid=tx.txpowid;row.status="submitted";ledger.save();submitted++;unknown=false;
      } finally {await cmd("txndelete id:"+id).catch(()=>{});}
    } catch(e) {error=e.message;break;}
  }
  return {submitted,total:plan.jobs.length,unknown,error};
}
module.exports={home,review,execute,invalidate:()=>{reviewed=null;}};
