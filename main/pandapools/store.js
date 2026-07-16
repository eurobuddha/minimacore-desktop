/*
 * store.js — local persistence via MDS SQL, mirroring the native SharedPreferences stores:
 *   LpStore      → pp_lp        : per-pool opening reserves + a fee-baseline product K (fees / IL / age).
 *   ActivityLog  → pp_activity  : this device's create/swap/deposit/migrate/close lifecycle
 *                                 (type, summary, txpowid, submitblock, status, ts) — the immediate
 *                                 "confirming n/3…" feedback layer before the node's own history catches up.
 *   GlobalFeed   → pp_feed (+ pp_kv snapshot) : a live feed of ALL pool swaps (incl. other people's),
 *                                 detected from the constant-product signature (one reserve up, one down).
 *
 * Tables are created with the "SELECT 1 … then CREATE if missing" pattern so a normal run never triggers a
 * pending SQL prompt on a restricted MDS. All writes are best-effort/fire-and-forget; reads take callbacks.
 */
var Store = (function () {
    var D = Decimal;
    var ready = false;
    var FEED_MAX = 100;
    var ACT_MAX = 120;

    function esc(v) { return String(v).replace(/'/g, "''"); }

    // ---------------------------------------------------------------- init
    function init(cb) {
        // probe one table; only CREATE the set if missing (avoids pending prompts)
        MDS.sql("SELECT 1 FROM pp_activity LIMIT 1", function (r) {
            function fin() { migrateFeedKind(function () { migrateActivityRefaddr(function () { ensureOwnPools(function () { ready = true; if (cb) cb(); }); }); }); }
            if (r && r.status) { fin(); return; }
            create(fin);
        });
    }
    // Add the `refaddr` column (a CREATE's covenant address) to a pp_activity created before this build. Probe
    // first so a normal run never issues the ALTER; a duplicate ALTER (page vs service race) errors harmlessly.
    function migrateActivityRefaddr(cb) {
        MDS.sql("SELECT refaddr FROM pp_activity LIMIT 1", function (r) {
            if (r && r.status) { cb(); return; }
            MDS.sql("ALTER TABLE pp_activity ADD COLUMN refaddr varchar(80)", function () { cb(); });
        });
    }
    // Ensure pp_ownpools exists for a pre-0.3.0 install (created before this table existed). Probe first so a
    // normal run never issues a CREATE (avoids a pending SQL prompt on a restricted MDS).
    function ensureOwnPools(cb) {
        MDS.sql("SELECT 1 FROM pp_ownpools LIMIT 1", function (r) {
            if (r && r.status) { cb(); return; }
            MDS.sql(
                "CREATE TABLE IF NOT EXISTS `pp_ownpools` (" +
                " `address` varchar(80) NOT NULL PRIMARY KEY, `mx` varchar(80)," +
                " `opk` varchar(140) NOT NULL, `oadr` varchar(80) NOT NULL, `tok` varchar(80) NOT NULL," +
                " `tdec` int NOT NULL, `kmin` varchar(120) NOT NULL, `script` text)", function () { cb(); });
        });
    }
    // Add the lifecycle `kind` column to a pp_feed created by a pre-0.2.0 install (default SWAP so old rows
    // render). The page and the headless service both run this; a duplicate ALTER from the loser errors
    // harmlessly (swallowed). The SELECT succeeds once the column exists, so it's a one-time change either way.
    function migrateFeedKind(cb) {
        MDS.sql("SELECT kind FROM pp_feed LIMIT 1", function (r) {
            if (r && r.status) { cb(); return; }
            MDS.sql("ALTER TABLE pp_feed ADD COLUMN kind varchar(12) DEFAULT 'SWAP'", function () { cb(); });
        });
    }

    function create(cb) {
        MDS.sql(
            "CREATE TABLE IF NOT EXISTS `pp_lp` (" +
            " `address` varchar(80) NOT NULL PRIMARY KEY," +
            " `initm` varchar(90) NOT NULL," +
            " `initt` varchar(90) NOT NULL," +
            " `feebase` varchar(120) NOT NULL," +
            " `block` int NOT NULL)", function () {
            MDS.sql(
                "CREATE TABLE IF NOT EXISTS `pp_activity` (" +
                " `id` bigint auto_increment," +
                " `type` varchar(16) NOT NULL," +
                " `summary` varchar(400) NOT NULL," +
                " `txpowid` varchar(80)," +
                " `submitblock` int NOT NULL," +
                " `status` varchar(12) NOT NULL," +      // 'ok' | 'confirmed' | 'failed'
                " `failmsg` varchar(400)," +
                " `refaddr` varchar(80)," +              // a CREATE's covenant address (verified via its reserves)
                " `ts` bigint NOT NULL)", function () {
                MDS.sql(
                    "CREATE TABLE IF NOT EXISTS `pp_feed` (" +
                    " `id` bigint auto_increment," +
                    " `pool` varchar(80) NOT NULL," +
                    " `tokenlabel` varchar(80) NOT NULL," +
                    " `kind` varchar(12) NOT NULL DEFAULT 'SWAP'," +
                    " `minimain` int NOT NULL," +
                    " `minimaamt` varchar(90) NOT NULL," +
                    " `tokenamt` varchar(90) NOT NULL," +
                    " `price` varchar(90) NOT NULL," +
                    " `ts` bigint NOT NULL)", function () {
                    MDS.sql(
                        "CREATE TABLE IF NOT EXISTS `pp_kv` (" +
                        " `k` varchar(64) NOT NULL PRIMARY KEY," +
                        " `v` text NOT NULL)", function () {
                        MDS.sql(
                            "CREATE TABLE IF NOT EXISTS `pp_ownpools` (" +
                            " `address` varchar(80) NOT NULL PRIMARY KEY," +
                            " `mx` varchar(80)," +
                            " `opk` varchar(140) NOT NULL," +
                            " `oadr` varchar(80) NOT NULL," +
                            " `tok` varchar(80) NOT NULL," +
                            " `tdec` int NOT NULL," +
                            " `kmin` varchar(120) NOT NULL," +
                            " `script` text)", function () { if (cb) cb(); });
                    });
                });
            });
        });
    }

    // ---------------------------------------------------------------- LpStore
    var LP_MC = { precision: 30, rounding: D.ROUND_DOWN };
    function lpRecord(address, initM, initT, block) {
        if (!ready || !address) return;
        var m = PP.dec(initM), t = PP.dec(initT);
        var fk = m.times(t);
        upsertLp(address, m, t, fk, block);
    }
    function lpUpdateFeeBase(address, newM, newT) {
        if (!ready || !address) return;
        lpGet(address, function (s) {
            if (!s) return;
            upsertLp(address, s.initM, s.initT, PP.dec(newM).times(PP.dec(newT)), s.block);
        });
    }
    function upsertLp(address, m, t, fk, block) {
        var a = esc(address.toLowerCase());
        MDS.sql("DELETE FROM pp_lp WHERE address='" + a + "'", function () {
            MDS.sql("INSERT INTO pp_lp (address, initm, initt, feebase, block) VALUES ('" +
                a + "','" + esc(PP.amt(m)) + "','" + esc(PP.amt(t)) + "','" + esc(PP.amt(fk)) + "'," + (parseInt(block) || 0) + ")");
        });
    }
    function lpRemove(address) {
        if (!ready || !address) return;
        MDS.sql("DELETE FROM pp_lp WHERE address='" + esc(address.toLowerCase()) + "'");
    }
    function lpGet(address, cb) {
        if (!ready || !address) { cb(null); return; }
        MDS.sql("SELECT * FROM pp_lp WHERE address='" + esc(address.toLowerCase()) + "'", function (r) {
            if (!r || !r.status || !r.rows || !r.rows.length) { cb(null); return; }
            var row = r.rows[0];
            var m = PP.decOr(row.INITM, 0), t = PP.decOr(row.INITT, 0);
            cb({
                initM: m, initT: t,
                initPrice: (m.gt(0)) ? t.div(m) : new D(0),
                feeBaseK: PP.decOr(row.FEEBASE, m.times(t)),
                block: parseInt(row.BLOCK) || 0
            });
        });
    }

    // ---------------------------------------------------------------- ActivityLog
    function actRecord(type, summary, txpowid, submitBlock, refaddr) {
        if (!ready) return;
        MDS.sql("INSERT INTO pp_activity (type, summary, txpowid, submitblock, status, failmsg, refaddr, ts) VALUES ('" +
            esc(type) + "','" + esc(summary) + "','" + esc(txpowid || "") + "'," + (parseInt(submitBlock) || 0) +
            ",'ok','','" + esc(refaddr || "") + "', " + Date.now() + ")", function () { trimActivity(); });
    }
    function actRecordFailed(type, summary, failMsg) {
        if (!ready) return;
        MDS.sql("INSERT INTO pp_activity (type, summary, txpowid, submitblock, status, failmsg, ts) VALUES ('" +
            esc(type) + "','" + esc(summary) + "','',0,'failed','" + esc(failMsg || "") + "', " + Date.now() + ")", function () { trimActivity(); });
    }
    function trimActivity() {
        MDS.sql("SELECT id FROM pp_activity ORDER BY id DESC LIMIT 1 OFFSET " + ACT_MAX, function (r) {
            if (r && r.status && r.rows && r.rows.length) MDS.sql("DELETE FROM pp_activity WHERE id <= " + (parseInt(r.rows[0].ID) || 0));
        });
    }
    /** cb(entries[]) newest first. Each: {type,summary,txpowid,submitBlock,ts,failed,failMsg}. */
    function actList(limit, cb) {
        if (!ready) { cb([]); return; }
        MDS.sql("SELECT * FROM pp_activity ORDER BY id DESC LIMIT " + (limit || ACT_MAX), function (r) {
            var out = [];
            if (r && r.status && r.rows) r.rows.forEach(function (row) {
                out.push({
                    type: row.TYPE, summary: row.SUMMARY,
                    txpowid: row.TXPOWID || "", submitBlock: parseInt(row.SUBMITBLOCK) || 0,
                    ts: parseInt(row.TS) || 0, failed: row.STATUS === "failed", failMsg: row.FAILMSG || "",
                    refaddr: row.REFADDR || "",                    // a CREATE's covenant address, for reserve verification
                    confirmedOnchain: row.STATUS === "confirmed"   // verified: pool reserves landed on-chain
                });
            });
            cb(out);
        });
    }
    var CONFIRM_BLOCKS = 3;
    // A tx is "Confirmed" only once we've VERIFIED its effect landed on the main chain — one of its output coins
    // exists in the UTXO set (set by verifyPendingActivity in index.html). Block-count alone is NOT enough: a tx
    // can be mined then reorged out (esp. on a freshly-resynced node) and never re-mine, which used to show a
    // false "Confirmed" for a pool that doesn't exist. Non-tx local notes (no txpowid) keep the old block/time rule.
    function confirmed(entry, chainBlock) {
        if (entry.failed) return false;
        if (entry.confirmedOnchain) return true;   // verified: the pool's reserves are on-chain (set by the verifier)
        // A CREATE with a stored covenant address must be VERIFIED against its reserves — block-count alone gave a
        // false "Confirmed" for a create that was mined then reorged out (its covenant stays empty). The verifier
        // (verifyPendingActivity) resolves it to confirmed/failed within ~12 blocks. Legacy creates (no refaddr)
        // and every other action type keep the block/time rule (they don't create a phantom pool, and their output
        // coins get spent so on-chain liveness is an unreliable signal for them).
        if (entry.type === "CREATE" && entry.refaddr) return false;
        if (entry.submitBlock > 0 && chainBlock > 0) return (chainBlock - entry.submitBlock) >= CONFIRM_BLOCKS;
        return (Date.now() - entry.ts) > 4 * 60000;
    }
    function statusText(entry, chainBlock) {
        if (entry.failed) return "Failed";
        if (confirmed(entry, chainBlock)) return "Confirmed";
        return "Confirming…";
    }
    /** Verifier (index.html) marks an entry confirmed once an output landed, or failed if it never did. Only
     *  touches still-'ok' rows so a resolved entry is never flipped back. */
    function actSetStatus(txpowid, status, failMsg) {
        if (!ready || !txpowid) return;
        MDS.sql("UPDATE pp_activity SET status='" + esc(status) + "', failmsg='" + esc(failMsg || "") +
            "' WHERE txpowid='" + esc(txpowid) + "' AND status='ok'");
    }

    // ---------------------------------------------------------------- GlobalFeed (READ ONLY here)
    // The global feed (pp_feed / pp_kv snap) is WRITTEN solely by the background service (service.js), which
    // runs headless on every NEWBLOCK — page + service must not both ingest or they'd double-count swaps and
    // race the snapshot. The page only READS the feed for All Pools.
    /** cb(events[]) newest first. Each: {pool,tokenLabel,kind,minimaIn,minimaAmt,tokenAmt,price,ts}. */
    function feedList(limit, cb) {
        if (!ready) { cb([]); return; }
        MDS.sql("SELECT * FROM pp_feed ORDER BY id DESC LIMIT " + (limit || FEED_MAX), function (r) {
            var out = [];
            if (r && r.status && r.rows) r.rows.forEach(function (row) {
                out.push({
                    pool: row.POOL, tokenLabel: row.TOKENLABEL, kind: row.KIND || "SWAP",
                    minimaIn: String(row.MINIMAIN) === "1",
                    minimaAmt: PP.decOr(row.MINIMAAMT, 0), tokenAmt: PP.decOr(row.TOKENAMT, 0),
                    price: PP.decOr(row.PRICE, 0), ts: parseInt(row.TS) || 0
                });
            });
            cb(out);
        });
    }

    // -------------------------------------------------------- known PandaPools covenant addresses
    // For the personal My-Activity filter: keep only on-chain rows that touch a pool covenant address AND moved
    // my wallet. Grows on discovery + owned pools (both 0x and Mx forms, lowercased), PERSISTED, never shrinks
    // (a past swap on a pool that has since closed must still match), and excludes the SENTINEL (so background
    // re-announce dust beacons aren't surfaced as personal activity).
    function knownAddrsGet(cb) {
        if (!ready) { cb({}); return; }
        MDS.sql("SELECT v FROM pp_kv WHERE k='knownaddrs'", function (r) {
            var set = {};
            if (r && r.status && r.rows && r.rows.length) {
                try { (JSON.parse(r.rows[0].V) || []).forEach(function (a) { if (a) set[String(a).toLowerCase()] = true; }); } catch (e) {}
            }
            cb(set);
        });
    }
    function knownAddrsAdd(addrs, cb) {
        if (!ready || !addrs || !addrs.length) { if (cb) cb(); return; }
        knownAddrsGet(function (set) {
            var changed = false;
            addrs.forEach(function (a) { if (a) { var k = String(a).toLowerCase(); if (!set[k]) { set[k] = true; changed = true; } } });
            if (!changed) { if (cb) cb(); return; }
            var arr = []; for (var k in set) if (set.hasOwnProperty(k)) arr.push(k);
            var v = esc(JSON.stringify(arr));
            MDS.sql("DELETE FROM pp_kv WHERE k='knownaddrs'", function () {
                MDS.sql("INSERT INTO pp_kv (k, v) VALUES ('knownaddrs','" + v + "')", function () { if (cb) cb(); });
            });
        });
    }

    // -------------------------------------------------------- OwnPoolStore (Layer 1: recipe persistence)
    // A durable, node-independent recipe for each pool THIS device owns — enough to regenerate + re-track the
    // covenant (the script is deterministic from opk/oadr/tok/kmin, so we store params, not the script). Seed +
    // recipe ⇒ always reclaimable. Recorded on create/migrate + backfilled on discovery; KEPT on close (a stale
    // recipe just re-tracks a spent covenant = a harmless no-op). Grows, never auto-removed.
    function ownRecord(p) {
        if (!ready || !p || !p.address || !p.opk || !p.oadr || !p.tok || !p.kmin) return;
        var a = esc(p.address.toLowerCase());
        // Prefer the pool's AUTHORITATIVE on-chain script (exact for any fee/template); reconstruct from params
        // only as a fallback (exact for the current template). Native does the same — this future-proofs a pool
        // whose covenant isn't byte-reconstructible from the current TEMPLATE (e.g. a legacy-fee pool).
        var script = (p.covenantScript && p.covenantScript.length) ? p.covenantScript
                   : (typeof Covenant !== "undefined" ? Covenant.script(p.opk, p.oadr, p.tok, p.kmin) : "");
        MDS.sql("DELETE FROM pp_ownpools WHERE address='" + a + "'", function () {
            MDS.sql("INSERT INTO pp_ownpools (address, mx, opk, oadr, tok, tdec, kmin, script) VALUES ('" +
                a + "','" + esc(p.mxaddress || "") + "','" + esc(p.opk) + "','" + esc(p.oadr) + "','" +
                esc(p.tok) + "'," + (isNaN(parseInt(p.tokDecimals)) ? 8 : parseInt(p.tokDecimals)) + ",'" + esc(String(p.kmin)) + "','" + esc(script) + "')");
        });
    }
    /** cb(recipes[]) — each {address, mxaddress, opk, oadr, tok, tokDecimals, kmin, script}. */
    function ownAll(cb) {
        if (!ready) { cb([]); return; }
        MDS.sql("SELECT * FROM pp_ownpools", function (r) {
            var out = [];
            if (r && r.status && r.rows) r.rows.forEach(function (row) {
                out.push({
                    address: row.ADDRESS, mxaddress: row.MX || "", opk: row.OPK, oadr: row.OADR,
                    tok: row.TOK, tokDecimals: (isNaN(parseInt(row.TDEC)) ? 8 : parseInt(row.TDEC)), kmin: row.KMIN, script: row.SCRIPT || ""
                });
            });
            cb(out);
        });
    }

    return {
        init: init, isReady: function () { return ready; },
        lpRecord: lpRecord, lpUpdateFeeBase: lpUpdateFeeBase, lpRemove: lpRemove, lpGet: lpGet,
        actRecord: actRecord, actRecordFailed: actRecordFailed, actList: actList, actSetStatus: actSetStatus,
        confirmed: confirmed, statusText: statusText, CONFIRM_BLOCKS: CONFIRM_BLOCKS,
        feedList: feedList, knownAddrsGet: knownAddrsGet, knownAddrsAdd: knownAddrsAdd,
        ownRecord: ownRecord, ownAll: ownAll
    };
})();
