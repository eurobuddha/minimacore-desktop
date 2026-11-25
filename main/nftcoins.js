"use strict";
const {randomUUID}=require("node:crypto");
const wallet=require("./webwallet"), jobs=require("./nftjobs");
const {toUnits,fromUnits}=require("./sendpin");
const command=wallet.checkedCommand;
const SIMPLE_TOKEN_SCRIPT="RETURN TRUE";
const HEX=/^0x[0-9a-f]{64}$/i, ZERO="0x00";
function amount(value,allowZero=false) {
  if (typeof value!=="string" || !/^\d{1,30}(?:\.\d{1,44})?$/.test(value) || (!allowZero && toUnits(value)===0n)) throw Error("Invalid amount");
  return toUnits(value);
}
function units(coin) {return amount(coin.tokenid===ZERO?coin.amount:coin.tokenamount);}
async function address(value) {
  if (!wallet._validators.looksLikeMinimaAddress(value)) throw Error("Invalid recipient address");
  const a=await command("checkaddress address:"+value);
  if (!HEX.test(a?.["0x"])) throw Error("Invalid recipient address");
  return a["0x"];
}
function plain(c) {
  return HEX.test(c.coinid) && (c.tokenid===ZERO || (HEX.test(c.tokenid) && c.token?.script?.trim().toUpperCase()===SIMPLE_TOKEN_SCRIPT))
    && Array.isArray(c.state) && c.state.length===0;
}
async function coins() {
  const rows=await command("coins relevant:true own:true simplestate:false");
  if(!Array.isArray(rows)) throw Error("Could not read the node wallet.");
  return rows.map(c=>({...c,eligible:plain(c) && Number(c.age)>=3}));
}
function splitUnits(total,n,decimals) {
  const scale=10n**BigInt(44-decimals);
  if(total%scale!==0n) throw Error("Amount exceeds the token precision.");
  const integer=total/scale, each=integer/BigInt(n), remainder=integer%BigInt(n);
  if(!each) throw Error("Amount is too small for this split.");
  return Array.from({length:n},(_,i)=>fromUnits((each+(BigInt(i)<remainder?1n:0n))*scale));
}
function compareDraft(tx,inputs,outputs,token) {
  if (!tx || tx.inputs?.length!==inputs.length || tx.outputs?.length!==outputs.length) throw Error("The transaction differs from the reviewed payment.");
  const ids=new Set(inputs.map(c=>c.coinid.toLowerCase()));
  for(const c of tx.inputs) if(c.tokenid!==token || !ids.delete(c.coinid.toLowerCase())) throw Error("Unexpected transaction input.");
  for(let i=0;i<outputs.length;i++){
    const expected=outputs[i],got=tx.outputs[i];
    if (got.tokenid!==token || got.address.toLowerCase()!==expected.address.toLowerCase() || units(got)!==amount(expected.amount) || !HEX.test(got.coinid))
      throw Error("Unexpected transaction output.");
  }
}
async function post(state,persist,opts,onIntent) {
  const token=opts.tokenid;
  if(token!==ZERO && !HEX.test(token))throw Error("Invalid token id");
  const rows=await command("coins relevant:true own:true checkmempool:true coinage:3 simplestate:false tokenid:"+token);
  const reserved=new Set(state.payments.filter(r=>["submitting","unknown","submitted"].includes(r.status)).flatMap(r=>r.inputs || []));
  for (const job of state.distributions) {
    if (job.id===opts.distribution || job.status==="complete") continue;
    const payment=state.payments.find(p=>p.id===job.payment);
    if (payment && payment.change>=0) reserved.add(payment.outputs[payment.change].coinid);
  }
  const available=rows.filter(c=>plain(c) && !reserved.has(c.coinid) && !require("./reserve").sendHeld("wallet",c.coinid));
  const burn=amount(opts.burn || "0",true);
  const companionBurn = token!==ZERO ? burn : 0n;
  if (burn && opts.confirmedBurn!==fromUnits(burn)) throw Error("Confirm the exact Minima burn.");
  if (companionBurn) {
    const held=new Set(require("./reserve").list().map(r=>r.coinid));
    // A reservation can outlive the input it protected. Only coins the node could actually select for this burn matter.
    const funding=await command("coins relevant:true own:true tokenid:0x00 checkmempool:true");
    if (funding.some(c=>held.has(c.coinid))) throw Error("Minima coins are reserved by another operation. Wait before using a burn.");
  }
  if(!Array.isArray(opts.outputs)||!opts.outputs.length||opts.outputs.length>56)throw Error("Choose at least one output.");
  const outputs=[];
  for(const o of opts.outputs) outputs.push({address:await address(o.address),amount:fromUnits(amount(o.amount))});
  const needed=outputs.reduce((n,o)=>n+amount(o.amount),burn-companionBurn);
  const minimum=opts.remainingFunding || needed;
  const named=opts.inputs;
  let inputs=[],total=0n;
  if(named!==undefined) {
    if(!Array.isArray(named)||!named.length||named.length>256||new Set(named).size!==named.length)throw Error("Invalid coin selection.");
    inputs=named.map(id=>{const c=available.find(x=>x.coinid===id);if(!c)throw Error("A selected coin is unavailable.");return c;});
    total=inputs.reduce((n,c)=>n+units(c),0n);
  } else {
    available.sort((a,b)=> units(a)===units(b)?0:units(a)>units(b)?-1:1);
    for(const c of available) {inputs.push(c);total+=units(c);if(total>=minimum)break;}
  }
  if(total<minimum)throw Error("Insufficient spendable funds");
  let change=-1;
  if(total>needed) {
    const dest=opts.change || (await command("getaddress")).address;
    const normalized=await address(dest);
    if((await command("checkaddress address:"+normalized)).simple!==true)throw Error("Change must return to a node-owned address.");
    change=outputs.length;outputs.push({address:normalized,amount:fromUnits(total-needed)});
  }
  const id=randomUUID();
  await command("txncreate id:"+id);
  try {
    for (const c of inputs) await command("txninput id:"+id+" coinid:"+c.coinid);
    for (const o of outputs) await command("txnoutput id:"+id+" address:"+o.address+" amount:"+o.amount+" tokenid:"+token+" storestate:false");
    const draft=(await command("txnlist id:"+id)).transaction;
    compareDraft(draft,inputs,outputs,token);
    await command("txnsign id:"+id+" publickey:auto");await command("txnbasics id:"+id);
    if((await command("txncheck id:"+id)).validtransaction!==true) throw Error("The node could not validate the payment.");
    const record={id,transactionid:draft.transactionid,kind:"payment",time:Date.now(),status:"submitting",burn:fromUnits(burn),token,inputs:inputs.map(c=>c.coinid),
      outputs:draft.outputs.map((c,i)=>({...outputs[i],coinid:c.coinid})),change};
    state.payments.push(record);if(onIntent)onIntent(record);persist();
    await jobs.assertIdentity(opts.wallet);
    let posted;
    try{posted=await command("txnpost id:"+id+" mine:false"+(companionBurn?" burn:"+fromUnits(companionBurn):""));}
    catch(e){record.status="unknown";persist();throw Error("Check History and your balance before trying this payment again.");}
    record.txpowid=posted?.txpowid;
    record.status=HEX.test(record.txpowid)?"submitted":"unknown";persist();return record;
  } finally {await command("txndelete id:"+id).catch(()=>{});}
}
async function pay(id,opts,confirmBurn) {
  await jobs.assertIdentity(id);
  const burn=amount(opts.burn || "0",true);
  opts={...opts,confirmedBurn:null};
  if (burn) {
    const exact=fromUnits(burn);
    if (opts.consolidate || typeof confirmBurn!=="function" || !await confirmBurn(exact)) throw Error("Burn cancelled.");
    opts.confirmedBurn=exact;
  }
  return jobs.withWallet(id,async(state,persist)=>{
    if (opts.consolidate) {
      if (!Array.isArray(opts.inputs) || opts.inputs.length<2) throw Error("Select at least two coins to consolidate.");
      const selected=(await coins()).filter(c=>opts.inputs.includes(c.coinid));
      const dest=await address(opts.change || (await command("getaddress")).address);
      if ((await command("checkaddress address:"+dest)).simple!==true) throw Error("Consolidation must return to a node-owned address.");
      if (selected.length!==opts.inputs.length || selected.some(c=>!c.eligible || c.tokenid!==opts.tokenid)) throw Error("A selected coin is unavailable.");
      opts={tokenid:opts.tokenid,inputs:opts.inputs,outputs:[{address:dest,amount:fromUnits(selected.reduce((n,c)=>n+units(c),0n))}]};
    }
    if(opts.split!==undefined){
      const count=Number(opts.split);
      if(!Number.isInteger(count)||count<1||count>20)throw Error("Choose 1 to 20 splits.");
      if(!Array.isArray(opts.outputs)||opts.outputs.length!==1)throw Error("Split requires one recipient.");
      if(opts.tokenid!==ZERO&&!HEX.test(opts.tokenid))throw Error("Invalid token id");
      const decimals=opts.tokenid===ZERO?44:Number((await command("tokens tokenid:"+opts.tokenid)).decimals);
      if(!Number.isInteger(decimals)||decimals<0||decimals>44)throw Error("Invalid token precision.");
      const o=opts.outputs[0];opts={...opts,outputs:splitUnits(amount(o.amount),count,decimals).map(v=>({address:o.address,amount:v}))};
    }
    return post(state,persist,{...opts,wallet:id,distribution:undefined,remainingFunding:undefined});
  });
}
async function distribute(id,opts) {
  await jobs.assertIdentity(id);
  return jobs.withWallet(id,async(state,persist)=>{
    if(!Array.isArray(opts.recipients)||!opts.recipients.length||opts.recipients.length>56) throw Error("Choose 1 to 56 recipients.");
    if(opts.tokenid!==ZERO&&!HEX.test(opts.tokenid))throw Error("Invalid token id");
    const recipients=[];for(const to of opts.recipients)recipients.push(await address(to));
    const per=fromUnits(amount(opts.per));
    const job={id:randomUUID(),tokenid:opts.tokenid,per,recipients,next:0,status:"ready"};
    if(opts.inputs?.length)job.inputs=opts.inputs;
    state.distributions.push(job);persist();return {job:job.id};
  });
}
async function advance(state,persist,id) {
  for (const j of state.distributions) {
    if(!["waiting","ready"].includes(j.status))continue;
    if(j.status==="waiting") {
      const r=state.payments.find(x=>x.id===j.payment);
      if(!r)throw Error("Distribution is missing its transaction record.");
      const output=r.outputs[r.change<0?0:r.change];
      const observed=await command("coins coinid:"+output.coinid+" coinage:3");
      const landed=r.status==="confirmed" && j.next+j.batch>=j.recipients.length;
      if(!landed && !observed.some(c=>c.coinid===output.coinid && c.address===output.address && c.tokenid===r.token && units(c)===amount(output.amount))) continue;
      r.status="confirmed";j.next+=j.batch;
      if(j.next>=j.recipients.length){j.status="complete";persist();continue;}
      if(r.change<0){j.status="paused";j.error="No confirmed change remains for the next batch.";persist();continue;}
      j.inputs=[output.coinid];j.status="ready";persist();
    }
    const next=j.recipients.slice(j.next,j.next+14);
    try {
      await post(state,persist,{distribution:j.id,wallet:id,remainingFunding:amount(j.per)*BigInt(j.recipients.length-j.next),tokenid:j.tokenid,inputs:j.inputs,outputs:next.map(to=>({address:to,amount:j.per})),
        change:(await command("newaddress")).address},r=>{j.payment=r.id;j.batch=next.length;j.status="waiting";});
    } catch(e){j.error=e.message;if(j.status==="ready")j.status="paused";persist();}
    return;
  }
}
module.exports={coins,pay,distribute,advance,splitUnits,compareDraft};
async function confirmedReceipt(record, txpows) {
  if (!HEX.test(record.transactionid)) return false;
  const match=txpows.find(pow=>pow.istransaction && pow.body?.txn?.transactionid===record.transactionid);
  if (!match || !HEX.test(match.txpowid))return false;
  const inclusion=await command("txpow onchain:"+match.txpowid);
  if (!inclusion?.found || !HEX.test(inclusion.blockid) || /^0x0+$/i.test(inclusion.blockid)) return false;
  const height=Number(inclusion.block),tip=Number(inclusion.tip),depth=Number(inclusion.confirmations);
  if (!Number.isSafeInteger(height) || height<=0 || !Number.isSafeInteger(tip) || depth<3 || tip-height!==depth)return false;
  record.txpowid=match.txpowid;
  return true;
}
async function reconcile(state,persist) {
  const pending=state.payments.filter(r=>HEX.test(r.transactionid) && r.status!=="confirmed");
  if (!pending.length)return;
  const history=await command("history relevant:true max:8");
  for(const r of pending) {
    if(await confirmedReceipt(r,history.txpows || [])){r.status="confirmed";persist();}
  }
  for(const row of state.collections) {
    if(row.phase!=="BURY" || !row.burialInputs?.length)continue;
    if(row.burialInputs.every(id=>state.payments.some(p=>p.kind==="burial" && p.status==="confirmed" && p.inputs?.includes(id)))){
      row.phase="BURIED";persist();
    }
  }
}
module.exports.reconcile=reconcile;
