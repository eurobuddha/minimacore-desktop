"use strict";
const { randomUUID } = require("node:crypto");
const node = require("./webwallet");
// StateNFT fingerprints and state-preserving transaction steps from mds/statenft-suite/minidapp.
function engineStateNftPk(script) {
  var m = ("" + script).match(/^IF SIGNEDBY\((0x[0-9A-Fa-f]+)\) THEN RETURN TRUE ENDIF RETURN VERIFYOUT\(@INPUT GETOUTADDR\(@INPUT\) @AMOUNT @TOKENID TRUE\)$/) ||
          ("" + script).match(/^LET s=PREVSTATE\(0\) IF s EQ 0 AND SIGNEDBY\((0x[0-9A-Fa-f]+)\) THEN RETURN TRUE ENDIF RETURN SAMESTATE\(0 [01]\) AND VERIFYOUT\(@INPUT GETOUTADDR\(@INPUT\) @AMOUNT @TOKENID TRUE\)$/);
  return m ? m[1] : null;
}

function engineStamped(coin) {
  var s0 = engineState(coin, 0);
  return (s0 !== null && s0 !== "0") ? s0 : null;
}

function engineState(coin, port) {
  var st = coin.state || [];
  for (var i = 0; i < st.length; i++) {
    if (st[i].port == port) { return "" + st[i].data; }
  }
  return null;
}

function sendValidAddress(a) {
  /* 0x / Mx, alphanumeric only — nothing hostile can reach SQL or a txn */
  return /^(0x|Mx)[0-9A-Za-z]{8,}$/.test("" + a);
}

function sendSafeStateValue(v) {
  v = "" + v;
  if (/^[0-9]+$/.test(v)) { return true; }
  if (/^\[[A-Za-z0-9+/=]*\]$/.test(v)) { return true; }
  return false;
}

