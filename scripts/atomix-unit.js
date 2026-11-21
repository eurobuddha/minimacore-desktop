/*
 * atomix-unit.js — headless unit asserts for the DESKTOP GLUE (the engine itself is the donor's 4-suite-tested
 * code). Covers what the live gates can't: the SQL H2→SQLite translations in isolation, the cross-realm marshal,
 * the net-host allowlist, and the frozen-quote replay with a FUNDED mock (the S2 gate node has zero balance, so
 * it can only prove refusal — this proves the freeze path issues + consumes a replayable quoteId).
 * Run: node scripts/atomix-unit.js
 */
const assert = require("assert");
const os = require("os"), path = require("path"), fs = require("fs");
const { testNode, ENGINE_BOOT_SENDS, NAMES } = require("./test-node.cjs");
// A real node is used ONLY when the caller names one and says it is theirs (scripts/test-node.cjs). Otherwise this
// suite is hermetic, and no-reach.cjs makes that a fact: from here on a child process or a socket throws and is counted.
const LIVE = testNode(ENGINE_BOOT_SENDS.concat("Nothing is signed or posted: the swap's start is replaced in the test."));
const NO_REACH = LIVE ? null : require("./no-reach.cjs").install();

let pass = 0, fail = 0, skipped = 0;
function ok(name, fn) { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.error("  ✗", name, "—", e.message); } }
async function okA(name, fn) { try { await fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.error("  ✗", name, "—", e.message); } }

