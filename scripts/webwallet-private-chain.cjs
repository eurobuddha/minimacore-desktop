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
  if (id === "electron") return { app: { getPath: () => tmp, isPackaged: true } };
  if (id === "./node-manager" && parent.filename.endsWith("classic-webwallet.js")) return { javaPath: () => java };
  return load.apply(this, arguments);
};
process.resourcesPath = tmp;
for (const [name, target] of [["minima.jar", jar], ["classic-webwallet.jar", path.join(root, "resources/classic-webwallet.jar")]]) fs.copyFileSync(target, path.join(tmp, name));
const ww = require("../main/webwallet"), rpc = require("../main/rpc");
const phrase = "Classic  Web:Wallet fixture", secret = randomBytes(24).toString("hex");
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
    const expected = await ok('keys action:genkey phrase:"' + phrase + '"');
    const trace = [];
    ww._setRunner(c => { trace.push(c.split(" ")[0]); assert.ok(!c.includes(phrase)); return cmd(c); });
    const wallet = await ww.derive(phrase);
    assert.equal(wallet.isNodeSeed, false);
    if (!classic) {
      assert.equal(wallet.publickey, expected.publickey);
      assert.equal(wallet.miniaddress, expected.miniaddress);
    } else {
      assert.notEqual(wallet.publickey, expected.publickey);
      assert.deepEqual(wallet, classic);
    }
    ww.setOnchain(async () => 0);
    await ww.ackKeyuses(wallet.address, ww.keyusesInfo(wallet.address).keyuses);
    const to = (await ok("getaddress")).address;
    await until(async () => (await cmd("send amount:7 address:" + wallet.address + " mine:true")).status, "genesis funding");
    await until(async () => (await ok("coins megammr:true coinage:3 address:" + wallet.address)).length, "confirmed funding");
    const res = await ww.send({ seed: phrase, to, amount: "2.5" });
    assert.equal(res.ok, true, res.message);
    await until(async () => (await ww.read(wallet.address)).some(row => row.tokenid === "0x00" && row.confirmed === "4.5"), "confirmed change");
    assert.ok((await ok("coins megammr:true address:" + to)).some(c => c.amount === "2.5"));
    if (mode === "block") {
      await ok('tokencreate name:{"name":"WebWalletFixture"} amount:100 decimals:2 mine:true');
      const token = await until(async () => {
        const coins = await ok("coins relevant:true");
        return coins.find(c => c.tokenid !== "0x00" && c.tokenamount === "100")?.tokenid;
      }, "issued test token");
      await until(async () => (await cmd("send tokenid:" + token + " amount:5.75 address:" + wallet.address + " mine:true")).status, "token funding");
      await until(async () => (await ok("coins megammr:true coinage:3 tokenid:" + token + " address:" + wallet.address)).length, "confirmed token funding");
      const tokenSend = await ww.send({ seed: phrase, to, amount: "1.25", tokenid: token });
      assert.equal(tokenSend.ok, true, tokenSend.message);
      await until(async () => (await ww.read(wallet.address)).some(r => r.tokenid === token && Number(r.confirmed) === 4.5), "confirmed token change");
      assert.ok((await ok("coins megammr:true tokenid:" + token + " address:" + to)).some(c => c.tokenamount === "1.25"));
      console.log("block confirmed 1.25 custom tokens delivered and 4.5 change");
    }
    assert.ok(trace.includes("txncheck") && trace.includes("txnpost"));
    assert.ok(!trace.some(c => ["send","sendfrom","txnsign","txncreate","txninput","txnoutput"].includes(c)));
    console.log(mode + " confirmed 2.5 sent and 4.5 change at " + wallet.miniaddress);
    return wallet;
  } finally { p.kill("SIGTERM"); const timer = setTimeout(() => p.kill("SIGKILL"), 8000); await stopped; clearTimeout(timer); }
}
(async () => {
  const port = 35000 + Math.floor(Math.random() * 15000);
  const classic = await run("classic", port);
  await run("block", port + 10, classic);
})().catch(e => { console.error(e.message, tmp); process.exitCode = 1; });
