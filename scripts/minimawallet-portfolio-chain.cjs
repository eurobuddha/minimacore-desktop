// End-to-end proof using disposable, offline genesis networks. No production RPC or wallet.
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { spawn } = require("child_process"), { randomBytes } = require("crypto");
const Module = require("module"), root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "classic-wallet-chain-"));
const java = path.join(root, "resources", "jre", "bin", process.platform === "win32" ? "java.exe" : "java");
const jar = path.join(root, "resources-pandamonium", "minima.jar");
const load = Module._load;
Module._load = function(id, parent) {
  if (id === "electron") return { app: { getPath: () => tmp, isPackaged: true }, safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test",
    encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString()
  } };
  if (id === "./node-manager" && parent.filename.endsWith("classic-webwallet.js")) return { javaPath: () => java };
  return load.apply(this, arguments);
};
process.resourcesPath = tmp;
for (const [name, target] of [["minima.jar", jar], ["classic-webwallet.jar", path.join(root, "resources/classic-webwallet.jar")]]) fs.copyFileSync(target, path.join(tmp, name));
const ww = require("../main/webwallet"), rpc = require("../main/rpc");
const secret = randomBytes(24).toString("hex");
const nap = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 240000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await nap(1000); }
  throw new Error("Timed out waiting for " + label);
}
async function run(mode, port, classic) {
  for (let i = 0; i < 6; i++) await new Promise((resolve, reject) => {
    const s = net.createServer(); s.once("error", reject); s.listen(port + i, "127.0.0.1", () => s.close(resolve));
  });
  const log = fs.openSync(path.join(tmp, mode + ".log"), "w");
  const p = spawn(java, ["-Xmx768m", "-jar", jar, "-data", path.join(tmp, mode), "-port", String(port),
    "-test", "-genesis", "-nop2p", "-host", "127.0.0.1", "-megammr", "-rpcenable", "-rpcbind", "127.0.0.1",
    "-rpcpassword", secret, ...(mode === "block" ? ["-blockaskeyuses"] : [])], { stdio: ["ignore", log, log] });
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
    ww.setOnchain(async()=>0);
    const mw=require("../main/minimawallet");
    const original=await mw.home();
    assert.ok(original.owned);
    const nodeAddress=original.destination;
    assert.ok((await mw.review(original.id,{kind:"sweep",to:nodeAddress})).handoff);
    const id=await mw.replace(original.id,{source:"manual",mode:"classic",seed:"disposable portfolio wallet seed"});
    const start=await mw.home(id);
    const [a,b]=start.addresses;
    const fund=async command=>until(async()=>(await cmd(command)).status,"confirmed funding inputs");
    await fund("send multi:"+JSON.stringify([a+":3",b+":4"])+" mine:true");
    await until(async()=>(await ok("coins megammr:true coinage:3 address:"+a)).length,"confirmed Minima funding");
    await fund('tokencreate name:{"name":"Portfolio fixture"} amount:10 decimals:2 mine:true');
    const token=await until(async()=>(await ok("coins relevant:true")).find(c=>c.tokenamount==="10")?.tokenid,"fixture token");
    await fund("send multi:"+JSON.stringify([a+":1.25",b+":2.75"])+" tokenid:"+token+" mine:true");
    await until(async()=>(await ok("coins megammr:true coinage:3 address:"+a+" tokenid:"+token)).length,"confirmed tokens");
    let h=await mw.home(id);
    assert.equal(h.balances.find(x=>x.tokenid==="0x00").amount,"7");
    assert.equal(h.balances.find(x=>x.tokenid===token).amount,"4");
    const pay=await mw.review(id,{kind:"send",tokenid:"0x00",amount:"5",to:nodeAddress});
    assert.equal(pay.keys.length,2);
    await assert.rejects(mw.execute(id,{ticket:pay.ticket,uses:{}}),/count/);
    const uses=p=>Object.fromEntries(p.keys.map(k=>[k.index,String(k.minimum)]));
    let result=await mw.execute(id,{ticket:pay.ticket,uses:uses(pay)});
    assert.equal(result.submitted,1,result.error);
    await until(async()=>(await ok("coins megammr:true coinage:3 address:"+a+" amount:2")).length,"wallet change");
    await assert.rejects(mw.review(id,{kind:"sweep",to:a}),/node/i);
    const sweep=await mw.review(id,{kind:"sweep",to:nodeAddress});
    assert.equal(sweep.transactions,2);
    await assert.rejects(mw.execute(id,{ticket:sweep.ticket,uses:uses(sweep),confirmation:a}),/destination/);
    result=await mw.execute(id,{ticket:sweep.ticket,uses:uses(sweep),confirmation:nodeAddress});
    assert.equal(result.submitted,2,result.error);
    await until(async()=>(await ok("coins relevant:true address:"+nodeAddress+" tokenid:"+token+" coinage:3")).some(c=>c.tokenamount==="4"),"swept tokens at main node");
    h=await mw.home(id);
    assert.equal(h.balances.find(x=>x.tokenid==="0x00").amount,"0");
    assert.ok(!h.balances.some(x=>x.tokenid===token));
    await fund('tokencreate name:{"name":"PortfolioEdition"} amount:1 decimals:0 mine:true');
    const edition=await until(async()=>(await ok("coins relevant:true coinage:3")).find(c=>c.token?.name?.name==="PortfolioEdition")?.tokenid,"issued edition");
    await fund('send tokenid:'+edition+' amount:1 address:'+b+' state:{"0":"42"} mine:true');
    const item=await until(async()=>(await ok("coins megammr:true simplestate:false coinage:3 address:"+b+" tokenid:"+edition))[0],"wallet edition");
    assert.ok(item.state.some(r=>String(r.data)==="42"));
    const itemReview=await mw.review(id,{kind:"items",coinids:[item.coinid],tokenid:edition,to:nodeAddress});
    assert.deepEqual(itemReview.coinids,[item.coinid]);
    const itemResult=await mw.execute(id,{ticket:itemReview.ticket,uses:uses(itemReview)});
    assert.equal(itemResult.submitted,1,itemResult.error);
    const landed=await until(async()=>(await ok("coins relevant:true simplestate:false coinage:3 address:"+nodeAddress+" tokenid:"+edition))[0],"transferred edition");
    assert.deepEqual(landed.state,item.state);
    console.log("Verified exact NFT coin selection and state-preserving transfer.");
    console.log("Verified multi-address Minima and token totals, multi-key send, native handoff, destination rejection and confirmed sweep.");
  } finally {p.kill("SIGTERM");const timer=setTimeout(()=>p.kill("SIGKILL"),8000);await stopped;clearTimeout(timer);}
}
run("classic",38000+Math.floor(Math.random()*12000)).catch(e=>{console.error(e.stack);process.exitCode=1;});
