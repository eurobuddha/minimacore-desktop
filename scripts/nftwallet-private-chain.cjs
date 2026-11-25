// End-to-end proof using disposable, offline genesis networks. No production RPC or wallet.
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { spawn } = require("child_process"), { randomBytes } = require("crypto");
const Module = require("module"), root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nft-wallet-chain-"));
const java = path.join(root, "resources", "jre", "bin", process.platform === "win32" ? "java.exe" : "java");
const jar = path.join(root, "resources-pandamonium", "minima.jar");
const load = Module._load;
Module._load = function(id, parent) {
  if (id === "electron") return {app:{getPath:()=>tmp,isPackaged:true}};
  if (id === "./node-manager" && parent.filename.endsWith("nftjobs.js")) return { javaPath: () => java };
  return load.apply(this, arguments);
};
process.resourcesPath = tmp;
for (const [name, target] of [["minima.jar", jar], ["nftwallet.jar", path.join(root, "resources/nftwallet.jar")]]) fs.copyFileSync(target, path.join(tmp, name));
const ww = require("../main/webwallet"), rpc = require("../main/rpc");
const secret = randomBytes(24).toString("hex");
const nap = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 900000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await nap(1000); }
  throw new Error("Timed out waiting for " + label);
}
async function run(port) {
  for (let i = 0; i < 6; i++) await new Promise((resolve, reject) => {
    const s = net.createServer(); s.once("error", reject); s.listen(port + i, "127.0.0.1", () => s.close(resolve));
  });
  const log = fs.openSync(path.join(tmp,"test-node.log"), "w");
  const p = spawn(java, ["-Xmx768m", "-jar", jar, "-data", path.join(tmp,"node"), "-port", String(port),
    "-test", "-genesis", "-nop2p", "-host", "127.0.0.1", "-megammr", "-rpcenable", "-rpcbind", "127.0.0.1",
    "-rpcpassword", secret], { stdio: ["ignore", log, log] });
  fs.closeSync(log);
  const stopped = new Promise(resolve => p.once("exit", resolve));
  const cmd = c => rpc.rpcCall(port + 4, secret, c);
  const ok = async c => { const r = await cmd(c); assert.equal(r.status, true, r.error); return r.response; };
  try {
    await until(async () => {
      if (p.exitCode !== null) throw new Error("Test node exited. See " + tmp);
      const st = await ok("status").catch(() => null);
      return st && st.megammr && /-TEST/.test(st.version);
    }, "private chain");
    ww._setRunner(cmd);
    const jobs = require("../main/nftjobs"), wallet = require("../main/nftwallet"), coins = require("../main/nftcoins");
    const id = await jobs.identity();
    const dest = (await ok("newaddress")).address;
    await until(async () => (await coins.coins()).some(c => c.eligible), "confirmed genesis");
    const pay = await coins.pay(id,{tokenid:"0x00", outputs:[{address:dest,amount:"3"}], split:3});
    assert.equal(pay.status,"submitted");
    await until(async () => (await ok("coins address:"+dest+" coinage:3")).filter(c => c.amount==="1").length===3, "three split outputs");
    console.log("Confirmed all three reviewed quick-send outputs");
    await jobs.mint(id,{kind:"NFT",name:"Fixture",amount:"2",decimals:0,icon:"https://example.invalid/fixture.png"});
    const regular = await until(async () => (await wallet.list()).find(c=>!c.collection),"regular NFT");
    await until(async () => (await ok("coins coinage:3 coinid:"+regular.coinid)).length,"aged NFT");
    const transferred = await wallet.transfer(regular.coinid,dest,id);
    assert.ok(transferred.txpowid);
    await until(async () => (await ok("coins tokenid:"+regular.tokenid+" address:"+dest)).length,"transferred NFT");
    console.log("Confirmed regular NFT creation and transfer");
    await until(async ()=>(await ok("coins coinage:3 address:"+dest+" tokenid:"+regular.tokenid)).length,"aged test token");
    const feePayment={tokenid:regular.tokenid,outputs:[{amount:"1",address:dest}],burn:"0.03125"};
    await assert.rejects(coins.pay(id,feePayment),/Burn cancelled/);
    const receipt=await coins.pay(id,feePayment,async exact=>exact==="0.03125");
    assert.equal(receipt.burn,"0.03125");
    await until(async ()=>(await ok("coins coinage:3 coinid:"+receipt.outputs[0].coinid)).length,"token payment with confirmed Minima burn");
    const txpows=await ok("txpow address:"+dest);
    const proof=txpows.find(p=>p.body?.txn?.outputs?.some(o=>o.coinid===receipt.outputs[0].coinid));
    const burn=proof?.body?.burntxn;
    const {toUnits}=require("../main/sendpin");
    assert.ok(burn?.inputs.length);
    const sum=rows=>rows.reduce((n,c)=>n+toUnits(c.amount),0n);
    assert.equal(sum(burn.inputs)-sum(burn.outputs),toUnits("0.03125"));
    console.log("Verified opt-in custom-token burn and refusal without confirmation");
    await jobs.mint(id,{kind:"Collection",name:"LockedFixture",size:2,mode:"url",base:"https://example.invalid/item",ext:".png"});
    await until(async () => {
      await jobs.tick();
      const r=(await jobs.status()).collections[0];
      if (r.error) console.log(r.phase,r.error);
      return r.phase==="DONE";
    }, "completed collection");
    console.log("Confirmed two sealed editions");
    const editions=(await wallet.list()).filter(c=>c.collection);
    assert.equal(editions.length,2);
    await until(async () => (await ok("coins relevant:true coinage:3 tokenid:"+editions[0].tokenid)).length===2,"aged editions");
    const buried=await wallet.buryCollection(id,editions[0].tokenid,editions.map(c=>c.coinid));
    assert.equal(buried.submitted,2);
    const grave="0xABA005476D2B3CD7F251B9783E64C124C9670BB358695F04D91B2057BB64CB49";
    await until(async () => (await ok("coins megammr:true coinage:3 tokenid:"+editions[0].tokenid+" address:"+grave)).length===2, "burial outputs");
    console.log("Confirmed both editions arrived at the graveyard");
    await coins.distribute(id,{tokenid:"0x00",recipients:Array(15).fill(dest),per:"0.125"});
    await until(async () => {await jobs.tick();const j=(await jobs.status()).distributions[0];if(j.status==="paused")throw Error(j.error);return j.status==="complete";}, "two distribution batches");
    assert.equal((await ok("coins relevant:true address:"+dest+" amount:0.125")).length,15);
    const merge=(await coins.coins()).filter(c=>c.eligible && c.address===dest && c.amount==="0.125").slice(0,2);
    assert.equal((await coins.pay(id,{tokenid:"0x00",inputs:merge.map(c=>c.coinid),change:dest,consolidate:true})).status,"submitted");
    await until(async ()=>(await ok("coins relevant:true coinage:3 address:"+dest+" amount:0.25")).length,"consolidation");
    console.log("Confirmed 15 recipients in two batches and consolidation into one owned coin");

  } finally { p.kill("SIGTERM"); const timer=setTimeout(()=>p.kill("SIGKILL"),8000); await stopped;clearTimeout(timer); }
}
run(41000+Math.floor(Math.random()*9000)).catch(e=>{console.error(e.message,tmp);process.exitCode=1;});
