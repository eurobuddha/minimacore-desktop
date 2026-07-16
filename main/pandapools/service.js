/*
 * service.js — PandaPools background worker. Runs headless whenever the node is up (page open or not), so:
 *   (1) the sentinel coin notifier stays registered,
 *   (2) pool discovery stays fresh and every newly-seen registry pool is `newscript trackall`-ed
 *       (track-on-discovery) → it becomes a tracked contract that NEVER prunes, so this node keeps the pool
 *       enumerable + swappable forever, and
 *   (3) the GlobalFeed keeps capturing swaps across all pools even while the UI is closed.
 *
 * SELF-CONTAINED: the MDS service runtime injects only the `MDS` global (no decimal.js, no dapp modules), so
 * the covenant template, script-arg quoting, state reading and an exact BigInt fixed-point decimal are all
 * inlined here. It shares the `pp_feed` / `pp_kv` SQL tables with the page's store.js (same MDS database).
 */

var SENTINEL = "0x50414E4441504F4F4C53";     // "PANDAPOOLS"
var FEED_MAX = 100;
var READY = false;
var PRIMED = false;   // first ingest of this service session suppresses CREATE (can't tell new from unpersisted)
var SESSION_SEEN = {}; // addresses seen at least once this service session — a pool's FIRST sighting only
                       // reseeds (never diffs a possibly-pre-restart snapshot), so no phantom events on restart
var MISS_CLOSE = 2;    // consecutive scans a pool must be absent before it's emitted as a close/withdraw
// Layer 5 (background re-announce) — keep faded discovery beacons alive while the page is closed.
var ANNOUNCE_DUST = "0.000000001";   // the beacon dust amount (matches poolmgr.js)
var VERSION_HEX = "0x505031";   // "PP1" (matches covenant.js / poolmgr addAnnounceState)
var PRESENT_BEACONS = {};       // beacon identity keys in the recent registry window (rebuilt each scan)
var ANN_SVC = {};               // keys re-announced this service session (no double-post before it confirms)
var lastAnnTs = 0;              // throttle: last faded-beacon re-announce sweep
var REANN_MS = 6 * 3600 * 1000; // sweep at most every 6h (beacons prune ~1 day; matches native's worker cadence)
var MAX_ANN_PER_RUN = 8;        // gossip cap: one node re-posts at most this many faded beacons per sweep
var annCounter = 0;
// PROACTIVE re-announce: re-post a beacon once it is older than this — BEFORE it leaves the depth:1500 discovery
// window — so a live pool's beacon never lapses on any node (parity with native REANNOUNCE_DEPTH). Below the
// discovery depth with margin, and below REFRESH_BLOCKS so an owner's own refresh usually pre-empts it.
var REANNOUNCE_BLOCKS = 1000;
// KEEP-FRESH (background) — recreate MY pools' reserves in place, keeping them young for every node's window.
var REFRESH_BLOCKS = 900;       // refresh a reserve older than this (lowered 1200→900 so a short/resynced node's
                                // window doesn't drop them first; must match native PoolRefresher.REFRESH_BLOCKS)
var REFRESH_MS = 30 * 60 * 1000;// check for aging own pools at most every ~30min (the 1200→1700 window is ~7h wide)
var lastRefreshTs = 0;
var REFRESH_SVC = {};           // address -> ts of last refresh attempt; TTL-guarded so a double-fire is blocked
var REFRESH_TTL_MS = 5 * 60 * 1000;   // ...while the refresh confirms (~2 blocks); far below the next real refresh (~19h)
var MAX_REFRESH_PER_RUN = 8;
var refreshCounter = 0;
var SCANNING = false, scanStartTs = 0;   // re-entrancy guard: one scan at a time (avoids the snap/feed race under
                                         // NEWBLOCK bursts), with a 2-min stuck-guard so a dropped callback can't wedge it

// The covenant template, ONE line, byte-identical to PoolCovenant/covenant.js (0.5% fee = *5/1000).
var TEMPLATE =
    "IF SIGNEDBY($OPK) THEN " +
    "IF VERIFYOUT(@INPUT $OADR @AMOUNT @TOKENID FALSE) THEN RETURN TRUE ENDIF " +
    "RETURN GETOUTADDR(@INPUT) EQ @ADDRESS AND GETOUTTOK(@INPUT) EQ @TOKENID AND GETOUTAMT(@INPUT) GTE @AMOUNT " +
    "ENDIF " +
    "IF @TOKENID EQ 0x00 THEN " +
    "ASSERT @INPUT % 2 EQ 0 LET s=@INPUT+1 " +
    "ASSERT GETINADDR(s) EQ @ADDRESS AND GETINTOK(s) EQ $TOK " +
    "ASSERT GETOUTADDR(s) EQ @ADDRESS AND GETOUTTOK(s) EQ $TOK " +
    "LET x=@AMOUNT LET y=GETINAMT(s) LET nx=GETOUTAMT(@INPUT) LET ny=GETOUTAMT(s) " +
    "ASSERT VERIFYOUT(@INPUT @ADDRESS nx 0x00 FALSE) " +
    "ELSE " +
    "ASSERT @TOKENID EQ $TOK AND @INPUT % 2 EQ 1 LET s=@INPUT-1 " +
    "ASSERT GETINADDR(s) EQ @ADDRESS AND GETINTOK(s) EQ 0x00 " +
    "ASSERT GETOUTADDR(s) EQ @ADDRESS AND GETOUTTOK(s) EQ 0x00 " +
    "LET y=@AMOUNT LET x=GETINAMT(s) LET ny=GETOUTAMT(@INPUT) LET nx=GETOUTAMT(s) " +
    "ASSERT VERIFYOUT(@INPUT @ADDRESS ny $TOK FALSE) " +
    "ENDIF " +
    "LET dx=nx-x LET dy=ny-y LET fx=MAX(dx 0)*5/1000 LET fy=MAX(dy 0)*5/1000 " +
    "RETURN (nx-fx)*(ny-fy) GTE MAX(x*y $KMIN)";

