/*
 * S1 BOOT GATE — boots the desktop AtomiX engine (the verbatim vm build) against a REAL node and asserts the engine
 * reaches "booted — settlement + maker/responder + OTC live". One boot proves the RPC command shim, the SQL shim
 * (all 9 tables incl. MERGE/auto_increment translations), the crypto stack, and vault/seedrandom identity derivation.
 *
 * IT READS THE NODE'S SEED. Until 0.18.161 it ran `docker exec` into a fixed container name; on the owner's machine
 * that container is a wallet with real funds. It now runs ONLY against a node the caller names and says is theirs
 * (scripts/test-node.cjs: AX_TEST_NODE_RPC, optionally AX_TEST_NODE_CONTAINER, and AX_TEST_NODE_I_OWN_THIS=yes).
 * With nothing named it refuses with exit code 1: the live check is its whole purpose.
 *
 * Optional: AX_TEST_NODE_EXPECT_ETH=0x… — if another AtomiX build runs on the SAME node, both derive their identity
 * from the same seed, so this engine must derive that build's Ethereum address byte for byte.
 *
 * Run: AX_TEST_NODE_RPC=… AX_TEST_NODE_I_OWN_THIS=yes node scripts/atomix-boot-gate.js   (exits 0 on pass)
 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const { testNode, ENGINE_BOOT_SENDS, NAMES } = require("./test-node.cjs");

const EXPECT_ETH = String(process.env.AX_TEST_NODE_EXPECT_ETH || "").toLowerCase();
const NODE = testNode(ENGINE_BOOT_SENDS.concat("No maker is configured and nothing is locked by this script."));
if (!NODE) { console.error("S1 BOOT GATE NOT RUN: no test node was named. Set " + NAMES + ". Nothing was sent anywhere."); process.exit(1); }

(async () => {
  const atomix = require("../main/atomix");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atomix-gate-"));
  atomix._setDataDir(tmp);
  atomix._setRunner(NODE.run);

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
  if (EXPECT_ETH && String(st.eth).toLowerCase() !== EXPECT_ETH) { console.error("GATE FAIL: derived ETH " + st.eth + " ≠ AX_TEST_NODE_EXPECT_ETH " + EXPECT_ETH); fail = true; }
  if (!EXPECT_ETH) console.log("(AX_TEST_NODE_EXPECT_ETH not set: the derived address " + st.eth + " was not compared with another build's)");
  if (!fail) {
    // fire one NEWBLOCK so a full engine poll (settle+maker+otc+market collector) runs once against the node
    atomix._fire("NEWBLOCK");
    await new Promise(r => setTimeout(r, 20000));
    console.log("post-poll log tail:", atomix.status().log.slice(-5).join(" | "));
    console.log("✅ S1 BOOT GATE PASS — desktop engine live on the named node");
  }
  atomix.stopLoop(); atomix.flush();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("GATE ERROR:", e); process.exit(1); });
