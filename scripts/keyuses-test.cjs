// KeyUses (0.19.127): the audit in main/keyuses.js and what the screen shows of it. Safety-critical: a wrong address or
// a counter shown as 0 reads as "safe". Executed against stand-in node replies and stand-in server answers; nothing
// here reaches a node or the network (the module itself opens no socket: it is handed run() and get()).
"use strict";
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), path = require("path");
require("../renderer/i18n.js");   // t(), th(), tr() as the window has them: the key is the English text, so code lifted out of the renderer reads as before
const K = require("../main/keyuses.js"), Act = require("../renderer/apps-act.js").keyuses;
const R = (f) => { const s = fs.readFileSync(path.join(__dirname, "..", f), "utf8"); return /^renderer\/[^/]+\.js$/.test(f) ? require("./i18n-plain.cjs").plain(s) : s; };   // a renderer script: as it read before its text was wrapped for translation

// MinimaAddressTest.GOLDENS (apks/base integrated/futurecash-next, 1c60c2593325f70cba5089e2ba430925d6ccca3c), copied whole
const GOLDENS = [
  ["0x0000000000000000000000000000000000000000000000000000000000000000", "0x3C6C5998B2CD75897F1212291FCCE6A9572E52CE77A2D13AD2BC7217CCEF4941", "MxG081SDHCPHCMDEM4NU4GW54FSPPY9ASN55JJNKB8JYKYSE8BSPRQ985WP0KH6"],
  ["0x0011111111111111111111111111111111111111111111111111111111111111", "0x25619F02BEDE6EF76AF768BEFA0F1E286F6544F33884C4EA977FEDCC0ECCDCC3", "MxG0815C6FG5FMUDRRMYTR8NRT0U7H8DTWK9SPZGJ2EY5RVTN60TJ6SZF7VJ889"],
  ["0xFF00000000000000000000000000000000000000000000000000000000000000", "0xBE1611D1E4C14DFAA0BE2694F853A616E320349C7FBDC0B258AFAE36C4A0A369", "MxG085U2Z8T3P619NTA1FH6WJS579GMSCG3973VNN0B4M5FYZRC9853D6QFNZ4H"],
  ["0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "0x7159569EA57B8AA753BD82AE8CF3AE8D662E1949EB203DFA39285A64E8B4B592", "MxG083HB5B9T9BRHAJY7FC2YQ6F7BKDCZN1WWFB40UVKE98B9WEHD5YWABB0N4C"],
  ["0x0000000000000000000000000000000000000000000000000000000000000001", "0xEE022AAB7CDD0C82E6308421599C2FCFDEAAF9001DD4036E6407F7147C6FD57F", "MxG087E08YAMV6T1W1ECC4445CPZBUFRQYFW00TQG1MSP07USA7ZRUYFSE4U2TN"],
  ["0x8000000000000000000000000000000000000000000000000000000000000000", "0x98735D7DD62D70D29BB260EED90720B42E0D59C8CB9ECC0F96C679D884ACCA86", "MxG084ZEDENRYHDE399NCJ0TRCGE85K5Z6YJW6BJR60V5M6F7C89B6AGQYVDG26"],
  ["0x3A985DA74FE225B2045C172D6BD390BD855F086E3E9D525B46BFE24511431532", "0x39EED202FFBE82E953D234F9CDAFC5C94AEC64875760130C8A596403906B1D8B", "MxG081PTR905VTUGBKY7KHKV76QVHE99BM691QNC09GP2WPCG1P0QZTHD8SWWVQ"],
  ["0xA7FFC6F8BF1ED76651C14756A061D662F580FF4DE43B49FA82D80A4B80F8434A", "0x9782740B0A9E901CDE3901190D4A8C2666EA23768137E5195D5A8D98F86C903A", "MxG084NG9Q0M2KUW0EDSE81346KY316CRY26TK16VWHWNAQHMCFGR4G79N85V60"],
  ["0x1C0FFEE0BADC0DE0DEADBEEF0123456789ABCDEFFEDCBA98765432100FACADE1", "0x7C4DB156CF15A876F7E7920D5CDE1D7E84D1DFECEDF48539E1B16F264090B596", "MxG083S9MZYDJZYY1RFFPSW1YEDS7BUGJ8TVR7DUW2JJZDHDSJ4145YWQW6S5HT"],
  ["0x0102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F20", "0xCED4685B81BED336ECF4077968CCD4E877DCFB732FA2F5D3F6B742F661999529", "MxG086EQHK5N0DUQCREPT07F5KCPY78EVEFMSPFKBQT7TYN8BR636CY54M5JBYU"]
];
const PK = (n) => GOLDENS[n][0], HEX = (n) => GOLDENS[n][1];
const classic = (n, uses, o) => Object.assign({ size: 64, depth: 3, uses, maxuses: 262144, modifier: "0x00", publickey: PK(n) }, o || {});
const block = (n, uses, o) => Object.assign({ size: 128, depth: 4, uses, maxuses: 268435456, modifier: "0x00", publickey: PK(n) }, o || {});
const reply = (keys) => ({ command: "keys", status: true, response: { keys, total: keys.length, maxuses: 1 } });
const usage = (n, sigs, coins, o) => Object.assign({ publickey: PK(n), address: HEX(n), spend_blocks: sigs, spent_coins: coins }, o || {});
const clean = (n) => ({ address: HEX(n), reused: false, reuse_count: 0 });
/** A stand-in node (always the same keys unless told) and a stand-in server. → { io, asked: [commands], urls: [urls] } */
function world(keys, server, later) {
  const asked = [], urls = []; let reads = 0;
  return { asked, urls, io: {
    run: async (c) => { asked.push(c); reads++; const k = reads > 1 && later ? later : keys; if (k instanceof Error) throw k; return typeof k === "function" ? k() : reply(k); },
    get: async (url) => { urls.push(url); return server(url); } } };
}
const answers = (u, r, tip) => (url) => (url.includes("/keyaudit?") ? { status: true, archive_tip: tip == null ? 2428000 : tip, keys: u } : { status: true, results: r });

test("the address of a public key is minima-core's, for every golden of the original (and nothing for a malformed key)", () => {
  for (const [pk, hex, mx] of GOLDENS) { const a = K.addressOf(pk); assert.equal(a.hex, hex, pk); assert.equal(a.mx, mx, pk); }
  assert.deepEqual(K.addressOf("0x1c0ffee0badc0de0deadbeef0123456789abcdeffedcba98765432100facade1"), K.addressOf(PK(8)), "the script is built from the upper-case key");
  for (const bad of ["", null, 5, "0x12", PK(0) + "00", PK(0).slice(2), "0x" + "G".repeat(64), " " + PK(0)]) assert.equal(K.addressOf(bad), null, String(bad));
  assert.equal(K.selfTest(), true);
});

test("both key modes are read exactly: classic 64 / 3 / 262144 and block 128 / 4 / 268435456, in public-key order", () => {
  const keys = K.select(reply([block(3, 2428101), classic(6, 12), classic(0, 0)]));
  assert.deepEqual(keys.map(k => [k.publickey, k.family, k.uses, k.maxuses]), [[PK(0), "classic", 0, 262144], [PK(6), "classic", 12, 262144], [PK(3), "block", 2428101, 268435456]]);
  assert.deepEqual(keys.map(k => k.address.hex), [HEX(0), HEX(6), HEX(3)]);
  assert.equal(K.select(reply([classic(0, "7")]))[0].uses, 7, "a counter the node wrote as text is read as the same whole number");
  assert.deepEqual(K.SHAPES, { classic: { size: 64, depth: 3, maxuses: 262144 }, block: { size: 128, depth: 4, maxuses: 268435456 } });
});

test("a key list that is not wholly readable refuses the audit: nothing is guessed and nothing becomes 0", async () => {
  const bad = { "no reply": null, "status false": { status: false, error: "locked" }, "no keys": reply([]), "keys not a list": { status: true, response: { keys: "none" } },
    "uses missing": reply([classic(0, undefined)]), "uses not a number": reply([classic(0, "many")]), "uses negative": reply([classic(0, -1)]), "uses a fraction": reply([classic(0, 1.5)]),
    "classic size with the block capacity": reply([classic(0, 1, { maxuses: 268435456 })]), "block size at classic depth": reply([block(0, 1, { depth: 3 })]), "maxuses missing": reply([classic(0, 1, { maxuses: undefined })]),
    "an unknown shape": reply([classic(0, 1, { size: 32, depth: 2, maxuses: 1024 })]), "a malformed key": reply([classic(0, 1, { publickey: "0x1234" })]),
    "one good key and one bad": reply([classic(0, 1), classic(1, null)]), "the same key twice": reply([classic(0, 1), classic(0, 2, { publickey: PK(0).toLowerCase().replace("0X", "0x") })]) };
  for (const [name, r] of Object.entries(bad)) {
    assert.throws(() => K.select(r), name);
    const w = world(() => r, answers([], []));
    assert.deepEqual(await K.audit(w.io), { ok: false, error: K.MSG.unavailable }, name);
    assert.deepEqual(w.urls, [], name + ": nothing is sent to the server");
  }
  const thrown = world(new Error("node not running"), answers([], []));
  assert.deepEqual(await K.audit(thrown.io), { ok: false, error: K.MSG.unavailable });
});

test("the audit sends one read to the node and the keys and addresses to the one pinned host, in chunks of 64", async () => {
  const many = []; for (let i = 0; i < 70; i++) many.push({ size: 64, depth: 3, uses: i, maxuses: 262144, publickey: "0x" + i.toString(16).toUpperCase().padStart(64, "0") });
  const w = world(many, (url) => { const list = decodeURIComponent(url.split("=")[1]).split(",");
    return url.includes("/keyaudit?") ? { status: true, archive_tip: 5, keys: list.map(pk => ({ publickey: pk, address: K.addressOf(pk).hex, spend_blocks: 0, spent_coins: 0 })) } : { status: true, results: list.map(a => ({ address: a, reused: false, reuse_count: 0 })) }; });
  const r = await K.audit(w.io);
  assert.equal(r.ok, true); assert.equal(r.rows.length, 70); assert.equal(r.complete, true); assert.equal(r.tip, 5);
  assert.deepEqual(w.asked, ["keys action:list", "keys action:list"], "a read, and the same read again after the server answered: no other command, nothing that signs");
  assert.equal(w.urls.length, 4, "two chunks for each endpoint");
  for (const u of w.urls) assert.match(u, /^https:\/\/eurobuddha\.com\/(keyaudit\?keys|reuse\?addrs)=[0-9A-Fa-fx%C]+$/);
  assert.deepEqual(w.urls.map(u => decodeURIComponent(u.split("=")[1]).split(",").length).sort(), [6, 6, 64, 64]);
  const src = R("main/keyuses.js");
  assert.ok(!/require\("(https?|net|electron|child_process)"\)/.test(src), "the module opens no socket of its own");
  assert.equal(K.BASE, "https://eurobuddha.com");
  const mainJs = R("main/main.js");
  assert.ok(/ipcMain\.handle\("mcd:keyUsesAudit", \(\) => \{ requireRunning\(\); return keyuses\.audit\(\{ run: \(c\) => rpc\.rpcCall\(node\.rpcPort\(\), config\.rpcSecret\(\), c\), get: \(url\) => netfetch\.fetchJson\(url, \{ noRedirect: true, maxBytes: keyuses\.MAX_BODY_BYTES \}\) \}\); \}\);/.test(mainJs),
    "main: the handler takes nothing from the renderer, reads through rpcCall, follows no redirect and reads at most 512 KB");
  assert.ok(!/mcd:keyReuse/.test(mainJs) && !/keyReuse/.test(R("main/preload.js")), "the old address-list endpoint for the renderer is gone");
});

test("a clean wallet of each mode: OK, every row checked; the classic estimate only for classic keys", async () => {
  const c = await K.audit(world([classic(0, 40), classic(1, 3)], answers([usage(0, 38, 90), usage(1, 3, 3)], [clean(0), clean(1)])).io);
  assert.equal(c.verdict, "OK"); assert.equal(c.complete, true); assert.equal(c.classicKeys, 2); assert.equal(c.blockKeys, 0);
  assert.equal(c.recommendedKeyUses, 40 + 256, "the highest of local uses and spend blocks, plus the original's margin");
  assert.deepEqual(c.rows.map(r => [r.local, r.sigs, r.coins, r.risk, r.reused, r.checked]), [[40, 38, 90, false, false, true], [3, 3, 3, false, false, true]]);
  const b = await K.audit(world([block(0, 2428101), block(1, 2428090)], answers([usage(0, 5000000, 9), usage(1, 0, 0)], [clean(0), clean(1)])).io);
  assert.equal(b.verdict, "OK", "a block key's leaf position is never compared with spend counts, however large they are");
  assert.equal(b.recommendedKeyUses, 0); assert.equal(b.blockKeys, 2); assert.ok(b.rows.every(r => !r.risk && r.maxuses === 268435456));
  assert.deepEqual(Act.verdict(b).blocks.map(x => String(x.label)), ["Node seed · block-based"], "no keyuses estimate is offered for block keys");
  assert.deepEqual(JSON.parse(JSON.stringify(Act.verdict(c).blocks)), [{ label: "Classic recovery estimate: review before use", cmd: "keyuses:296" }]);   // a label fixed at load is a String that translates when shown: read as text
});

test("more spend blocks than a classic counter is AT RISK; witnessed reuse outranks it, amber to 3 and red above", async () => {
  const risk = await K.audit(world([classic(0, 10), block(1, 7)], answers([usage(0, 11, 11), usage(1, 900, 900)], [clean(0), clean(1)])).io);
  assert.equal(risk.verdict, "RISK_HEURISTIC"); assert.deepEqual(risk.rows.map(r => r.risk), [true, false]);
  assert.deepEqual(Act.chip(risk.rows[0]), { label: "AT RISK", tone: "risk" }); assert.equal(Act.verdict(risk).tone, "risk");
  for (const [count, verdict, tone] of [[2, "REUSE_WARN", "warn"], [3, "REUSE_WARN", "warn"], [4, "REUSE_RISK", "risk"]]) {
    const r = await K.audit(world([classic(0, 10), block(1, 7)], answers([usage(0, 11, 11), usage(1, 1, 1)], [clean(0), { address: HEX(1), reused: true, reuse_count: count }])).io);
    assert.equal(r.verdict, verdict); assert.equal(r.worstReuse, count); assert.equal(r.rows[1].reused, true, "reuse is found for a block key too");
    assert.deepEqual(Act.chip(r.rows[1]), { label: "REUSED ×" + count, tone });
    const v = Act.verdict(r); assert.equal(v.tone, tone); assert.ok(!v.blocks.some(x => x.cmd), "with confirmed reuse no keyuses estimate is shown");
  }
});

test("what the server did not answer is never a zero: the row carries null, reads 'Not read' and 'Unknown', and the audit 'needs review'", async () => {
  const r = await K.audit(world([classic(0, 10), classic(1, 20), classic(2, 30)], answers([usage(0, 1, 1), usage(2, "x", 1)], [clean(0), clean(1), clean(2)])).io);
  assert.deepEqual(r.rows.map(x => [x.sigs, x.coins, x.checked]), [[1, 1, true], [null, null, false], [null, null, false]], "a missing row and a row with an unreadable count");
  assert.equal(r.complete, false); assert.equal(r.verdict, "OK");
  assert.equal(Act.num(null), "Not read"); assert.equal(Act.num(0), "0"); assert.equal(Act.num(1234567), "1,234,567");
  assert.deepEqual(Act.chip(r.rows[1]), { label: "Unknown", tone: "warn" });
  const v = Act.verdict(r); assert.equal(v.title, "Audit needs review"); assert.equal(v.tone, "warn"); assert.deepEqual(v.blocks, [], "no estimate from an incomplete audit");
  const noReuse = await K.audit(world([classic(0, 10)], answers([usage(0, 1, 1)], [{ address: HEX(0), reused: false, reuse_count: 2 }, { address: HEX(0), reused: "no" }])).io);
  assert.equal(noReuse.rows[0].checked, false, "'not reused' with a count, or a reused that is not true / false, is not an answer");
  assert.deepEqual(K.parseUsage([{ publickey: PK(0), error: "x", spend_blocks: 0, spent_coins: 0 }, { publickey: PK(1), spend_blocks: -1, spent_coins: 0 }, { publickey: PK(2), onchain_signatures: 4, spent_coins_upperbound: 6, address: HEX(2) }, null, "x"]),
    [{ publickey: PK(2), address: HEX(2), sigs: 4, coins: 6 }], "the scanner's field names are read as the original reads them; errors and negatives are left out");
});

test("an address the server derived differently marks the audit as not to be trusted; a key near its capacity is said", async () => {
  const wrong = await K.audit(world([classic(0, 1)], answers([usage(0, 0, 0, { address: HEX(5) })], [clean(0)])).io);
  assert.equal(wrong.mismatch, true); assert.equal(wrong.complete, false); assert.equal(wrong.rows[0].checked, false);
  const none = await K.audit(world([classic(0, 1)], answers([usage(0, 0, 0, { address: "" })], [clean(0)])).io);
  assert.equal(none.mismatch, true, "no address from the server is a mismatch too (KeyAudit.join)");
  for (const [k, said] of [[classic(0, 262144 - 1000), false], [classic(0, 262144 - 999), true], [block(0, 268435456 - 999), true], [block(0, 262144), false]])
    assert.equal((await K.audit(world([k], answers([usage(0, 0, 0)], [clean(0)])).io)).exhaustion, said, k.size + " at " + k.uses);
});

test("a server that fails, redirects (null), or says status false ends the audit with the network message, and shows no rows", async () => {
  for (const server of [() => null, () => ({ status: false, error: "busy" }), () => { throw new Error("socket"); }, (url) => (url.includes("/reuse?") ? null : { status: true, keys: [usage(0, 0, 0)] })])
    assert.deepEqual(await K.audit(world([classic(0, 1)], server).io), { ok: false, error: K.MSG.network });
});

test("keys that change while the server is asked (a signature was made) refuse the audit: 'run it again'", async () => {
  const server = answers([usage(0, 1, 1)], [clean(0)]);
  assert.deepEqual(await K.audit(world([classic(0, 1)], server, [classic(0, 2)]).io), { ok: false, error: K.MSG.changed }, "a counter moved");
  assert.deepEqual(await K.audit(world([classic(0, 1)], server, [classic(0, 1), classic(1, 0)]).io), { ok: false, error: K.MSG.changed }, "a key was added");
  assert.deepEqual(await K.audit(world([classic(0, 1)], server, new Error("stopped")).io), { ok: false, error: K.MSG.unavailable }, "the node went away");
  assert.equal((await K.audit(world([classic(0, 1)], server, [classic(0, 1)]).io)).ok, true);
});

// 0.19.137 (review)
test("the verdict itself says what was not checked: 'no reuse in the checked keys' is never a clean bill for the seed's other keys", async () => {
  const ok = await K.audit(world([classic(0, 1), classic(1, 0)], answers([usage(0, 1, 1), usage(1, 0, 0)], [clean(0), clean(1)])).io);
  assert.equal(ok.verdict, "OK"); assert.equal(ok.complete, true);
  const v = Act.verdict(ok);
  assert.equal(v.title, "No known key reuse was found in the checked keys.");
  assert.equal(v.scope, "Checked scope: 2 classic · 0 block-based keys held by this node.");
  assert.ok(v.gap.startsWith("Not checked here: the keys this wallet's seed gives in the other key mode") && v.gap.includes("those keys can have been reused and this result does not show it"));
  for (const r of [ok, Object.assign({}, ok, { verdict: "RISK_HEURISTIC" }), Object.assign({}, ok, { verdict: "REUSE_WARN", worstReuse: 2 }), Object.assign({}, ok, { complete: false })]) assert.equal(Act.verdict(r).gap, v.gap, "every verdict carries it");
  const tools = R("renderer/apps-tools.js");
  assert.ok(/<h2 class="kx-verdict__t">\$\{esc\(v\.title\)\}<\/h2><p class="kx-verdict__b"><b>\$\{esc\(v\.scope\)\}<\/b> \$\{esc\(v\.gap\)\}<\/p><p class="kx-verdict__b">\$\{esc\(v\.body\)\}<\/p>/.test(tools), "drawn inside the verdict card, right under its title, the scope and the gap side by side");
  assert.ok(!/kx-scope/.test(tools), "the scope is said once, in the verdict");
});

test("the lookups go one at a time, and the first failure stops them: no further public key or address leaves", async () => {
  const keys = Array.from({ length: 150 }, (_, i) => ({ size: 64, depth: 3, uses: 0, maxuses: 262144, publickey: "0x" + i.toString(16).toUpperCase().padStart(64, "0") }));   // 3 chunks of keys, 3 of addresses
  let open = 0, most = 0; const urls = [];
  const server = (failAt) => async (url) => { urls.push(url); open++; most = Math.max(most, open); await new Promise(r => setImmediate(r)); open--;
    if (urls.length === failAt) return null;
    const list = decodeURIComponent(url.split("=")[1]).split(",");
    return url.includes("/keyaudit?") ? { status: true, archive_tip: 5, keys: list.map(pk => ({ publickey: pk, address: K.addressOf(pk).hex, spend_blocks: 0, spent_coins: 0 })) } : { status: true, results: list.map(a => ({ address: a, reused: false, reuse_count: 0 })) }; };
  const sel = K.select({ status: true, response: { keys } });
  const all = await K.lookup(sel, server(0));
  assert.equal(most, 1, "never two requests at once"); assert.equal(urls.length, 6); assert.equal(all.usage.length, 150); assert.equal(all.reuse.length, 150);
  assert.deepEqual(urls.map(u => u.slice(0, u.indexOf("=") + 1)), ["https://eurobuddha.com/keyaudit?keys=", "https://eurobuddha.com/keyaudit?keys=", "https://eurobuddha.com/keyaudit?keys=", "https://eurobuddha.com/reuse?addrs=", "https://eurobuddha.com/reuse?addrs=", "https://eurobuddha.com/reuse?addrs="]);
  assert.deepEqual(urls.map(u => decodeURIComponent(u.split("=")[1]).split(",").length), [64, 64, 22, 64, 64, 22]);
  for (const failAt of [1, 2, 4]) { urls.length = 0; await assert.rejects(K.lookup(sel, server(failAt)), /no answer/); assert.equal(urls.length, failAt, "request " + failAt + " failed: nothing was sent after it"); }
  urls.length = 0; const io = { run: async () => ({ status: true, response: { keys } }), get: server(2) };
  assert.deepEqual(await K.audit(io), { ok: false, error: K.MSG.network }); assert.equal(urls.length, 2, "the audit stops with it: 86 of the 150 public keys were never sent");
});

test("a reply may weigh 512 KB, as the phone's; a full reply for the largest request is far below that", () => {
  assert.equal(K.MAX_BODY_BYTES, 512 * 1024); assert.equal(K.CHUNK, 64);
  // the server's rows (mds/keyuses backend/KeyUsesServer.java), every field at its longest
  const long = 9223372036854775807n.toString(), pk = "0x" + "F".repeat(64), mx = "Mx" + "W".repeat(64);
  const auditRow = `{"publickey":"${pk}","address":"${pk}","miniaddress":"${mx}","spend_blocks":${long},"spent_coins":${long},"firstblock":${long},"lastblock":${long},"reused":false,"reuse_count":${long}}`;
  const reuseRow = `{"input":"${pk}","address":"${pk}","miniaddress":"${mx}","reused":false,"reuse_count":${long},"balance":"${"9".repeat(20)}.${"9".repeat(44)}"}`;
  const full = (row, n) => Buffer.byteLength(`{"status":true,"archive_tip":${long},"reuse_included":true,"reused_total":${long},"keys":[` + Array(n).fill(row).join(",") + "]}");
  assert.ok(auditRow.length < 450 && reuseRow.length < 450, auditRow.length + " and " + reuseRow.length + " bytes a row at the very most");
  assert.ok(full(auditRow, 64) < 29 * 1024 && full(reuseRow, 64) < 29 * 1024, "64 rows: " + full(auditRow, 64) + " and " + full(reuseRow, 64) + " bytes");
  assert.ok(full(auditRow, 256) < 115 * 1024, "even the server's own limit of 256 rows: " + full(auditRow, 256) + " bytes");
  const mainJs = R("main/main.js");
  assert.equal((mainJs.match(/netfetch\.fetchJson\(url, \{ noRedirect: true, maxBytes: keyuses\.MAX_BODY_BYTES \}\)/g) || []).length, 2, "both of the app's calls to the audit service: no redirect, 512 KB");
});

test("the screen: Pandamonium's KeyUses, every identifier whole and copyable, nothing from outside written as HTML", () => {
  const tools = R("renderer/apps-tools.js"), css = R("renderer/apps.css"), html = R("renderer/index.html"), app = R("renderer/app.js");
  const body = tools.slice(tools.indexOf("// ---- KeyUses"), tools.indexOf("// ---- Minima Explorer") > 0 ? tools.indexOf("// ---- Minima Explorer") : tools.length);
  for (const said of ["Key audit", "KeyUses", "Run audit", "Auditing your keys…", "Only public keys and addresses are sent to eurobuddha.com for the audit.", "Local uses", "Spend blocks", "Spent coins", "eurobuddha · Minima Ecosystem · KeyUses"])
    assert.ok(body.includes(said), said);
  assert.ok(/data-copy="\$\{esc\(x\.address\)\}"[^>]*>\$\{esc\(x\.address\)\}</.test(body), "an address is shown whole and one click copies it whole");
  assert.ok(!/slice\(|substr|…\$\{|\.\.\.\$\{/.test(body.replace(/Auditing your keys…/, "")), "nothing is cut");
  // every value put into the page is escaped, or is one of these: a fixed word of this file's own, or markup built the same way
  const own = ["tone", "c.tone", "v.tone", "n", "head", 's.busy || !running ? " disabled" : ""', 'x.family === "block" ? " · 128/4" : ""', 'r.complete ? "" : notice(C.incomplete, "warn")', 'r.mismatch ? notice(C.mismatch, "risk") : ""', 'r.exhaustion ? notice(C.exhaustion, "warn") : ""',
    "v.blocks.map(block).join(\"\")", 's.result ? keyUsesResults(s.result) : ""'];
  for (const m of body.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})+)\}/g)) { const e = m[1].trim(); assert.ok(/^esc\([^()]*(\([^()]*\))?[^()]*\)$/.test(e) || own.includes(e) || /^(running \? "" : `|s\.busy \? `|s\.error \? `|K\.sections\(r\)\.map|s\.rows\.map\(\(x, i\) => row|r\.tip > 0 \? "Archive coverage to block " \+ esc\(r\.tip\))/.test(e), "interpolated: " + e); }
  assert.ok(html.includes('id="view-keyuses"') && html.includes('id="keyusesBody"'));
  for (const c of ["#0A0A0F", "#15151F", "#2A2A38", "#E8E6E3", "#8D8B89", "#F7931A", "#FF5E3A", "#4ADE80", "#FBBF24", "#F87171", "#08080C"]) assert.ok(css.slice(css.indexOf("/* ---- KeyUses")).includes(c), "Design.java's " + c);
  assert.ok(/\.kx :focus-visible \{ outline: 2px solid #F7931A/.test(css), "a focus ring");
  assert.ok(!/—/.test(body.replace(/\/\/[^\n]*/g, "")) && !/—/.test(JSON.stringify(Act.COPY)), "no em dash in the screen's text");
  assert.ok(!/keyUsesAudit\([^)]/.test(body), "the screen hands the main process nothing");
  assert.ok(/if \(activeView === "keyuses" && view !== "keyuses"\) keyUsesReset\(\);/.test(app), "the result is dropped when the screen is left");
  assert.ok(!/api\.keyAudit\(pubs\)|runKeyAudit|kuAuditStatus/.test(app), "Settings no longer runs its own audit (it sent the keys whenever Settings was opened)");
  const svg = R("renderer/icons/keyuses.svg"), xml = "M32,9 L50,16 V32 C50,43 42,50 32,55 C22,50 14,43 14,32 V16 Z|M21,28 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0|M31,32 L41,42 M38,39 L42,35 M41,42 L37,46".split("|");
  for (const d of xml) assert.ok(svg.includes('d="' + d + '"'), "the launcher icon's path data, unchanged");
  assert.deepEqual(Act.sections({ rows: [{ family: "block" }, { family: "classic" }, { family: "classic" }] }).map(s => [s.title, s.rows.length]), [["Classic keys · 1–2", 2], ["Blocks-as-keyuses keys · 1–1", 1]]);
  assert.ok(require("../main/freeze.js").FREEZABLE.includes("keyuses"));
});

// 0.19.138 (review): the card ranked a block key's position against classic signature counts and called both "sigs".
test("Settings' Signing keys: figures and the 80% warning per key family; a block key's position is never called signatures, ranked against classic counts, or warned about", () => {
  const app = R("renderer/app.js"), i = app.indexOf("\nfunction keysInfo(keys) {"), j = app.indexOf("\nfunction maxKeyUses(k) {");
  const { keysInfo, maxKeyUses } = new Function("AppsAct", app.slice(i, app.indexOf("\n", i + 1) + 1) + app.slice(j, app.indexOf("\n}", j) + 2) + "\nreturn { keysInfo, maxKeyUses };")({ keyuses: Act });
  assert.deepEqual(Act.SHAPES, K.SHAPES, "the same two shapes as main/keyuses.js");
  assert.deepEqual(keysInfo({ keys: [classic(0, 12), classic(1, 40), classic(2, 0)] }), { classic: { used: 40, cap: 262144, count: 3 }, block: null });
  assert.deepEqual(keysInfo({ keys: [block(0, 2428101), block(1, 2428090)] }), { classic: null, block: { used: 2428101, cap: 268435456, count: 2 } });
  const both = keysInfo({ keys: [classic(0, 200000), block(1, 2428101), classic(2, 3)] });
  assert.deepEqual(both, { classic: { used: 200000, cap: 262144, count: 2 }, block: { used: 2428101, cap: 268435456, count: 1 } }, "each family by itself: 2428101 is not 'more used' than 200000");
  assert.deepEqual(keysInfo([classic(0, "5"), classic(1, "7.0")]), { classic: { used: 7, cap: 262144, count: 2 }, block: null }, "numbers as the node writes them");
  for (const bad of [null, undefined, {}, { keys: [] }, { keys: "x" }, { keys: [classic(0, undefined)] }, { keys: [classic(0, "many")] }, { keys: [classic(0, 5), classic(1, null)] }, { keys: [classic(0, 5, { maxuses: undefined })] }, { keys: [classic(0, -1)] }, { keys: [classic(0, 1.5)] },
    { keys: [classic(0, 5, { size: 128 })] }, { keys: [classic(0, 5, { maxuses: 268435456 })] }, { keys: [block(0, 5, { depth: 3 })] }, { keys: [classic(0, 5), { publickey: PK(1), uses: 1, maxuses: 1000 }] }])
    assert.equal(keysInfo(bad), null, "not read, or not one of the two shapes: " + JSON.stringify(bad));
  // the card
  let rows = Act.signing(keysInfo({ keys: [classic(0, 40), classic(1, 12)] }));
  assert.deepEqual(rows, [{ family: "classic", label: "Classic keys: most-used key", value: "40 of 262,144 signatures · 2 keys", pct: 0, warn: false, note: "" }]);
  rows = Act.signing(keysInfo({ keys: [classic(0, 209715)] })); assert.equal(rows[0].pct, 79, "209715 of 262144 is 79.99…%: cut, not rounded up"); assert.equal(rows[0].warn, false);
  rows = Act.signing(keysInfo({ keys: [classic(0, 209716)] })); assert.equal(rows[0].pct, 80); assert.equal(rows[0].warn, true); assert.equal(rows[0].note, "A classic signing key is 80% used. Generate fresh keys or restore with the correct key uses before it is exhausted."); assert.equal(rows[0].value, "209,716 of 262,144 signatures · 1 key");
  rows = Act.signing(keysInfo({ keys: [block(0, 2428101), block(1, 2428090)] }));
  assert.deepEqual(rows, [{ family: "block", label: "Block-based keys: key block position", value: "position 2,428,101 of 268,435,456 · 2 keys", pct: null, warn: false,
    note: "A block-based key's position follows the chain's block number. It is not a count of signatures, so it is not compared with classic keys." }]);
  for (const uses of [214748365, 268435455, 268435456]) { const r = Act.signing(keysInfo({ keys: [block(0, uses)] }))[0]; assert.equal(r.warn, false, "a block position at " + uses + " never raises the classic warning"); assert.equal(r.pct, null, "and has no share or bar"); assert.ok(!/sig/i.test(r.label + r.value), "nor the word signatures"); }
  rows = Act.signing(both); assert.deepEqual(rows.map(r => r.family), ["classic", "block"]); assert.equal(rows[0].pct, 76); assert.equal(rows[0].warn, false, "the block key's larger number does not make the classic line warn");
  assert.deepEqual(Act.signing(null), []);
  assert.ok(/\$\{ku \? AppsAct\.keyuses\.signing\(ku\)\.map\(r => /.test(app) && !/sigs ·|Most-used key<\/span>|\$\{esc\(ku\.used\)\} \//.test(app), "the card is drawn from those lines, and the old single 'sigs' line is gone");
  assert.ok(/\$\{r\.pct == null \? "" : `<div class="health__track">/.test(app) && /r\.warn \? `<div class="status status--warn">⚠ \$\{esc\(r\.note\)\}<\/div>` : `<p class="set-text">\$\{esc\(r\.note\)\}<\/p>`/.test(app));
  // the footer
  assert.equal(maxKeyUses({ keys: [classic(0, undefined)] }), null, "the footer keeps 'Awaiting blocks…' rather than print 0");
  assert.equal(maxKeyUses(null), null); assert.equal(maxKeyUses({ keys: [classic(0, 7)], maxuses: 8 }), 8, "the node's own maxuses line is shown as the node gave it");
  assert.equal(maxKeyUses({ keys: [classic(0, 7), block(1, 2428101)] }), 7, "without that line: the classic count, never the larger of two unlike figures"); assert.equal(maxKeyUses({ keys: [block(1, 2428101)] }), 2428101);
  assert.ok(/The node's key uses could not be read\. Nothing is shown rather than a figure that was not read\./.test(app));
  assert.ok(!/parseInt\(k\.uses, 10\) \|\| 0|cap \|\| 262144/.test(app), "no counter defaults to 0 and no capacity to the classic one");
});