function covScript(opk, oadr, tok, kmin) {
    return TEMPLATE.split("$OPK").join(opk).split("$OADR").join(oadr).split("$TOK").join(tok).split("$KMIN").join(kmin);
}
// Quote a KISS script WITHOUT escaping forward slashes (JSONObject.quote's `/`→`\/` makes *5/1000 unparseable
// → coins permanently unspendable). Escape only `"` and `\`; leave `/` alone.
function scriptArg(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) { var c = s.charAt(i); if (c === '"' || c === '\\') out += '\\'; out += c; }
    return out + '"';
}
function truthy(v) {
    if (v === true) return true;
    if (typeof v === "number") return v === 1;
    if (typeof v === "string") { var s = v.trim().toLowerCase(); return s === "1" || s === "true"; }
    return false;
}
function readState(coin, port) {
    if (!coin || !coin.state) return null;
    var st = coin.state;
    if (Array.isArray(st)) {
        for (var i = 0; i < st.length; i++) {
            var e = st[i];
            if (e && (e.port === port || String(e.port) === String(port))) { var d = e.data || ""; return d === "" ? null : d; }
        }
        return null;
    }
    if (typeof st === "object") { var v = st[String(port)]; return (v === undefined || v === null || v === "") ? null : v; }
    return null;
}

