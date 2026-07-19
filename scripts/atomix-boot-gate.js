/*
 * S1 BOOT GATE — boots the desktop AtomiX engine (the verbatim vm build) against a REAL mainnet Classic node
 * (the minimega docker container, RPC in-container at 127.0.0.1:9005) and asserts the engine reaches
 * "booted — settlement + maker/responder + OTC live".
 *
 * The strongest cross-platform assertion available: minimega ALSO runs the AtomiX MDS build, and both derive
 * their identity from the SAME node seed — so this engine MUST derive ETH address
 * 0x7373cf1ff0677a59e9ec7d327c1de0dd67dd625e, byte-for-byte equal to the MDS peer's. One boot proves the RPC
 * command shim, the SQL shim (all 9 tables incl. MERGE/auto_increment translations), the crypto stack, and
 * vault/seedrandom identity derivation.
 *
 * Run: node scripts/atomix-boot-gate.js   (exits 0 on pass; read-mostly — boot registers the covenant script
 * [idempotent] and reads the seed; no funds move, no maker is configured.)
 */
const { execFile } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const EXPECT_ETH = "0x7373cf1ff0677a59e9ec7d327c1de0dd67dd625e";

function dockerRpc(cmd) {
  return new Promise((resolve, reject) => {
    const url = "http://127.0.0.1:9005/" + encodeURIComponent(cmd);
    execFile("docker", ["exec", "minimega", "curl", "-s", "-m", "60", url],
      { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error("bad RPC JSON: " + String(stdout).slice(0, 120))); }
      });
  });
}

(async () => {
  const atomix = require("../main/atomix");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atomix-gate-"));
  atomix._setDataDir(tmp);
  atomix._setRunner(dockerRpc);

  await atomix.init();
  const deadline = Date.now() + 120000;
  let st;
  while (Date.now() < deadline) {
    st = atomix.status();
    if (st.ready) break;
    await new Promise(r => setTimeout(r, 2000));
    // the engine's own self-healing boot retries are paced ~55s; nudge it with the timer event instead of waiting
    if (!st.ready) atomix._fire("MDS_TIMER_60SECONDS");
  }

  console.log("status:", JSON.stringify({ ready: st.ready, eth: st.eth, currency: st.currency }, null, 1));
  console.log("engine log tail:", st.log.slice(-5).join(" | "));

  let fail = false;
  if (!st.ready) { console.error("GATE FAIL: engine never booted"); fail = true; }
  if (st.eth !== EXPECT_ETH) { console.error("GATE FAIL: derived ETH " + st.eth + " ≠ MDS peer " + EXPECT_ETH); fail = true; }
  if (!fail) {
    // fire one NEWBLOCK so a full engine poll (settle+maker+otc+market collector) runs once against mainnet
    atomix._fire("NEWBLOCK");
    await new Promise(r => setTimeout(r, 20000));
    console.log("post-poll log tail:", atomix.status().log.slice(-5).join(" | "));
    console.log("✅ S1 BOOT GATE PASS — desktop engine live on a real mainnet node, identity byte-identical to the MDS peer");
  }
  atomix.stopLoop(); atomix.flush();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("GATE ERROR:", e); process.exit(1); });