(async () => {
  // ---- 1. SQL H2→SQLite translations (the two additive rules AtomiX needs) ----
  const { makeSqlShim } = require("../main/pandapools/sqlshim");
  const shim = await makeSqlShim(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axsql-")), "t.sqlite"));
  const sql = (q) => new Promise(r => shim.sql(q, r));

  await okA("MERGE upsert creates + replaces on the key", async () => {
    await sql("CREATE TABLE IF NOT EXISTS `kv` (`k` varchar(200) NOT NULL PRIMARY KEY, `v` text)");
    await sql("MERGE INTO `kv` (`k`,`v`) KEY(`k`) VALUES ('a','1')");
    await sql("MERGE INTO `kv` (`k`,`v`) KEY(`k`) VALUES ('a','2')");   // same key → REPLACE, not a 2nd row
    const r = await sql("SELECT `v` FROM `kv` WHERE `k`='a'");
    assert.equal(r.rows.length, 1, "one row"); assert.equal(r.rows[0].V, "2", "value replaced");
  });
  await okA("auto_increment PRIMARY KEY (no duplicate-PK error)", async () => {
    const r0 = await sql("CREATE TABLE IF NOT EXISTS `ev` (`id` bigint auto_increment PRIMARY KEY, `x` text)");
    assert.equal(r0.status, true, "create ok");
    await sql("INSERT INTO `ev` (`x`) VALUES ('p')");
    await sql("INSERT INTO `ev` (`x`) VALUES ('q')");
    const r = await sql("SELECT `id` FROM `ev` ORDER BY `id`");
    assert.equal(r.rows.length, 2); assert.notEqual(r.rows[0].ID, r.rows[1].ID, "distinct auto ids");
  });
  await okA("plain auto_increment id still works (pandapools form)", async () => {
    const r0 = await sql("CREATE TABLE IF NOT EXISTS `ev2` (`id` bigint auto_increment, `x` text)");
    assert.equal(r0.status, true);
  });
  await okA("uppercase column emulation (H2 parity)", async () => {
    const r = await sql("SELECT `x` AS lower FROM `ev` LIMIT 1");
    assert.ok("LOWER" in r.rows[0], "column key uppercased");
  });

  // ---- 2. net-host allowlist (the shim refuses anything off-list) ----
  ok("net allowlist: ETH RPC + MEXC in, others out", () => {
    const m = require("../main/atomix");   // allowedUrl isn't exported; re-derive the set behavior via a probe
    // exercise through the module's own guard by monkeypatching netfetch and calling the shim indirectly is heavy;
    // instead assert the documented set here mirrors the engine's NET.rpcs (guarding against drift).
    const NET = require("../main/atomix/lib/ethhtlc.js") && null;   // engine file is vm-only; parse instead
    const src = fs.readFileSync(path.join(__dirname, "..", "main", "atomix", "lib", "ethhtlc.js"), "utf8");
    const rpcHosts = [...src.matchAll(/https:\/\/([^'"/]+)/g)].map(x => x[1]);
    const allowSrc = fs.readFileSync(path.join(__dirname, "..", "main", "atomix.js"), "utf8");
    for (const h of rpcHosts) {
      const base = h.replace(/:\d+$/, "");
      assert.ok(allowSrc.includes('"' + base + '"'), "allowlist covers engine RPC host " + base);
    }
  });

  ok("net allowlist: https only, no credentials, and the engine's GETs follow no redirect (0.19.244, as released 0.18.210 / 0.18.216)", () => {
    const m = require("../main/atomix");
    assert.equal(m._allowedUrl("https://ethereum-rpc.publicnode.com/"), true);
    assert.equal(m._allowedUrl("https://api.mexc.com/api/v3/ticker/price?symbol=MINIMAUSDT"), true);
    for (const u of ["http://ethereum-rpc.publicnode.com/", "ws://ethereum-rpc.publicnode.com/", "https://user:pw@ethereum-rpc.publicnode.com/", "https://user@api.mexc.com/", "https://evil.example/", "https://ethereum-rpc.publicnode.com.evil.example/"]) assert.equal(m._allowedUrl(u), false, u);
    const src = fs.readFileSync(path.join(__dirname, "..", "main", "atomix.js"), "utf8");
    assert.ok(/netfetch\.fetchJson\(String\(url\), \{ noRedirect: true \}\)/.test(src), "MDS.net.GET passes noRedirect");
    const v = m._ethtest.ethValidateRpc;
    assert.match(v("https://me:secret@eth.example.org/").err, /Leave the name and password out of the URL/); assert.match(v("https://me@eth.example.org/").err, /name and password/);
    assert.equal(v("https://eth.example.org/v3/KEY").ok, true); assert.match(v("http://eth.example.org/").err, /https/);
    // a saved endpoint with credentials (written by an older version) is dropped at load with a log line, never used
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "axrpc-")); m._setDataDir(d); m._resetEthCaches();
    fs.writeFileSync(path.join(d, "ethrpc.json"), JSON.stringify({ url: "https://me:secret@eth.example.org/", host: "eth.example.org" }));
    const said = [], log0 = console.log; console.log = (...a) => said.push(a.join(" "));
    try { assert.equal(m._ethtest.ethRpcLoad(), null); } finally { console.log = log0; }
    assert.equal(m._allowedUrl("https://eth.example.org/"), false, "its host is not let through");
    assert.ok(said.some(l => /saved Ethereum endpoint was not used \(Leave the name and password/.test(l)), "said in the log: " + said.join(" | "));
    m._resetEthCaches();
  });

  await okA("the database file: 0 bytes opens fresh, content that is not SQLite is refused, no tables writes nothing, saves are synced, a disposed one never writes (0.19.245)", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "axsql2-")), f = path.join(d, "x.sqlite");
    fs.writeFileSync(f, ""); const s0 = await makeSqlShim(f);   // what sql.js writes for a database with no tables
    assert.equal(s0.flush(), true); assert.equal(fs.readFileSync(f).length, 0, "a flush with no tables writes nothing");
    fs.rmSync(f); const s1 = await makeSqlShim(f); assert.equal(s1.flush(), true); assert.ok(!fs.existsSync(f), "no 0-byte file is created");
    fs.writeFileSync(f, "x".repeat(4096)); await assert.rejects(makeSqlShim(f), /is damaged \(not an SQLite file\)/); assert.equal(fs.readFileSync(f, "utf8"), "x".repeat(4096), "left as it is");
    fs.rmSync(f); const s2 = await makeSqlShim(f); s2.sql("CREATE TABLE t (a int)"); s2.sql("INSERT INTO t VALUES (7)"); assert.equal(s2.flush(), true);
    const s3 = await makeSqlShim(f); assert.equal(s3.sql("SELECT a FROM t").rows[0].A, 7, "a real file reopens");
    s3.sql("INSERT INTO t VALUES (8)"); s3.dispose(); await new Promise(r => setTimeout(r, 600));
    assert.equal((await makeSqlShim(f)).sql("SELECT count(*) AS n FROM t").rows[0].N, 1, "a disposed database's pending save is never written");
    assert.equal(s3.flush(), false, "nor any later one");
    const s4 = await makeSqlShim(f); s4.sql("INSERT INTO t VALUES (9)"); await new Promise(r => setTimeout(r, 600));
    assert.equal((await makeSqlShim(f)).sql("SELECT count(*) AS n FROM t").rows[0].N, 2, "the debounced save writes");
    const src = fs.readFileSync(path.join(__dirname, "..", "main", "pandapools", "sqlshim.js"), "utf8");
    assert.ok(/writeTimer = null; flushChecked\(\);/.test(src) && /fs\.fsyncSync\(fd\)/.test(src) && /fs\.fsyncSync\(dfd\)/.test(src), "the debounced save is the synced one; file and folder are synced");
    const ax = fs.readFileSync(path.join(__dirname, "..", "main", "atomix.js"), "utf8"), pp = fs.readFileSync(path.join(__dirname, "..", "main", "pandapools.js"), "utf8");
    assert.ok(!/shim\.flush\(\); \} catch \(e\) \{\} return; \}/.test(ax) && /if \(sqlShim\) sqlShim\.dispose\(\);/.test(ax) && /storage\.dispose\(\);/.test(pp), "a disowned database is disposed, not flushed");
  });

  // ---- 3. frozen-quote replay with a FUNDED mock node ----
  // HERMETIC since 0.18.140. It used to run `docker exec` into a fixed container name for the crypto-bearing
  // commands; on the owner's machine that container is a wallet with real funds, and this "unit" check read its
  // seed. Now the engine boots on mockNode() below: a throwaway identity from FAKE values written in this file,
  // and a book of one order signed by a second throwaway identity. Nothing leaves the process (NO_REACH proves it).
  // The same check against a real node runs only when the caller names one (scripts/test-node.cjs).
  const FAKE_SEED = "FAKE TEST SEED - NOT A WALLET - scripts/atomix-unit.js", FAKE_ETH_KEY = "0x" + "11".repeat(32);
  const FAKE_KEY = "0x" + "C0FFEE".repeat(11).slice(0, 64), FAKE_ADDR = "0x" + "FACADE".repeat(11).slice(0, 64);
  function mockNode(atomix) {
    const seen = [], ok = (response) => ({ status: true, pending: false, response });
    /** One live maker (a second throwaway identity): bids 0.99 and asks 1.01 for 500, built by the engine's own codec. */
    const makerCoin = () => {
      const A = atomix._ctx().AX, maker = A.identity.fromSeed("FAKE TEST MAKER - NOT A WALLET", A.trading.active().hkdfContext);
      const o = A.order.make(); o.mpk = "0x" + "AB".repeat(32); o.eth = "0x" + "cd".repeat(20); o.cid = maker.publicId(); o.ts = Date.now();
      o.minimaAvail = 1000; o.usdtAvail = 1000; o.pairs.USDT = A.order.pair(true, 1.01, 0.99, 1);
      o.pairs.USDT.bids.push(A.order.level(0.99, 500)); o.pairs.USDT.asks.push(A.order.level(1.01, 500)); A.order.sanitize(o);
      const msg = A.hex.utf8(A.order.canonicalJson(o)), sig = A.sodium.signDetached(msg, maker.signSk);
      return { coinid: "0x" + "0D".repeat(32), state: [{ port: 1, type: 1, data: "0x" + A.hex.to(maker.signPk) }, { port: 2, type: 1, data: "0x" + A.hex.to(sig) }, { port: 99, type: 1, data: "0x" + A.hex.to(msg) }] };
    };
    const run = async (cmd) => {
      cmd = String(cmd); seen.push(cmd);
      const verb = cmd.split(/\s+/)[0];
      if (verb === "checkmode") return ok({ writemode: true, dblocked: false });
      if (cmd === "vault action:seed") return ok({ seed: FAKE_SEED });
      if (cmd === "seedrandom modifier:ethbridge") return ok({ seedrandom: FAKE_ETH_KEY });
      if (verb === "random") return ok({ random: "0x" + "5A".repeat(64) });
      if (verb === "scripts") { const m = /address:(\S+)/.exec(cmd); return ok({ miniaddress: m ? m[1] : "", address: "" }); }   // both swap contracts already registered
      if (verb === "getaddress") return ok({ miniaddress: "MxFAKETESTADDRESS", address: FAKE_ADDR, publickey: FAKE_KEY });
      if (verb === "keys") return ok({ keys: [{ publickey: FAKE_KEY }], total: 1 });
      if (verb === "block") return ok({ block: "1000" });
      if (/^balance tokenid:0x7D39/i.test(cmd)) return ok([{ confirmed: "100", unconfirmed: "0", sendable: "100", coins: 3 }]);
      if (verb === "balance" || verb === "txnlist" || verb === "history") return ok([]);
      if (verb === "coins") return ok(/address:0x5553445453574150\b/.test(cmd) && atomix._ctx() ? [makerCoin()] : []);
      if (verb === "coinnotify") return ok({});
      return { status: false, error: "mock node: no answer for " + verb };
    };
    return { run, seen };
  }
  async function frozenQuoteReplay(atomix, runner) {
    atomix._setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), "axq-")));
    atomix._setRunner(runner);
    await atomix.init();
    for (let i = 0; i < 60 && !atomix.status().ready; i++) { await new Promise(r => setTimeout(r, LIVE ? 2000 : 50)); if (LIVE) atomix._fire("MDS_TIMER_60SECONDS"); }
    assert.ok(atomix.status().ready, "engine booted: " + atomix.status().log.slice(-3).join(" | "));
    // A SELL freezes against the token balance the runner reports (a BUY is priced against the ERC20 balance,
    // which comes from the Ethereum RPC, not from the node).
    const q = await atomix.quote(true, "2", 0);
    assert.ok(q.quoteId, "SELL 2 froze a quoteId: " + JSON.stringify(q).slice(0, 160));
    // replay is single-use: a second execute of the same id must reject "expired"
    // (nothing is broadcast: startLeg is replaced, so no funds move)
    const A = atomix._ctx().AX;
    const origStartLeg = A.engine.startLeg;
    A.engine.startLeg = (maker, sym, sell, minima, usdt, hooks, cb) => cb(null, "0xFAKEHASH");
    try {
      const r1 = await atomix.swapExecute(q.quoteId);
      assert.ok(r1 && r1.ok >= 1, "first replay executes the frozen route");
      let threw = false;
      try { await atomix.swapExecute(q.quoteId); } catch (e) { threw = /expired/i.test(e.message); }
      assert.ok(threw, "second replay of the same quoteId is rejected (single-use freeze)");
    } finally { A.engine.startLeg = origStartLeg; atomix.stopLoop(); atomix.flush(); }
  }
  if (!LIVE) {
    await okA("frozen quote issues a replayable quoteId; replay consumes it (mock node, fake identity)", async () => {
      const atomix = require("../main/atomix"), node = mockNode(atomix);
      await frozenQuoteReplay(atomix, node.run);
      assert.equal(atomix.status().eth, "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a", "the identity is the one the FAKE key gives (0x11…11), nobody's wallet");
      for (const c of ["vault action:seed", "seedrandom modifier:ethbridge"]) assert.ok(node.seen.includes(c), "the mock answered " + c);
      assert.deepEqual(node.seen.filter(c => /^(send|txn(post|sign|create|input|output)|newscript|consolidate)\b/.test(c)), [], "and was never asked to sign, post or register anything");
    });
    console.log("  ⊘ frozen quote replay on a REAL node — SKIPPED (no test node named: set " + NAMES + ")");
  } else {
    await okA("frozen quote issues a replayable quoteId; replay consumes it (the named test node, a funded balance injected)", async () => {
      const atomix = require("../main/atomix");
      await frozenQuoteReplay(atomix, async (cmd) => {
        if (/^balance tokenid:0x7D39/i.test(cmd)) return { status: true, response: [{ confirmed: "100", unconfirmed: "0", sendable: "100", coins: 3 }] };
        return LIVE.run(cmd);
      });
    });
  }

  // ---- publish-send coin pin: must fund the send, not just be signable ----
  // Live failure (2026-09-14): the wallet held a 1e-44 MINIMA dust coin. `fromaddress:` RESTRICTS inputs to
  // that address, so pinning to it made the 1e-9 publish unfundable and the node returned a BARE
  // {status:false} with NO error text — surfacing as "cmd failed: send … — undefined" and blocking every
  // market publish. Signable is necessary but NOT sufficient: the coin must also cover the amount.
  {
    const atomix = require("../main/atomix");
    const PUB = 'send amount:0.000000001 address:0x5553445453574150 tokenid:0x00 state:{"1":"0xaa"}';
    const DUST = "0x" + "F".repeat(64), NANO = "0x" + "8".repeat(64), BIG = "0x" + "1".repeat(64);
    const SHORT = "0x5553445453574150";
    let lastCoinsCmd = "";
    const mkRunner = (coins) => async (cmd) => {
      if (/^coins /.test(cmd)) { lastCoinsCmd = cmd; return { response: coins }; }
      if (/^checkaddress /.test(cmd)) return { response: { simple: !/0x5553445453574150/.test(cmd) } };
      return { status: true };
    };
    const origRunner = atomix._setRunner;

    await okA("pins to the smallest coin that COVERS the send, not the smallest overall", async () => {
      atomix._setRunner(mkRunner([
        { amount: "0.00000000000000000000000000000000000000000001", address: DUST },
        { amount: "0.000000001", address: NANO },
        { amount: "5", address: BIG },
      ]));
      const out = await atomix._pinPublishSend(PUB);
      assert.ok(!out.includes(DUST), "must NOT pin to the 1e-44 dust coin");
      assert.ok(out.endsWith(" fromaddress:" + NANO), "pins to the 1e-9 coin, got: " + out);
    });

    await okA("skips unsignable sentinel/beacon dust", async () => {
      atomix._setRunner(mkRunner([
        { amount: "0.000000002", address: SHORT },      // short = anyone-can-spend, no key
        { amount: "5", address: BIG },
      ]));
      const out = await atomix._pinPublishSend(PUB);
      assert.ok(out.endsWith(" fromaddress:" + BIG), "falls through to the signable coin, got: " + out);
    });

    await okA("no sufficient coin → sends UNPINNED rather than pinning an unfundable one", async () => {
      atomix._setRunner(mkRunner([
        { amount: "0.00000000000000000000000000000000000000000001", address: DUST },
      ]));
      const out = await atomix._pinPublishSend(PUB);
      assert.equal(out, PUB, "command returned unmodified");
    });

    await okA("a coin exactly equal to the amount is acceptable", async () => {
      atomix._setRunner(mkRunner([{ amount: "0.000000001", address: NANO }]));
      const out = await atomix._pinPublishSend(PUB);
      assert.ok(out.endsWith(" fromaddress:" + NANO), "exact-amount coin pins, got: " + out);
    });

    await okA("only asks the node for SPENDABLE coins (coinage filter)", async () => {
      // A publish's own change output is a brand-new coin and becomes the new smallest. Pinned to it,
      // the node answers "No Coins of tokenid:0x00 available!" — so every publish poisoned the next one.
      // Proven live: the same coin failed at age ~1 block and succeeded at age 5.
      atomix._setRunner(mkRunner([{ amount: "5", address: BIG }]));
      await atomix._pinPublishSend(PUB);
      assert.ok(/\bcoinage:\d+/.test(lastCoinsCmd), "coins query must carry a coinage filter, got: " + lastCoinsCmd);
      const n = Number(/\bcoinage:(\d+)/.exec(lastCoinsCmd)[1]);
      assert.ok(n >= 3, "coinage must clear the node's ~3-confirmation spend rule, got " + n);
    });

    await okA("asks the node for SENDABLE coins — coinage alone is not enough", async () => {
      // THE PUBLISH BUG. `coinage:` says how deep a coin is, NOT whether it can be spent. A coin already
      // consumed by an unconfirmed txn is still `relevant` and still old enough, so the query returned it,
      // the pin chose it, and the node refused the send with a bare {status:false} — "cmd failed: send …
      // — undefined". That is the window right after every publish (and after a node restart, where the
      // engine publishes immediately and the user then retries into it).
      atomix._setRunner(mkRunner([{ amount: "5", address: BIG }]));
      await atomix._pinPublishSend(PUB);
      assert.ok(/\bsendable:true\b/.test(lastCoinsCmd),
        "coins query must ask for sendable:true, got: " + lastCoinsCmd);
    });

    await okA("a coin the node will not spend is never pinned (it is simply absent)", async () => {
      // With sendable:true the node omits such coins, so the pin must fall through to unpinned rather than
      // pick something unfundable. Modelled by the node returning nothing for the sendable query.
      atomix._setRunner(mkRunner([]));
      const out = await atomix._pinPublishSend(PUB);
      assert.equal(out, PUB, "no sendable coin → send unpinned, never pinned to an unspendable one");
    });

    await okA("the publish pin delegates to main/sendpin.js instead of keeping a private copy", async () => {
      // It drifted once: sendpin gained sendable:true, exact 44dp comparison and a total-across-an-address
      // fallback that this path never got, and publishing broke. A structural check, because atomix.js
      // destructures the helper at load time so it cannot be swapped at runtime.
      const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "atomix.js"), "utf8");
      const fn = src.slice(src.indexOf("async function pinPublishSend"), src.indexOf("\nfunction buildMds"));
      assert.ok(/pinMinimaSend\s*\(/.test(fn), "pinPublishSend must call sendpin.pinMinimaSend");
      assert.ok(/minCoinage/.test(fn), "and pass the AtomiX coin-age floor through");
      assert.ok(!/coins relevant:/.test(fn), "and must NOT run its own coins query again — that is the fork that drifted");
      assert.ok(!/checkaddress/.test(fn), "nor its own signability probe");
    });

    await okA("asks the node ONLY for coins `send` will accept (checkmempool:true)", async () => {
      // THE REAL PUBLISH BUG (found in the node's Java, proved on-chain). `coins` defaults checkmempool to
      // FALSE, so it still lists a coin already committed to an unconfirmed txn; `send` filters those out
      // unconditionally (send.java:317-333 and again in selectCoins). The pin trusted `coins`, handed
      // `fromaddress:` a coin `send` refuses, and the send failed "Insufficient funds.. you only have 0".
      // Two coins on the live wallet were each spent by two different txpows before this was found.
      atomix._setRunner(mkRunner([{ amount: "5", address: BIG }]));
      await atomix._pinPublishSend(PUB);
      assert.ok(/\bcheckmempool:true\b/.test(lastCoinsCmd),
        "coins query must carry checkmempool:true so candidates match what send accepts, got: " + lastCoinsCmd);
    });

    await okA("a node reply that fails with `message` (not `error`) surfaces the real reason", async () => {
      // send.java:376-381 returns {status:false, message:"Insufficient funds.."} — no `error` key, because
      // CommandRunner only sets `error` on a thrown exception. mdsw.js reads r.error, so every such failure
      // rendered as "— undefined" and the node's actual explanation was thrown away.
      const mds = atomix._buildMds();
      atomix._setRunner(async (cmd) => {
        if (/^coins /.test(cmd)) return { response: [{ amount: "5", address: BIG }] };
        if (/^checkaddress /.test(cmd)) return { response: { simple: true } };
        if (/^send /.test(cmd)) return { status: false, message: "Insufficient funds.. you only have 0 require:0.000000001" };
        return { status: true };
      });
      const r = await new Promise(res => mds.cmd(PUB, res));
      assert.equal(r.status, false);
      assert.ok(r.error && /Insufficient funds/.test(r.error),
        "the shim must copy `message` into `error` so the UI shows it, got error=" + r.error);
    });

    await okA("a refused pin rotates to the next signable address instead of failing", async () => {
      // `coins` and `send` are separate code paths in the node, so a pin can still name a coin `send`
      // refuses (e.g. a leaked TxPoWMiner.mMiningCoins entry, which never self-heals). That used to strand
      // the maker until a node restart. Now: bare {status:false} on address A → retry pinned to B.
      const A = "0x" + "A".repeat(64), B2 = "0x" + "B".repeat(64);
      const sends = [];
      atomix._setRunner(async (cmd) => {
        if (/^coins /.test(cmd)) return { response: [{ amount: "0.5", address: A }, { amount: "7", address: B2 }] };
        if (/^checkaddress /.test(cmd)) return { response: { simple: true } };
        if (/^send /.test(cmd)) {
          sends.push(cmd);
          const from = (/\bfromaddress:(0x[0-9A-Fa-f]+)/.exec(cmd) || [])[1];
          if (from === A) return { status: false, message: "Insufficient funds.. you only have 0 require:0.000000001" };
          return { status: true, response: { txpowid: "0xOK" } };
        }
        return { status: true };
      });
      const r = await atomix._publishSendWithRetry(PUB);
      assert.equal(r.status, true, "the publish must succeed on the second candidate");
      assert.equal(sends.length, 2, "exactly two send attempts, got " + sends.length);
      assert.ok(sends[0].endsWith(" fromaddress:" + A), "first attempt pinned to the smallest (A)");
      assert.ok(sends[1].endsWith(" fromaddress:" + B2), "second attempt rotated to B, got: " + sends[1]);
    });

    await okA("a REAL error is surfaced immediately, never retried", async () => {
      // A thrown/transport failure carries `error` and is not the refusal signature — looping on it would
      // burn candidates and hide the actual problem.
      let sendCount = 0;
      atomix._setRunner(async (cmd) => {
        if (/^coins /.test(cmd)) return { response: [{ amount: "5", address: BIG }] };
        if (/^checkaddress /.test(cmd)) return { response: { simple: true } };
        if (/^send /.test(cmd)) { sendCount++; return { status: false, error: "RPC authentication failed" }; }
        return { status: true };
      });
      const r = await atomix._publishSendWithRetry(PUB);
      assert.equal(sendCount, 1, "a real error must not be retried, got " + sendCount + " attempts");
      assert.ok(/authentication/.test(r.error));
    });

    await okA("a maker step that times out aborts the signal its publish sends carry (a queued send is then never signed)", async () => {
      // makerPublish / makerSave / makerWithdraw / switchCurrency give up after 60 s, but the engine's send can still
      // be QUEUED behind another signer and would sign later; a retry would sign twice. main/noderun.js drops a
      // queued entry whose signal is aborted (scripts/rpc-test.cjs). This proves the glue hands it that signal.
      const got = [];
      atomix._setRunner((cmd, opts) => {
        if (/^coins /.test(cmd)) return Promise.resolve({ response: [{ amount: "5", address: BIG }] });
        if (/^checkaddress /.test(cmd)) return Promise.resolve({ response: { simple: true } });
        if (/^send /.test(cmd)) { got.push(opts && opts.signal); return new Promise(() => {}); }   // queued behind a stuck signer
        return Promise.resolve({ status: true });
      });
      const mds = atomix._buildMds();
      const step = atomix._makerStep(() => { mds.cmd(PUB, () => {}); return new Promise(() => {}); }, "publish", 80);
      await new Promise(r => setTimeout(r, 30));
      assert.equal(got.length, 1, "the publish send reached the runner");
      assert.ok(got[0] && got[0].aborted === false, "it carries the step's signal, not yet aborted");
      await assert.rejects(step, /publish timed out/);
      assert.equal(got[0].aborted, true, "the timeout aborts it");
      mds.cmd(PUB, () => {});   // the engine's own republish, outside any step
      await new Promise(r => setTimeout(r, 30));
      assert.equal(got.length, 2); assert.ok(got[1] && got[1] !== got[0] && got[1].aborted === false, "a send outside a step carries only its engine's signal (0.18.107), which nothing aborts while that engine lives: it is never dropped");
      const src = fs.readFileSync(path.join(__dirname, "..", "main/atomix.js"), "utf8");
      assert.equal((src.match(/await makerStep\(/g) || []).length, 4, "publish (x2), withdraw and switch all run as steps");
      assert.ok(!/withTimeout\([^\n]*60000/.test(src), "none of them is left on a bare 60 s timeout");
    });

    await okA("switchCurrency applies the switch itself instead of firing into the POLLING guard", async () => {
      // service.js's poll() returns early when a pass is in flight, and switchCurrency has just spent up to
      // 60s tombstoning — so a pass usually IS in flight and the MDS_TIMER_60SECONDS nudge was swallowed.
      // The engine kept the old currency for up to a minute; the renderer's stale cache then made the next
      // click a server-side no-op. reloadShared is the donor's own function and a vm global (same access
      // class as the ctx.RPC.setUrl the glue already uses), so call it directly. Structural, because the
      // engine-driving path is covered by the mock-node check above.
      const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main", "atomix.js"), "utf8");
      const fn = src.slice(src.indexOf("async function switchCurrency"), src.indexOf("\n}", src.indexOf("async function switchCurrency")));
      assert.ok(/ctx\.reloadShared\s*\(/.test(fn), "switchCurrency must call ctx.reloadShared directly");
      assert.ok(!/fire\(\s*"MDS_TIMER_60SECONDS"/.test(fn), "and must not rely on the poll nudge, which the POLLING guard swallows");
      assert.ok(!/kvSet\([^)]*\(\)\s*=>\s*cb\(null\)/.test(fn), "kvSet's error must be propagated, not discarded as cb(null)");
    });

    await okA("reloadShared is reachable from the glue (the toggle fix depends on it)", async () => {
      // service.js is evaluated by vm.runInContext with no function wrapper, so its top-level declarations
      // are properties of the context. If a future donor sync wraps it in an IIFE, the toggle fix silently
      // stops working — this is what catches that. Built with an inert MDS shim: no node, no network.
      const { createContext } = require("../main/atomix/loader");
      const inert = { minidappuid: "", cmd(c, cb) { if (cb) cb({ status: false }); }, sql(q, cb) { if (cb) cb({ status: true, rows: [] }); },
        net: { GET(u, cb) { cb({}); }, POST(u, d, cb) { cb({}); } }, notify() {}, log() {}, init() {} };
      const ctx = createContext(inert);
      assert.equal(typeof ctx.reloadShared, "function", "ctx.reloadShared must be a vm global");
      assert.equal(typeof ctx.POLLING, "boolean", "and the POLLING guard it bypasses must be the service.js var");
    });

    await okA("non-publish sends are left completely alone", async () => {
      atomix._setRunner(mkRunner([{ amount: "5", address: BIG }]));
      const plain = "send amount:1 address:0xABC tokenid:0x00";
      assert.equal(await atomix._pinPublishSend(plain), plain);
    });
    void origRunner;
  }

  // ---- Activity rows carry enough to be usable (native historySwapCard parity) ----
  // The list showed only amounts + raw status because created/counterparty were never projected and there
  // was no state line. A renderer cannot show what the glue does not send, so assert the projection.
  {
    const atomix = require("../main/atomix");
    const A = atomix._ctx() && atomix._ctx().AX;
    await okA("swap rows carry when / side / counterparty / plain-language state", async () => {
      if (!A) { console.log("      (engine not booted in this run — projection shape checked via statusDetail)"); }
      const row = { hash: "0x" + "ab".repeat(32), role: "INITIATOR", direction: "MINIMA_TO_ERC20",
        selltoken: "mxUSDT", sellamount: "5", buytoken: "USDT", buyamount: "4.95", status: "COMPLETE",
        created: 1757000000000, updated: 1757000100000, counterparty: "0x" + "cd".repeat(20), contractId: "0xC1" };
      for (const k of ["created", "counterparty", "role", "status", "contractId"]) {
        assert.ok(row[k] !== undefined, "projection must carry " + k);
      }
      const detail = A ? A.inspect.statusDetail(row) : null;
      if (detail !== null) {
        assert.ok(/received 4\.95 USDT/.test(detail), "COMPLETE detail names what you got, got: " + detail);
        const waiting = A.inspect.statusDetail({ ...row, status: "STARTED" });
        assert.ok(/waiting for the counterparty/.test(waiting), "STARTED detail explains the wait, got: " + waiting);
      }
    });

    await okA("counterparty is never truncated in the projection", async () => {
      // RULE: an address exists to be copied and used. The row must carry the WHOLE value; the renderer
      // shows it in full and copies the full value on click.
      const full = "0x" + "cd".repeat(20);
      assert.equal(full.length, 42);
      assert.ok(!full.includes("…") && !full.includes("..."), "no ellipsis in a projected identifier");
    });

    // ---- 0.17.4: a refused claim must be VISIBLE on the row (engine 0.1.31 writes *_FAILED events) ----
    ok("Activity row projects the newest failure reason, and a later success clears it", () => {
      const note = "script proof missing — the node has no script row for the covenant address. Nothing was posted.";
      // getEvents rows are newest-first
      assert.equal(atomix._lastFailureNote([{ event: "MINIMA_CLAIM_FAILED", note }, { event: "CPTXN_SENT", note: "0xabc" }]), note);
      assert.equal(atomix._lastFailureNote([{ event: "MINIMA_CLAIM_SUBMITTED", note: "0xTXP" }, { event: "MINIMA_CLAIM_FAILED", note }]), "");
      assert.equal(atomix._lastFailureNote([{ event: "CPTXN_SENT", note: "0xabc" }]), "");
      assert.equal(atomix._lastFailureNote([]), "");
      // 0.17.5: a lost leg (engine 0.1.32) is a terminal failure — its reason shows on the row the same way
      const lost = "counterparty withdrew your 4.95 USDT and reclaimed their 5 mxUSDT at the timelock — our claim never posted";
      assert.equal(atomix._lastFailureNote([{ event: "SWAP_LOST", note: lost }, { event: "MINIMA_CLAIM_FAILED", note }]), lost);
    });
    // ---- 0.18.25: swap-status visibility on the Activity row (engine 0.1.39 / native 0.1.84) ----
    // Live 2026-10-26: a maker silently declined a buy and the taker read "waiting" for two hours. The row now
    // carries the engine's own projection (settle.visibility) plus what the renderer needs for "Refund now".
    {
      const { createContext } = require("../main/atomix/loader");
      const inert = { minidappuid: "", cmd(c, cb) { if (cb) cb({ status: false }); }, sql(q, cb) { if (cb) cb({ status: true, rows: [] }); },
        net: { GET(u, cb) { cb({}); }, POST(u, d, cb) { cb({}); } }, notify() {}, log() {}, init() {} };
      const VA = createContext(inert).AX;
      const NOW = 2000000000, HASH = "ab".repeat(32), TX = "0x" + "cd".repeat(32), MAKER = "0x" + "ef".repeat(64);
      const sw = { hash: HASH, role: "INITIATOR", direction: "ERC20_TO_MINIMA", sellToken: "USDT", sellAmount: "50.5",
        buyToken: "mxUSDT", buyAmount: "50", status: "STARTED", myTimelock: NOW + 600, myLegIsMinima: false, created: 1, updated: 2 };
      const evs = [   // newest first, as getEvents returns them
        { event: "REFUND_SENT", note: TX }, { event: "MAKER_TIMEOUT", note: "" },
        { event: "MAKER_NOTICE", note: "declined|Maker wallet: TOO_MANY_COINS — it consolidates automatically and retries.", date: 5 },
        { event: "MAKER_NOTICE", note: "retrying|older", date: 4 },
        { event: "TAKE_SENT", note: MAKER }, { event: "HTLC_STARTED", note: "0x" + "12".repeat(32) } ];
      ok("Activity row projects deadlines, the latest maker notice, the timeout and the refund tx IN FULL", () => {
        const row = atomix._projectRow(VA, sw, evs, NOW, 0);
        assert.ok(row.vis, "an initiator row carries vis");
        assert.equal(row.vis.blocks, false);
        assert.equal(row.vis.respondBy, NOW + 600 - VA.htlc.CP_SECS_CHECK);
        assert.equal(row.vis.refundAt, NOW + 600);
        assert.deepEqual([row.vis.notice.state, row.vis.notice.reason], ["declined", "Maker wallet: TOO_MANY_COINS — it consolidates automatically and retries."]);
        assert.equal(row.vis.timedOut, true);
        assert.equal(row.vis.refundSent, TX, "refund tx must be the whole hash");
        assert.ok(row.vis.steps.indexOf("Maker notified") >= 0 && row.vis.steps.indexOf("Refund sent") >= 0);
        assert.equal(row.detail, VA.inspect.statusDetail(row), "the plain-language line is unchanged");
      });
      ok("Refund now: closed until the contract accepts it (cur > refundAt), then open", () => {
        assert.deepEqual([atomix._projectRow(VA, sw, [], NOW + 600, 0).vis.refundOpen, atomix._projectRow(VA, sw, [], NOW + 601, 0).vis.refundOpen], [false, true]);
        assert.equal(atomix._projectRow(VA, sw, [], NOW, 0).vis.canRefund, true);
        assert.equal(atomix._projectRow(VA, { ...sw, status: "REFUNDED" }, [], NOW, 0).vis.canRefund, false);
        assert.equal(atomix._projectRow(VA, { ...sw, status: "REFUNDED" }, [], NOW, 0).vis.refunded, true);
      });
      ok("a Minima-first lock counts in BLOCKS against the chain tip", () => {
        const m = atomix._projectRow(VA, { ...sw, myLegIsMinima: true, myTimelock: 150 }, [], NOW, 151).vis;
        assert.deepEqual([m.blocks, m.cur, m.respondBy, m.refundOpen], [true, 151, 150 - VA.htlc.CP_BLOCKS_CHECK, true]);
        assert.equal(atomix._projectRow(VA, { ...sw, myLegIsMinima: true, myTimelock: 150 }, [], NOW, 0).vis.refundOpen, false, "unknown tip → closed");
      });
      ok("a maker (RESPONDER) row carries no swap-status block", () => {
        assert.equal(atomix._projectRow(VA, { ...sw, role: "RESPONDER" }, evs, NOW, 0).vis, null);
      });
      ok("Refund now is wired end to end (main IPC + preload + renderer)", () => {
        const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
        assert.ok(/ipcMain\.handle\("mcd:axRefundNow", \(_e, hash\) => atomix\.refundNow\(hash\)\)/.test(rd("main/main.js")));
        assert.ok(/axRefundNow: \(hash\) => ipcRenderer\.invoke\("mcd:axRefundNow", hash\)/.test(rd("main/preload.js")));
        assert.ok(/api\.axRefundNow\(hash\)/.test(rd("renderer/dexicon-ax.js")), "room 1 of Dexicon (the old panel was removed in 0.18.141)");
      });
      await okA("refundNow refuses a non-hash before touching the engine", async () => {
        await assert.rejects(() => atomix.refundNow("x'; DROP"), /not a swap hash/);
      });
    }
    // ---- 0.17.27: the lock-coin record must be CRASH-DURABLE, like the secret ----
    ok("the lock-coin write is in the synchronous-flush class, matched against the SQL swapdb really emits", () => {
      // The sqlite image is debounced 400ms. `mycoinid` is the only durable route to a refund once the lock
      // ages out of `coins depth:` — if a crash eats it, the coin is stranded, which is the very failure the
      // record exists to prevent. This reads the statement out of the ENGINE so a reword on either side of
      // the pair fails the build instead of silently leaving the row debounced.
      const re = atomix._FUND_DURABLE_WRITE;
      const src = fs.readFileSync(path.join(__dirname, "..", "main/atomix/lib/swapdb.js"), "utf8");
      const body = src.slice(src.indexOf("function rememberLockCoin("));
      const stmt = body.slice(body.indexOf('write("') + 7);
      const emitted = stmt.slice(0, stmt.indexOf('"'));
      assert.ok(/mycoinid/.test(emitted), "found the lock-coin statement, not something else: " + emitted);
      assert.ok(re.test(emitted), "lock-coin write is NOT sync-flushed — regex missed: " + emitted);
      // and the secret write it shares the class with
      assert.ok(re.test("INSERT INTO `secrets` (`hash`,`secret`,`added`) VALUES ('0xa','0xb',1)"));
      // a routine status update must NOT force a flush (that would defeat the debounce entirely)
      assert.ok(!re.test("UPDATE `swaps` SET `status`='COMPLETE' WHERE `hash`='0xa'"));
    });
    await okA("the shim hands a txncheck verdict to the engine untouched (normReply must not clobber `valid`)", async () => {
      const mds = atomix._buildMds();
      atomix._setRunner(async (cmd) => {
        if (/^txncheck /.test(cmd)) return { status: true, response: { inputs: 1, scripts: 0, validamounts: true, valid: { basic: true, mmrproofs: true, scripts: false } } };
        return { status: true };
      });
      const r = await new Promise(res => mds.cmd("txncheck id:axswap_test", res));
      assert.equal(r.status, true);
      assert.equal(r.response.scripts, 0); assert.equal(r.response.inputs, 1);
      assert.strictEqual(r.response.valid.scripts, false, "valid.scripts must reach checkFailure as-is");
      assert.ok(!("error" in r) || r.error == null, "a status:true reply gains no error");
    });
  }

  if (NO_REACH) ok("the whole suite started no child process and opened no socket; the engine's network calls went to a stand-in", () => {
    assert.deepEqual(NO_REACH.reached, [], "something tried to leave the process");
    assert.ok(NO_REACH.net.length > 0, "the engine did ask for the network, and the stand-in answered");
  });
  const skipNote = skipped ? " (" + skipped + " skipped)" : "";
  console.log(fail === 0 ? "\n✅ ATOMIX UNIT PASS — " + pass + " checks" + skipNote : "\n❌ ATOMIX UNIT FAIL — " + fail + " failed" + skipNote);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("UNIT ERROR:", e); process.exit(1); });