// covenant literal extractors (recover a pool from a tracked contract script)
var P_OPK = /SIGNEDBY\((0x[0-9A-Fa-f]+)\)/;
var P_OADR = /VERIFYOUT\(@INPUT (0x[0-9A-Fa-f]+) @AMOUNT/;
var P_TOK = /GETINTOK\(s\) EQ (0x[0-9A-Fa-f]+)/;
var P_KMIN = /GTE MAX\(x\*y ([0-9.]+)\)/;
function grp(re, s) { var m = re.exec(s); return m ? m[1] : null; }

// ---------------------------------------------------------------- exact fixed-point decimal (BigInt, float fallback)
var HAS_BIG = (typeof BigInt !== "undefined");
function splitDec(s) { s = String(s); var i = s.indexOf("."); return { I: i < 0 ? s : s.slice(0, i), F: i < 0 ? "" : s.slice(i + 1) }; }
function decCmp(a, b) {   // non-negative decimal strings -> -1/0/1
    var sa = splitDec(a), sb = splitDec(b);
    var aI = (sa.I.replace(/^0+/, "") || "0"), bI = (sb.I.replace(/^0+/, "") || "0");
    if (aI.length !== bI.length) return aI.length < bI.length ? -1 : 1;
    if (aI !== bI) return aI < bI ? -1 : 1;
    var L = Math.max(sa.F.length, sb.F.length);
    var aF = sa.F + Array(L - sa.F.length + 1).join("0");
    var bF = sb.F + Array(L - sb.F.length + 1).join("0");
    return aF === bF ? 0 : (aF < bF ? -1 : 1);
}
function pad0(s, n) { while (s.length < n) s = "0" + s; return s; }
function unscale(digits, L) {
    var neg = digits.charAt(0) === "-"; if (neg) digits = digits.slice(1);
    if (L === 0) return (neg ? "-" : "") + (digits.replace(/^0+/, "") || "0");
    digits = pad0(digits, L + 1);
    var I = digits.slice(0, digits.length - L), F = digits.slice(digits.length - L).replace(/0+$/, "");
    return (neg ? "-" : "") + (I.replace(/^0+/, "") || "0") + (F ? "." + F : "");
}
function scaleTo(s, L) { var sp = splitDec(s); var F = sp.F + Array(L - sp.F.length + 1).join("0"); return (sp.I + F).replace(/^0+/, "") || "0"; }
function decSub(a, b) {   // a-b, a>=b>=0
    if (!HAS_BIG) return String(parseFloat(a) - parseFloat(b));
    var L = Math.max(splitDec(a).F.length, splitDec(b).F.length);
    return unscale((BigInt(scaleTo(a, L)) - BigInt(scaleTo(b, L))).toString(), L);
}
function decDiv(a, b, dp) {   // a/b to dp fractional digits, non-negative
    if (!HAS_BIG) { var bf = parseFloat(b); return bf ? String(parseFloat(a) / bf) : "0"; }
    var la = splitDec(a).F.length, lb = splitDec(b).F.length;
    var num = BigInt(scaleTo(a, la)) * pow10(lb + dp);
    var den = BigInt(scaleTo(b, lb)) * pow10(la);
    if (den === BigInt(0)) return "0";
    return unscale((num / den).toString(), dp);
}
function pow10(n) { var r = BigInt(1), t = BigInt(10); for (var i = 0; i < n; i++) r = r * t; return r; }

// ---------------------------------------------------------------- init
MDS.init(function (msg) {
    if (msg.event === "inited") {
        // One-time cleanup (parity with native 0.9.14): stop tracking the unspendable sentinel. We used to
        // `coinnotify action:add` it, which made the node retain every dust beacon ever posted there (they never
        // spend) into an ever-growing set. Discovery now reads the recent chain via a depth-bounded scan instead.
        MDS.cmd("coinnotify action:remove address:" + SENTINEL, function () {});
        ensureTables(function () { READY = true; MDS.log("PandaPools service ready"); retrackOwn(); scan(); });
    }
    if (msg.event === "NEWBLOCK") { if (READY) scan(); }
});

function ensureTables(cb) {
    function done() { ensureOwn(cb); }   // pp_ownpools shared with the page (store.js)
    MDS.sql("SELECT 1 FROM pp_feed LIMIT 1", function (r) {
        if (r && r.status) { migrateFeedKind(done); return; }   // exists (maybe a pre-kind install) → migrate
        MDS.sql(
            "CREATE TABLE IF NOT EXISTS `pp_feed` (" +
            " `id` bigint auto_increment, `pool` varchar(80) NOT NULL, `tokenlabel` varchar(80) NOT NULL," +
            " `kind` varchar(12) NOT NULL DEFAULT 'SWAP'," +
            " `minimain` int NOT NULL, `minimaamt` varchar(90) NOT NULL, `tokenamt` varchar(90) NOT NULL," +
            " `price` varchar(90) NOT NULL, `ts` bigint NOT NULL)", function () {
            MDS.sql("CREATE TABLE IF NOT EXISTS `pp_kv` (`k` varchar(64) NOT NULL PRIMARY KEY, `v` text NOT NULL)", function () { done(); });
        });
    });
}
// pp_ownpools is written by the page (store.js ownRecord); the service only reads it (re-track on launch).
function ensureOwn(cb) {
    MDS.sql("SELECT 1 FROM pp_ownpools LIMIT 1", function (r) {
        if (r && r.status) { cb(); return; }
        MDS.sql(
            "CREATE TABLE IF NOT EXISTS `pp_ownpools` (" +
            " `address` varchar(80) NOT NULL PRIMARY KEY, `mx` varchar(80)," +
            " `opk` varchar(140) NOT NULL, `oadr` varchar(80) NOT NULL, `tok` varchar(80) NOT NULL," +
            " `tdec` int NOT NULL, `kmin` varchar(120) NOT NULL, `script` text)", function () { cb(); });
    });
}
// Layer 2 — re-track on launch (headless): re-register every owned-pool covenant so a wiped/re-synced node
// re-tracks it and discovery finds it again, even while the page is closed. Gated on already-tracked (one
// `scripts` read up front) so a NORMAL launch fires ZERO writes — only a node that has actually LOST the
// tracking (wipe/resync) issues newscript, keeping restricted nodes prompt-free. Prefers the stored
// authoritative script; reconstructs from params only as a fallback.
function retrackOwn() {
    MDS.sql("SELECT * FROM pp_ownpools", function (r) {
        if (!r || !r.status || !r.rows || !r.rows.length) return;
        var recipes = r.rows;
        MDS.cmd("scripts", function (sres) {
            var tracked = {};
            var arr = (sres && sres.status && Array.isArray(sres.response)) ? sres.response : [];
            for (var i = 0; i < arr.length; i++) { var ad = arr[i] && arr[i].address; if (ad) tracked[String(ad).toLowerCase()] = true; }
            recipes.forEach(function (row) {
                var addr = row.ADDRESS ? String(row.ADDRESS).toLowerCase() : "";
                if (!addr || tracked[addr]) return;   // already tracked → no redundant write
                var script = (row.SCRIPT && row.SCRIPT.length) ? row.SCRIPT
                           : (row.OPK && row.OADR && row.TOK && row.KMIN ? covScript(row.OPK, row.OADR, row.TOK, row.KMIN) : "");
                if (script) MDS.cmd("newscript trackall:true script:" + scriptArg(script), function () {});
            });
        });
    });
}
// Add the lifecycle `kind` column to a pre-0.2.0 pp_feed (default SWAP so old rows still render). The page
// (store.js) and this headless service both run this; whichever adds the column first wins, and a duplicate
// ALTER from the other just errors harmlessly (swallowed by the no-op callback).
function migrateFeedKind(cb) {
    MDS.sql("SELECT kind FROM pp_feed LIMIT 1", function (r) {
        if (r && r.status) { cb(); return; }
        MDS.sql("ALTER TABLE pp_feed ADD COLUMN kind varchar(12) DEFAULT 'SWAP'", function () { cb(); });
    });
}

// ---------------------------------------------------------------- discovery (mirrors book.js, self-contained)
function scan() {
    if (SCANNING && (Date.now() - scanStartTs) < 120000) return;   // one scan at a time (2-min stuck-guard)
    SCANNING = true; scanStartTs = Date.now();
    var params = {};   // "opk|tok|kmin" -> {opk,oadr,tok,kmin,script?}
    PRESENT_BEACONS = {};   // rebuilt from this scan's recent-window sentinel coins
    MDS.cmd("scripts", function (sres) {
        try {
            var arr = (sres && sres.status && Array.isArray(sres.response)) ? sres.response : [];
            for (var i = 0; i < arr.length; i++) {
                var sc = arr[i] ? (arr[i].script || "") : "";
                if (sc.indexOf("VERIFYOUT(@INPUT @ADDRESS") < 0 || sc.indexOf("GTE MAX(x*y") < 0) continue;
                var opk = grp(P_OPK, sc), oadr = grp(P_OADR, sc), tok = grp(P_TOK, sc), kmin = grp(P_KMIN, sc);
                if (!opk || !oadr || !tok || !kmin) continue;
                var k = opk + "|" + tok + "|" + kmin;
                if (!params[k]) params[k] = { opk: opk, oadr: oadr, tok: tok, kmin: kmin, script: sc };
            }
        } catch (e) {}
        // DISCOVERY depth bound (parity with native SENTINEL_SCAN_DEPTH) — bounded so a pathological pile can't
        // overflow, but near the full ~1700 cascade (~20h) so a pool stays discoverable for its whole life, not
        // just ~5.5h (the cross-device flicker fix). Safe now the coinnotify pile is removed (~8 KB unbounded).
        // PRESENT_BEACONS records each beacon's newest `created` block so the PROACTIVE re-announce (below) can
        // refresh a beacon once it passes REANNOUNCE_BLOCKS, BEFORE it leaves this wider window.
        MDS.cmd("coins simplestate:true order:desc depth:1500 address:" + SENTINEL, function (cres) {
            var coins = (cres && cres.status && Array.isArray(cres.response)) ? cres.response : [];
            for (var j = 0; j < coins.length; j++) {
                var c = coins[j];
                var t = readState(c, 2), o = readState(c, 3), pk = readState(c, 4), km = readState(c, 5);
                if (!t || !o || !pk || !km) continue;
                var abk = annKeySvc(pk, o, t, km);
                var cr = parseInt(c.created) || 0;
                if (!PRESENT_BEACONS[abk] || cr > PRESENT_BEACONS[abk]) PRESENT_BEACONS[abk] = cr;   // newest beacon block
                delete ANN_SVC[abk];           // confirmed back → allow a fresh re-announce when it next fades
                var key = pk + "|" + t + "|" + km;
                if (!params[key]) params[key] = { opk: pk, oadr: o, tok: t, kmin: km };
            }
            derive(params);
        });
    });
}

function derive(params) {
    var list = [];
    for (var k in params) if (params.hasOwnProperty(k)) list.push(params[k]);
    if (!list.length) { SCANNING = false; return; }
    var pools = [];
    var pending = list.length;
    function oneDone() { if (--pending === 0) fund(pools); }
    list.forEach(function (p) {
        var tracked = p.script || null;
        var script = tracked || covScript(p.opk, p.oadr, p.tok, p.kmin);
        MDS.cmd("runscript script:" + scriptArg(script), function (jr) {
            try {
                var resp = jr ? jr.response : null;
                if (resp && truthy(resp.parseok) && resp.script) {
                    pools.push({
                        opk: p.opk, oadr: p.oadr, tok: p.tok, kmin: p.kmin,
                        address: resp.script.address, covenantScript: tracked ? null : script,
                        reserveM: null, reserveT: null, coinidM: null, coinidT: null, reserveBlock: 0
                    });
                }
            } catch (e) {}
            oneDone();
        });
    });
}

function fund(pools) {
    if (!pools.length) { SCANNING = false; return; }
    var pending = pools.length;
    function oneDone() { if (--pending === 0) done(pools); }
    pools.forEach(function (pool) {
        MDS.cmd("coins address:" + pool.address, function (j) {
            var cs = (j && j.status && Array.isArray(j.response)) ? j.response : [];
            var mBlk = 0, tBlk = 0;   // created block of the kept coin per leg (for reserve age)
            for (var i = 0; i < cs.length; i++) {
                var c = cs[i];
                if (!c || c.spent === true) continue;
                var tid = c.tokenid || "";
                if (tid === "0x00") {
                    var m = c.amount || "0";
                    if (pool.reserveM === null || decCmp(m, pool.reserveM) > 0) { pool.reserveM = m; pool.coinidM = c.coinid || ""; mBlk = parseInt(c.created) || 0; }
                } else if (pool.tok && pool.tok.toLowerCase() === tid.toLowerCase()) {
                    var t = (c.tokenamount !== undefined ? c.tokenamount : (c.amount || "0"));
                    if (pool.reserveT === null || decCmp(t, pool.reserveT) > 0) { pool.reserveT = t; pool.coinidT = c.coinid || ""; tBlk = parseInt(c.created) || 0; pool.tokLabel = labelOf(c.token, tid); }
                }
            }
            pool.reserveBlock = Math.max(mBlk, tBlk);
            oneDone();
        });
    });
}

function labelOf(token, tid) {
    if (typeof token === "string") return token;
    if (token && typeof token === "object" && token.name) {
        if (typeof token.name === "object") return token.name.ticker || token.name.name || short(tid);
        if (typeof token.name === "string") return token.name;
    }
    return short(tid);
}
function short(s) { s = (s && s.indexOf("0x") === 0) ? s.substring(2) : (s || ""); return s.length > 8 ? s.substring(0, 8) + "…" : s; }
function isFunded(p) { return p.reserveM && p.reserveT && decCmp(p.reserveM, "0") > 0 && decCmp(p.reserveT, "0") > 0; }

function done(pools) {
    SCANNING = false;   // scan pipeline complete (this is the single terminal for a fully-run scan)
    var funded = [];
    for (var i = 0; i < pools.length; i++) {
        var p = pools[i];
        if (!isFunded(p)) continue;
        funded.push(p);
        // Track-on-discovery REMOVED (parity with native 0.9.14) — it grew the tracked set and hence the `scripts`
        // reply without bound, until it overflows the 256 KB cap. Already-tracked pools stay visible; new pools
        // stay discoverable via their fresh Source-2 beacon (kept alive by keep-fresh + the gossip mesh).
    }
    ingestFeed(funded);
    maybeReannounceSvc(funded);
    maybeRefreshSvc();   // sources its own owned pools from pp_ownpools (no longer the discovered set)
}

// ---------------------------------------------------------------- Layer 5: background faded-beacon re-announce
function annKeySvc(opk, oadr, tok, kmin) { return (opk + "|" + oadr + "|" + tok + "|" + kmin).toLowerCase(); }

// GOSSIP: for EVERY funded pool this node knows (its own + any it has discovered) whose beacon has FADED
// from the recent window, post ONE fresh beacon — so a pool created on a now-offline node stays discoverable
// to strangers' fresh nodes while its creator is away. Any node that has discovered a pool helps keep it
// alive → self-healing mesh. Throttled to every 6h; shuffled + capped per run so many nodes don't all
// re-beacon the same pools. Owner-WALLET funded, change back, spends NO covenant coin (the pool address is
// excluded from funding) and adds NO owner signature (sign auto only) — safe to do for a stranger's pool.
// Assumes the dapp has WRITE access; on a read-only node the txncheck gate simply never posts. NEVER megammr.
function maybeReannounceSvc(funded) {
    var now = Date.now();
    if (now - lastAnnTs < REANN_MS) return;   // throttle
    lastAnnTs = now;                          // stamp NOW → one sweep per interval regardless of outcome
    MDS.cmd("block", function (bj) {
        var tip = (bj && bj.status && bj.response) ? (parseInt(bj.response.block) || 0) : 0;
        var faded = [];
        funded.forEach(function (p) {
            if (!p || !p.address || !p.opk || !p.oadr || !p.tok || !p.kmin || !isFunded(p)) return;   // funded only (never a closed pool)
            var k = annKeySvc(p.opk, p.oadr, p.tok, p.kmin);
            if (ANN_SVC[k]) return;                        // a re-announce already in flight
            var bcreated = PRESENT_BEACONS[k];
            // Re-announce if the beacon is ABSENT, or PROACTIVELY once it is older than REANNOUNCE_BLOCKS — BEFORE
            // it would leave the depth:1500 discovery window (so it never lapses on any node). Unknown tip → skip.
            if (bcreated && !(tip > 0 && (tip - bcreated) > REANNOUNCE_BLOCKS)) return;
            faded.push({ p: p, k: k });
        });
        if (!faded.length) return;
        shuffleArr(faded);
        if (faded.length > MAX_ANN_PER_RUN) faded = faded.slice(0, MAX_ANN_PER_RUN);
        faded.forEach(function (f) {
            ANN_SVC[f.k] = true;   // in-flight guard; CLEARED on failure below, and cleared in scan() when the beacon
                                   // reappears young — so a later re-fade re-announces.
            reannounceSvc({ address: f.p.address, opk: f.p.opk, oadr: f.p.oadr, tok: f.p.tok, kmin: f.p.kmin }, f.k);
        });
    });
}
function shuffleArr(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } }

