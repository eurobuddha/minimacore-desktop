/*
 * book.js — PoolBook: the JS port of PoolBook.java. Discovers pools from the shared PANDAPOOLS registry
 * (trust-nothing): scan two sources, RE-DERIVE each pool's covenant address from its params (never trust
 * the announce blindly — the covenant address IS the proof), then scan that address for the two reserve
 * coins. A forged announce can at worst point at a real-but-bad pool, which the reserve/price filters drop.
 *
 * Source 1 (GTC): this node's OWN tracked pool contracts (`scripts`) — a spendable contract NEVER prunes,
 *   so the creator's pools stay enumerable forever, independent of the (prunable) announce beacon.
 * Source 2: the registry announce beacons (`coins ... address:SENTINEL`) — discovers OTHER creators' pools.
 *
 * Track-on-discovery: a newly-seen registry pool's covenant is `newscript trackall`-ed once confirmed
 * funded, so it becomes a Source-1 tracked contract and stays GTC-visible + swappable on THIS node forever.
 */
var Book = (function () {

    var SENTINEL = Covenant.SENTINEL;

    // Literal extractors for a PandaPools covenant (recover a pool from a tracked contract script).
    var P_OPK = /SIGNEDBY\((0x[0-9A-Fa-f]+)\)/;
    var P_OADR = /VERIFYOUT\(@INPUT (0x[0-9A-Fa-f]+) @AMOUNT/;
    var P_TOK = /GETINTOK\(s\) EQ (0x[0-9A-Fa-f]+)/;
    var P_KMIN = /GTE MAX\(x\*y ([0-9.]+)\)/;

    function group(re, s) { var m = re.exec(s); return m ? m[1] : null; }

    /** Read a coin's state at `port`, handling BOTH encodings: object {"2":v} and array [{port,data}]. */
    function readState(coin, port) {
        if (!coin) return null;
        var st = coin.state;
        if (!st) return null;
        if (Array.isArray(st)) {
            for (var i = 0; i < st.length; i++) {
                var e = st[i];
                if (e && (e.port === port || String(e.port) === String(port))) {
                    var d = e.data || "";
                    return d === "" ? null : d;
                }
            }
            return null;
        }
        if (typeof st === "object") {
            var v = st[String(port)];
            return (v === undefined || v === null || v === "") ? null : v;
        }
        return null;
    }

    /** Scan the registry → discover + fund every pool → cb(pools). */
    function scan(cb) {
        // Straight to discovery — do NOT `coinnotify action:add` the sentinel (transient NOTIFYCOIN listener we
        // never consume; discovery reads the recent chain via the depth-bounded scan below). Parity with native 0.9.14.
        gatherOwned(cb);
    }

    function gatherOwned(cb) {
        var params = {};        // key "opk|tok|kmin" -> {opk,oadr,tok,kmin,script?}
        MDS.cmd("scripts", function (res) {
            try { parseScripts(res, params); } catch (e) {}
            gatherRegistry(params, cb);
        });
    }

    function parseScripts(res, params) {
        var arr = (res && res.status && Array.isArray(res.response)) ? res.response : null;
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
            var s = arr[i];
            var sc = s ? (s.script || "") : "";
            if (sc.indexOf("VERIFYOUT(@INPUT @ADDRESS") < 0 || sc.indexOf("GTE MAX(x*y") < 0) continue;
            var opk = group(P_OPK, sc), oadr = group(P_OADR, sc), tok = group(P_TOK, sc), kmin = group(P_KMIN, sc);
            if (!opk || !oadr || !tok || !kmin) continue;
            var key = opk + "|" + tok + "|" + kmin;
            // carry the ACTUAL tracked covenant script — derivePools runscripts it to confirm it compiles
            // and get its address; a non-parsing (corrupt) script is filtered there.
            if (!params[key]) params[key] = { opk: opk, oadr: oadr, tok: tok, kmin: kmin, script: sc };
        }
    }

    function gatherRegistry(params, cb) {
        // DISCOVERY depth bound (parity with native SENTINEL_SCAN_DEPTH). Kept bounded so a pathological sentinel
        // pile can't overflow, but set NEAR the full ~1700 cascade (~20h) so a pool stays discoverable for its
        // whole life, not just ~5.5h — the cross-device flicker fix. Safe now that the coinnotify pile is removed:
        // the sentinel reply measured ~8 KB even unbounded (13 beacons).
        MDS.cmd("coins simplestate:true order:desc depth:1500 address:" + SENTINEL, function (res) {
            var coins = (res && res.status && Array.isArray(res.response)) ? res.response : [];
            for (var i = 0; i < coins.length; i++) {
                var c = coins[i];
                var tok = readState(c, 2), oadr = readState(c, 3), opk = readState(c, 4), kmin = readState(c, 5);
                if (!tok || !oadr || !opk || !kmin) continue;
                var key = opk + "|" + tok + "|" + kmin;
                if (!params[key]) params[key] = { opk: opk, oadr: oadr, tok: tok, kmin: kmin };   // tracked wins (putIfAbsent)
            }
            finishScan(params, cb);
        });
    }

    function finishScan(params, cb) {
        var list = [];
        for (var k in params) if (params.hasOwnProperty(k)) list.push(params[k]);
        if (list.length === 0) { cb([]); return; }
        derivePools(list, cb);
    }

    /** For each param set, re-derive the pool address via runscript (parseok gate), then scan reserves. */
    function derivePools(list, cb) {
        var pools = [];
        var pending = list.length;
        function oneDone() { if (--pending === 0) fund(pools, cb); }

        list.forEach(function (p) {
            var tracked = p.script || null;
            var script;
            if (tracked) script = tracked;
            else {
                try { script = Covenant.script(p.opk, p.oadr, p.tok, p.kmin); }
                catch (e) { oneDone(); return; }
            }
            MDS.cmd("runscript script:" + Covenant.scriptArg(script), function (j) {
                try {
                    var resp = j ? j.response : null;
                    // ONLY surface a covenant that actually compiles — a non-parsing script's coins are
                    // permanently unspendable, so it must never appear as a live/routable/closeable pool.
                    if (resp && PP.truthy(resp.parseok) && resp.script) {
                        pools.push({
                            opk: p.opk, oadr: p.oadr, tok: p.tok, kmin: p.kmin,
                            address: resp.script.address,
                            mxaddress: resp.script.mxaddress || "",
                            // registry-discovered (not already tracked) → remember its covenant so done() can
                            // track it once confirmed funded (track-on-discovery).
                            covenantScript: tracked ? null : script,
                            tokName: null, tokDecimals: 8,
                            reserveM: null, coinidM: null, reserveT: null, coinidT: null,
                            reserveBlock: 0   // created block of the reserve coins (keep-fresh age anchor; 0 = unknown)
                        });
                    }
                } catch (e) {}
                oneDone();
            });
        });
    }

    /** Scan each derived pool address for its two reserve coins (largest per leg = the real reserve). */
    function fund(pools, cb) {
        if (pools.length === 0) { cb([]); return; }
        var pending = pools.length;
        function oneDone() { if (--pending === 0) done(pools, cb); }

        pools.forEach(function (pool) {
            MDS.cmd("coins address:" + pool.address, function (j) {
                var cs = (j && j.status && Array.isArray(j.response)) ? j.response : [];
                var mBlk = 0, tBlk = 0;   // created block of the kept coin per leg (for reserve age)
                for (var i = 0; i < cs.length; i++) {
                    var c = cs[i];
                    if (!c || c.spent === true) continue;
                    var tid = c.tokenid || "";
                    if (tid === "0x00") {
                        var amtM = PP.dec(c.amount || "0");
                        if (pool.reserveM === null || amtM.gt(pool.reserveM)) {   // keep the LARGEST (ignore forged dust)
                            pool.reserveM = amtM; pool.coinidM = c.coinid || ""; mBlk = parseInt(c.created) || 0;
                        }
                    } else if (pool.tok && pool.tok.toLowerCase() === tid.toLowerCase()) {
                        var amtT = PP.dec(c.tokenamount !== undefined ? c.tokenamount : (c.amount || "0"));
                        if (pool.reserveT === null || amtT.gt(pool.reserveT)) {
                            pool.reserveT = amtT; pool.coinidT = c.coinid || ""; tBlk = parseInt(c.created) || 0;
                            pool.tokName = PP.tokenName(c.token, tid);
                            pool.tokDecimals = PP.tokenDecimals(c.token);
                        }
                    }
                }
                pool.reserveBlock = Math.max(mBlk, tBlk);   // most-recent recreate = the pool's reserve age anchor
                oneDone();
            });
        });
    }

    function done(pools, cb) {
        var funded = [];
        for (var i = 0; i < pools.length; i++) {
            var p = pools[i];
            if (!Curve.funded(p)) continue;
            funded.push(p);
            // Track-on-discovery REMOVED (parity with native 0.9.14): it grew the node's tracked set — and hence
            // the `scripts` reply (Source 1) — without bound, until that reply overflows the 256 KB cap. Pools
            // already tracked stay visible; newly-seen pools stay discoverable via their fresh Source-2 beacon
            // (kept alive by keep-fresh + the gossip mesh). Freezes `scripts` growth with no discovery loss.
        }
        cb(funded);
    }

    return { SENTINEL: SENTINEL, scan: scan, readState: readState };
})();