function sendPlanSteps(coin, recipient, tokenid, txnid) {
  if (!sendValidAddress(recipient)) { return null; }
  var steps = [
    "txninput id:" + txnid + " coinid:" + coin.coinid,
    "txnoutput id:" + txnid + " amount:" + coin.tokenamount +
      " address:" + recipient + " tokenid:" + tokenid + " storestate:true"
  ];
  var st = coin.state || [];
  for (var i = 0; i < st.length; i++) {
    if (!/^[0-9]+$/.test("" + st[i].port) || !sendSafeStateValue(st[i].data)) {
      return null;
    }
    steps.push("txnstate id:" + txnid + " port:" + st[i].port +
               " value:" + st[i].data);
  }
  steps.push("txnsign id:" + txnid + " publickey:auto");
  return steps;
}
const HEX = /^0x[0-9a-f]{64}$/i;
const jobs = require("./nftjobs");
const graveyard = "0xABA005476D2B3CD7F251B9783E64C124C9670BB358695F04D91B2057BB64CB49";
const held = new Set();
function ownCoins(filter = "") {
  return node.checkedCommand("coins relevant:true own:true simplestate:false" + filter);
}
function nft(coin) {
  return HEX.test(coin.tokenid) && HEX.test(coin.coinid) && coin.token && String(coin.token.decimals) === "0";
}
async function list() {
  return jobs.withWallet(null, async (state, _persist, id) => {
  const pending = new Set(state.payments.filter(p => ["submitting","unknown","submitted"].includes(p.status)).flatMap(p=>p.inputs || []));
  const coins = await ownCoins();
  if (!Array.isArray(coins)) throw new Error("Could not read the node wallet.");
  return coins.filter(nft).map(c => {
    const collection = !!engineStateNftPk(c.token.script);
    return { wallet:id, coinid:c.coinid, tokenid:c.tokenid, address:c.miniaddress, token:c.token,
      age:Number(c.age), amount:c.tokenamount, state:c.state, collection, edition:collection ? engineStamped(c) : null,
      pending:pending.has(c.coinid) || held.has(c.coinid) };
  });
  });
}
// Re-read ownership, identity, amount and every state port from the current node immediately before the signature.
async function transfer(coinid, to, walletId) {
  await jobs.assertIdentity(walletId);
  return jobs.withWallet(walletId, (state,persist) => move(coinid,to,walletId,state,persist));
}
async function move(coinid,to,walletId,state,persist) {
  if (!HEX.test(coinid) || !node._validators.looksLikeMinimaAddress(to)) throw new Error("Invalid coin or recipient address.");
  if (held.has(coinid) || state.payments.some(r=>["submitting","unknown","submitted"].includes(r.status) && r.inputs?.includes(coinid))) throw new Error("This coin already has a pending transfer.");
  held.add(coinid);
  const id = randomUUID();
  try {
    const rows = await ownCoins(" checkmempool:true coinage:3 coinid:" + coinid);
    const c = rows?.[0];
    if (rows?.length !== 1 || c.coinid !== coinid || !nft(c) || !/^[1-9]\d*$/.test(c.tokenamount))
      throw new Error("This node no longer owns a confirmed, transferable NFT at that coin ID.");
    if (to !== graveyard && engineStateNftPk(c.token.script) && !/^[1-9]\d*$/.test(engineStamped(c) || "")) throw new Error("Unstamped collection items cannot be transferred.");
    const checked = await node.checkedCommand("checkaddress address:" + to);
    if (!HEX.test(checked?.["0x"])) throw new Error("Invalid recipient address");
    const steps = sendPlanSteps(c, checked["0x"], c.tokenid, id);
    if (!steps) throw new Error("Could not safely preserve all NFT state.");
    await node.checkedCommand("txncreate id:" + id);
    try {
      for (const step of steps) await node.checkedCommand(step);
      if (to===graveyard && engineStateNftPk(c.token.script) && !engineStamped(c)) {
        await node.checkedCommand("txnsign id:"+id+" publickey:"+engineStateNftPk(c.token.script));
      }
      await node.checkedCommand("txnbasics id:" + id);
      if ((await node.checkedCommand("txncheck id:" + id))?.validtransaction !== true) throw new Error("The node could not validate the NFT transfer.");
      const tx = (await node.checkedCommand("txnlist id:"+id)).transaction;
      const output = tx?.outputs?.[0];
      if (tx.inputs.length!==1 || tx.inputs[0].coinid!==coinid || tx.outputs.length!==1 || !HEX.test(output?.coinid) || output.address!==checked["0x"] || output.tokenid!==c.tokenid || output.tokenamount!==c.tokenamount)
        throw Error("The NFT transfer differs from the reviewed payment.");
      await jobs.assertIdentity(walletId);
      const record={id,transactionid:tx.transactionid,kind:to===graveyard?"burial":"transfer",time:Date.now(),status:"submitting",inputs:[coinid],token:c.tokenid,
        outputs:[{coinid:output.coinid,address:output.address,amount:output.tokenamount}], change:-1};
      state.payments.push(record);persist();
      try {
        const posted = await node.checkedCommand("txnpost id:" + id + " mine:false");
        if (HEX.test(posted?.txpowid)) {record.txpowid=posted.txpowid;record.status="submitted";persist();return {txpowid:posted.txpowid};}
      } catch { /* The relay may already have received the signed transfer. */ }
      record.status="unknown";persist();return {unknown:true};
    } finally { await node.checkedCommand("txndelete id:" + id).catch(()=>{}); }
  } finally { held.delete(coinid); }
}
async function buryCollection(walletId,token,reviewed) {
  await jobs.assertIdentity(walletId);
  if (!HEX.test(token) || !Array.isArray(reviewed) || !reviewed.length || reviewed.some(c=>!HEX.test(c)) || new Set(reviewed).size!==reviewed.length) throw Error("Invalid collection selection.");
  return jobs.withWallet(walletId,async(state,persist)=>{
    const owned=await ownCoins(" tokenid:"+token);
    if (owned.length!==reviewed.length || owned.some(c=>!reviewed.includes(c.coinid) || !engineStateNftPk(c.token.script)))
      throw Error("The collection changed. Review the current editions again.");
    const spendable=await ownCoins(" checkmempool:true coinage:3 tokenid:"+token);
    if (reviewed.some(id=>!spendable.some(c=>c.coinid===id))) throw Error("Wait for all editions to have three confirmations and no pending spend.");
    const mint=state.collections.find(r=>r.tokenid===token);
    if (mint) {mint.previousPhase=mint.phase;mint.burialInputs=[...new Set([...(mint.burialInputs||[]),...reviewed])];mint.phase="BURY";persist();}
    const submitted=[];
    for (const coinid of reviewed) {
      const result=await move(coinid,graveyard,walletId,state,persist);
      if (!result.txpowid) break;
      submitted.push(coinid);
    }
    return {submitted:submitted.length,total:reviewed.length};
  });
}
module.exports = { list, transfer, buryCollection };