function reannounceSvc(p, key) {
    // On any failure, re-open the key so the NEXT sweep retries (a one-shot skip would defeat background upkeep).
    // On success, ANN_SVC[key] stays set until the beacon confirms back into the window (scan() clears it then).
    function giveUp(txid) { if (txid) MDS.cmd("txndelete id:" + txid, function () {}); delete ANN_SVC[key]; }
    MDS.cmd("coins relevant:true sendable:true tokenid:0x00", function (res) {
        var arr = (res && res.status && Array.isArray(res.response)) ? res.response : [];
        var excl = p.address.toLowerCase(), best = null;
        for (var i = 0; i < arr.length; i++) {                      // largest wallet MINIMA coin, never the covenant address
            var c = arr[i]; if (!c || (c.address || "").toLowerCase() === excl) continue;
            if (!best || decCmp(c.amount || "0", best.amount || "0") > 0) best = c;
        }
        if (!best || decCmp(best.amount || "0", ANNOUNCE_DUST) < 0) { giveUp(null); return; }   // no spare MINIMA → retry later
        var txid = "ppannsvc_" + (Date.now()) + "_" + (++annCounter);
        var cmds = ["txncreate id:" + txid, "txninput id:" + txid + " coinid:" + best.coinid];
        cmds.push("txnoutput id:" + txid + " amount:" + ANNOUNCE_DUST + " address:" + SENTINEL + " storestate:true");
        var change = decSub(best.amount, ANNOUNCE_DUST);
        if (decCmp(change, "0") > 0) cmds.push("txnoutput id:" + txid + " amount:" + change + " address:" + best.address + " storestate:false");
        cmds.push("txnstate id:" + txid + " port:0 value:" + p.opk);
        cmds.push("txnstate id:" + txid + " port:1 value:" + VERSION_HEX);
        cmds.push("txnstate id:" + txid + " port:2 value:" + p.tok);
        cmds.push("txnstate id:" + txid + " port:3 value:" + p.oadr);
        cmds.push("txnstate id:" + txid + " port:4 value:" + p.opk);
        cmds.push("txnstate id:" + txid + " port:5 value:" + p.kmin);
        cmds.push("txnsign id:" + txid + " publickey:auto");   // funding coin only — no $OPK, no covenant coin
        cmds.push("txnbasics id:" + txid);
        runCmds(cmds, 0, function (okChain) {
            if (!okChain) { giveUp(txid); return; }
            MDS.cmd("txncheck id:" + txid, function (rc) {
                var resp = rc ? rc.response : null, v = resp ? resp.valid : null;
                // gate exactly like poolmgr.finalize: valid.scripts (covenant verdict) + validamounts + valid.mmrproofs
                if (!(v && truthy(v.scripts) && truthy(resp.validamounts) && truthy(v.mmrproofs))) { giveUp(txid); return; }
                MDS.cmd("txnpost id:" + txid, function () { MDS.cmd("txndelete id:" + txid, function () {}); });   // posted → keep ANN_SVC[key] until the beacon reappears
            });
        });
    });
}

// ---------------------------------------------------------------- KEEP-FRESH (background): recreate MY aging reserves
// For each of MY pools (pp_ownpools) whose reserves are aging toward the ~1700-block cascade edge, recreate them in
// place (owner grow-in-place, same amounts + a fresh beacon — an owner-signed deposit(0)) so they stay young and every
// light node keeps seeing + trading them. OWNER-ONLY (spends the covenant, needs $OPK) — unlike the node-wide beacon
// gossip. Mirrors native PoolRefresher / the page's maybeRefresh. Assumes WRITE access (like the bg re-announce);
// txncheck gate never posts on a read-only node. The page + service use separate in-context guards → at most a
// duplicate refresh whose double-spent inputs are rejected at consensus (fund-safe).
// Largest coin per leg at the covenant address = the true reserve (a dust coin can't masquerade); record the
// newest kept-coin block for the reserve age. Same selection as the discovery fund() — mirrors native fillReserves.
function fillReservesSvc(pool, j) {
    var cs = (j && j.status && Array.isArray(j.response)) ? j.response : [];
    var mBlk = 0, tBlk = 0;
    for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (!c || c.spent === true) continue;
        var tid = c.tokenid || "";
        if (tid === "0x00") {
            var m = c.amount || "0";
            if (pool.reserveM === null || decCmp(m, pool.reserveM) > 0) { pool.reserveM = m; pool.coinidM = c.coinid || ""; mBlk = parseInt(c.created) || 0; }
        } else if (pool.tok && pool.tok.toLowerCase() === tid.toLowerCase()) {
            var t = (c.tokenamount !== undefined ? c.tokenamount : (c.amount || "0"));
            if (pool.reserveT === null || decCmp(t, pool.reserveT) > 0) { pool.reserveT = t; pool.coinidT = c.coinid || ""; tBlk = parseInt(c.created) || 0; }
        }
    }
    pool.reserveBlock = Math.max(mBlk, tBlk);
}

// KEEP-FRESH driven from the DURABLE pp_ownpools recipes + a per-covenant reserve scan — NOT the general
// discovery set. So an owned pool is refreshed while it's still young enough even if the registry scan
// momentarily didn't surface it (a discovery hiccup no longer lets a pool silently age out). Mirrors native
// 0.9.14 PoolRefresher.refreshAgingFromScan reading OwnPoolStore. The refresh tx (refreshSvc) is unchanged.
function maybeRefreshSvc() {
    var now = Date.now();
    if (now - lastRefreshTs < REFRESH_MS) return;   // throttle
    lastRefreshTs = now;
    MDS.sql("SELECT * FROM pp_ownpools", function (r) {
        var recipes = (r && r.status && r.rows) ? r.rows : [];
        if (!recipes.length) return;   // not an LP node → nothing of mine to refresh
        MDS.cmd("block", function (bj) {
            var tip = (bj && bj.status && bj.response) ? (parseInt(bj.response.block) || 0) : 0;
            if (!tip) return;
            var t = Date.now(), pending = recipes.length, aging = [];
            function fire() {
                if (--pending > 0) return;
                if (!aging.length) return;
                shuffleArr(aging);
                if (aging.length > MAX_REFRESH_PER_RUN) aging = aging.slice(0, MAX_REFRESH_PER_RUN);
                aging.forEach(function (p) { REFRESH_SVC[p.address.toLowerCase()] = Date.now(); refreshSvc(p); });
            }
            recipes.forEach(function (row) {
                var p = { address: row.ADDRESS, opk: row.OPK, oadr: row.OADR, tok: row.TOK, kmin: row.KMIN,
                          reserveM: null, reserveT: null, coinidM: null, coinidT: null, reserveBlock: 0 };
                if (!p.address || !p.opk || !p.oadr || !p.tok || !p.kmin) { fire(); return; }
                var a = p.address.toLowerCase();
                if (REFRESH_SVC[a] && (t - REFRESH_SVC[a]) < REFRESH_TTL_MS) { fire(); return; }   // already refreshing
                MDS.cmd("coins address:" + p.address, function (j) {
                    fillReservesSvc(p, j);
                    if (isFunded(p) && p.coinidM && p.coinidT) {
                        var age = (p.reserveBlock > 0) ? (tip - p.reserveBlock) : Infinity;   // unknown age → refresh
                        if (age > REFRESH_BLOCKS) aging.push(p);
                    }
                    fire();
                });
            });
        });
    });
}

function refreshSvc(p) {
    var a = p.address.toLowerCase();
    function giveUp(txid) { if (txid) MDS.cmd("txndelete id:" + txid, function () {}); delete REFRESH_SVC[a]; }   // allow a retry next sweep
    // register the covenant (idempotent) so txnbasics can attach its script, then fund the beacon dust + build
    MDS.cmd("newscript trackall:true script:" + scriptArg(covScript(p.opk, p.oadr, p.tok, p.kmin)), function () {
        MDS.cmd("coins relevant:true sendable:true tokenid:0x00", function (res) {
            var arr = (res && res.status && Array.isArray(res.response)) ? res.response : [];
            var best = null;
            for (var i = 0; i < arr.length; i++) {                          // largest wallet MINIMA coin, never the covenant address
                var c = arr[i]; if (!c || (c.address || "").toLowerCase() === a) continue;
                if (!best || decCmp(c.amount || "0", best.amount || "0") > 0) best = c;
            }
            if (!best || decCmp(best.amount || "0", ANNOUNCE_DUST) < 0) { giveUp(null); return; }   // no spare MINIMA → retry later
            var tokArg = " tokenid:" + p.tok;
            var txid = "pprefsvc_" + (Date.now()) + "_" + (++refreshCounter);
            var cmds = ["txncreate id:" + txid];
            cmds.push("txninput id:" + txid + " coinid:" + p.coinidM);   // 0 pool MINIMA (even)
            cmds.push("txninput id:" + txid + " coinid:" + p.coinidT);   // 1 pool token  (odd)
            cmds.push("txninput id:" + txid + " coinid:" + best.coinid); // beacon dust funding
            // outputs 0/1 recreate the SAME reserves at the SAME address (owner grow branch; GTE holds at equality)
            cmds.push("txnoutput id:" + txid + " amount:" + p.reserveM + " address:" + p.address + " storestate:false");
            cmds.push("txnoutput id:" + txid + " amount:" + p.reserveT + " address:" + p.address + tokArg + " storestate:false");
            cmds.push("txnoutput id:" + txid + " amount:" + ANNOUNCE_DUST + " address:" + SENTINEL + " storestate:true");   // fresh beacon
            var change = decSub(best.amount, ANNOUNCE_DUST);
            if (decCmp(change, "0") > 0) cmds.push("txnoutput id:" + txid + " amount:" + change + " address:" + best.address + " storestate:false");
            cmds.push("txnstate id:" + txid + " port:0 value:" + p.opk);
            cmds.push("txnstate id:" + txid + " port:1 value:" + VERSION_HEX);
            cmds.push("txnstate id:" + txid + " port:2 value:" + p.tok);
            cmds.push("txnstate id:" + txid + " port:3 value:" + p.oadr);
            cmds.push("txnstate id:" + txid + " port:4 value:" + p.opk);
            cmds.push("txnstate id:" + txid + " port:5 value:" + p.kmin);
            cmds.push("txnsign id:" + txid + " publickey:auto");        // funding coin
            cmds.push("txnsign id:" + txid + " publickey:" + p.opk);    // owner grow branch
            cmds.push("txnbasics id:" + txid);
            runCmds(cmds, 0, function (okChain) {
                if (!okChain) { giveUp(txid); return; }
                MDS.cmd("txncheck id:" + txid, function (rc) {
                    var resp = rc ? rc.response : null, v = resp ? resp.valid : null;
                    // gate exactly like the beacon path: valid.scripts (covenant verdict) + validamounts + valid.mmrproofs
                    if (!(v && truthy(v.scripts) && truthy(resp.validamounts) && truthy(v.mmrproofs))) { giveUp(txid); return; }
                    MDS.cmd("txnpost id:" + txid, function () { MDS.cmd("txndelete id:" + txid, function () {}); });   // posted → new coins are young → the aging gate stops a re-fire
                });
            });
        });
    });
}

// sequential command runner — abort (cb false) on the first non-success (matches poolmgr.js runChain)
function runCmds(cmds, i, cb) {
    if (i >= cmds.length) { cb(true); return; }
    MDS.cmd(cmds[i], function (res) {
        if (!res || res.status !== true) { cb(false); return; }
        runCmds(cmds, i + 1, cb);
    });
}

// ---------------------------------------------------------------- GlobalFeed ingest (shares pp_feed / pp_kv)
function ingestFeed(pools) {
    var firstScan = !PRIMED;
    MDS.sql("SELECT v FROM pp_kv WHERE k='snap'", function (r) {
        var snap = {};
        if (r && r.status && r.rows && r.rows.length) { try { snap = JSON.parse(r.rows[0].V) || {}; } catch (e) { snap = {}; } }
        var seen = {}, seenCount = 0, now = Date.now(), inserts = [];
        for (var i = 0; i < pools.length; i++) {
            var p = pools[i];
            if (!isFunded(p)) continue;
            var addr = p.address.toLowerCase();
            seen[addr] = true; seenCount++;
            var prevEnc = snap[addr];
            var label = p.tokLabel || short(p.tok);
            var firstSeen = !SESSION_SEEN[addr];
            SESSION_SEEN[addr] = true;
            snap[addr] = encSnap(p.reserveM, p.reserveT, label, 0);   // fresh reading, miss reset
            if (firstSeen) {
                // First sighting this service session — never diff a snapshot that may predate a restart. A pool
                // with no persisted snapshot appearing AFTER the first scan is genuinely new → CREATE; the first
                // scan, or a pool carried over from a prior session, reseeds silently.
                if (!firstScan && prevEnc === undefined)
                    inserts.push({ pool: addr, label: label, kind: "CREATE", min: 1, m: p.reserveM, t: p.reserveT, price: "0", ts: now });
                continue;
            }
            var prev = decSnap(prevEnc);   // prevEnc is from THIS session → safe to diff
            if (!prev) continue;
            var cm = decCmp(p.reserveM, prev.m), ct = decCmp(p.reserveT, prev.t);
            if (cm > 0 && ct < 0) {                 // SWAP — MINIMA in, token out
                var dm1 = decSub(p.reserveM, prev.m), dt1 = decSub(prev.t, p.reserveT);
                inserts.push({ pool: addr, label: label, kind: "SWAP", min: 1, m: dm1, t: dt1, price: decDiv(dt1, dm1, 12), ts: now });
            } else if (cm < 0 && ct > 0) {          // SWAP — token in, MINIMA out
                var dm2 = decSub(prev.m, p.reserveM), dt2 = decSub(p.reserveT, prev.t);
                inserts.push({ pool: addr, label: label, kind: "SWAP", min: 0, m: dm2, t: dt2, price: decDiv(dt2, dm2, 12), ts: now });
            } else if (cm > 0 && ct > 0) {          // ADD — both reserves up
                inserts.push({ pool: addr, label: label, kind: "ADD", min: 1, m: decSub(p.reserveM, prev.m), t: decSub(p.reserveT, prev.t), price: "0", ts: now });
            } else if (cm < 0 && ct < 0) {          // WITHDRAW (partial) — both reserves down
                inserts.push({ pool: addr, label: label, kind: "WITHDRAW", min: 0, m: decSub(prev.m, p.reserveM), t: decSub(prev.t, p.reserveT), price: "0", ts: now });
            }
        }
        // Only a scan that actually saw pools consumes the "first scan", so a fully-EMPTY first scan (node
        // still connecting) can't make a pool first seen on scan 2 look brand-new. A partial first scan can
        // still emit one phantom CREATE for a pool it missed — display-only, fresh-install-only, matches native.
        if (seenCount > 0) PRIMED = true;
        // Vanished pools → a real close (reserves fully drained; a once-seen pool stays discoverable via its
        // tracked contract, so a vanish is a drain not a beacon-fade). 2-scan grace for a transient miss; skip
        // the whole pass on the first scan (no wipe) and on an all-empty scan (systemic hiccup, no mass-close).
        if (!firstScan && seenCount > 0) {
            for (var kk in snap) {
                if (!snap.hasOwnProperty(kk) || seen[kk]) continue;
                var s = decSnap(snap[kk]);
                if (!s) { delete snap[kk]; continue; }
                if (s.miss + 1 >= MISS_CLOSE) {
                    inserts.push({ pool: kk, label: s.label, kind: "WITHDRAW", min: 0, m: s.m, t: s.t, price: "0", ts: now });
                    delete snap[kk];
                } else {
                    snap[kk] = encSnap(s.m, s.t, s.label, s.miss + 1);   // grace: keep one more scan
                }
            }
        }
        saveSnap(snap);
        inserts.forEach(function (ev) {
            MDS.sql("INSERT INTO pp_feed (pool, tokenlabel, kind, minimain, minimaamt, tokenamt, price, ts) VALUES ('" +
                esc(ev.pool) + "','" + esc(ev.label) + "','" + ev.kind + "'," + ev.min + ",'" + esc(ev.m) + "','" + esc(ev.t) + "','" + esc(ev.price) + "'," + ev.ts + ")");
        });
        if (inserts.length) trimFeed();
    });
}
// Snapshot value = "m|t|miss|label" (label sanitized of '|'). Backward-compatible with the old "m|t" form.
function sanitizeLabel(l) { return String(l == null ? "" : l).split("|").join("/"); }
function encSnap(m, t, label, miss) { return m + "|" + t + "|" + miss + "|" + sanitizeLabel(label); }
function decSnap(enc) {
    if (enc === undefined || enc === null) return null;
    var parts = String(enc).split("|");
    if (parts.length < 2) return null;
    return { m: parts[0], t: parts[1], miss: parts.length > 2 ? (parseInt(parts[2], 10) || 0) : 0, label: parts.length > 3 ? parts.slice(3).join("|") : "" };
}
function saveSnap(snap) {
    var v = esc(JSON.stringify(snap));
    MDS.sql("DELETE FROM pp_kv WHERE k='snap'", function () { MDS.sql("INSERT INTO pp_kv (k, v) VALUES ('snap','" + v + "')"); });
}
function trimFeed() {
    MDS.sql("SELECT id FROM pp_feed ORDER BY id DESC LIMIT 1 OFFSET " + FEED_MAX, function (r) {
        if (r && r.status && r.rows && r.rows.length) MDS.sql("DELETE FROM pp_feed WHERE id <= " + (parseInt(r.rows[0].ID) || 0));
    });
}
function esc(v) { return String(v).replace(/'/g, "''"); }
