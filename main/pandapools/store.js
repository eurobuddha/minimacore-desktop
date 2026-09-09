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
    var ready = false, recoveryReady = false;
    var FEED_MAX = 100;
    var ACT_MAX = 120;

    function esc(v) { return String(v).replace(/'/g, "''"); }

    // ---------------------------------------------------------------- init
    function init(cb) {
        // probe one table; only CREATE the set if missing (avoids pending prompts)
        MDS.sql("SELECT 1 FROM pp_activity LIMIT 1", function (r) {
            function fin() { migrateFeedKind(function () { migrateActivityRefaddr(function () { ensureOwnPools(function () { ensureRecoveryColumns(function () { ensureHistory(function () { ready = true; if (cb) cb(); }); }); }); }); }); }
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
    function ensureRecoveryColumns(cb) {
        var columns = [["opkuses","int DEFAULT -1"],["signing_unverified","int DEFAULT 1"],["lastcoinm","varchar(80)"],["lastcoint","varchar(80)"]];
        function next(i) {
            if(i===columns.length){recoveryReady=true;cb();return;}
            var col=columns[i];
            MDS.sql("SELECT "+col[0]+" FROM pp_ownpools LIMIT 1",function(r){
                if(r&&r.status===true){next(i+1);return;}
                MDS.sql("ALTER TABLE pp_ownpools ADD COLUMN "+col[0]+" "+col[1],function(){
                    MDS.sql("SELECT "+col[0]+" FROM pp_ownpools LIMIT 1",function(check){if(check&&check.status===true)next(i+1);else cb();});
                });
            });
        }next(0);
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

    /**
     * pp_history — a permanent, txpowid-keyed mirror of the node's `history relevant:true`, the MiniDapp
     * counterpart of the native app's HistoryDb.
     *
     * It ACCUMULATES and is never pruned, which is the point: the node retains only a window, so once a
     * transaction ages out of `history` this is the only remaining record of it. Everything the pool
     * statement needs lives here — the per-token `deltas` map (this wallet's net effect) plus the raw input
     * and output coin arrays, which are what let a routed swap be split across the pools it actually touched.
     *
     * Probed-then-created like every other table, so a normal run never triggers a pending SQL prompt.
     */
    function ensureHistory(cb) {
        MDS.sql("SELECT 1 FROM pp_history LIMIT 1", function (r) {
            if (r && r.status) { cb(); return; }
            MDS.sql(
                "CREATE TABLE IF NOT EXISTS `pp_history` (" +
                " `txpowid` varchar(80) NOT NULL PRIMARY KEY," +
                " `block` bigint NOT NULL," +
                " `timemilli` bigint NOT NULL," +
                " `direction` varchar(12) NOT NULL," +
                " `deltas` text NOT NULL," +
                " `counterparty` varchar(90)," +
                " `inputs` text," +
                " `outputs` text," +
                " `synced_at` bigint NOT NULL)", function () { cb(); });
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
            ",'ok','','" + esc(refaddr || "") + "', " + Date.now() + ")", function () {});
    }
    function actRecordFailed(type, summary, failMsg) {
        if (!ready) return;
        MDS.sql("INSERT INTO pp_activity (type, summary, txpowid, submitblock, status, failmsg, ts) VALUES ('" +
            esc(type) + "','" + esc(summary) + "','',0,'failed','" + esc(failMsg || "") + "', " + Date.now() + ")", function () {});
    }
    /** cb(entries[]) newest first. Each: {type,summary,txpowid,submitBlock,ts,failed,failMsg}. */
    function actList(limit, cb) {
        if (!ready) { cb([], false); return; }
        MDS.sql("SELECT * FROM pp_activity ORDER BY id DESC" + (limit === -1 ? "" : " LIMIT " + (limit || ACT_MAX)), function (r) {
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
            cb(out, !!(r && r.status));
        });
    }
    var CONFIRM_BLOCKS = 3;
    // Only a successful stock-node onchain lookup establishes confirmation.
    function confirmed(entry) { return !entry.failed && entry.verifiedAt > 0 && entry.verifiedDepth >= CONFIRM_BLOCKS; }
    function statusText(entry) { return ActivityChain.statusText(entry); }
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
        MDS.sql("SELECT * FROM pp_feed ORDER BY id DESC" + (limit === -1 ? "" : " LIMIT " + (limit || FEED_MAX)), function (r) {
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

    // -------------------------------------------------------- pp_history (permanent on-chain mirror)

    /** Write one transaction. Calls back TRUE if it was NEW, FALSE if this txpowid was already stored.
     *  That boolean is load-bearing: it is how the incremental sync knows it has caught up with itself. */
    function histInsert(e, cb) {
        if (!ready) { cb(false); return; }
        MDS.sql("INSERT INTO pp_history (txpowid, block, timemilli, direction, deltas, counterparty, inputs, outputs, synced_at)"
            + " VALUES ('" + esc(e.txpowid) + "'," + (e.block || 0) + "," + (e.timemilli || 0) + ",'" + esc(e.direction || "") + "','"
            + esc(e.deltas || "{}") + "','" + esc(e.counterparty || "") + "','" + esc(e.inputs || "[]") + "','"
            + esc(e.outputs || "[]") + "'," + Date.now() + ")",
            function (r) {
                if (r && r.status) { cb(true, true); return; }
                MDS.sql("SELECT txpowid FROM pp_history WHERE txpowid='" + esc(e.txpowid) + "'", function (found) {
                    cb(false, !!(found && found.status && found.rows && found.rows.length));
                });
            });
    }

    /** Every stored transaction, OLDEST FIRST — the order a statement needs, since running totals only mean
     *  anything accumulated forwards. Unbounded by design: a ledger with a LIMIT on it does not reconcile. */
    function histAll(cb) {
        if (!ready) { cb([], false); return; }
        MDS.sql("SELECT txpowid, block, timemilli, direction, deltas, counterparty, inputs, outputs FROM pp_history"
            + " ORDER BY block ASC, timemilli ASC", function (r) {
            var out = [];
            if (r && r.status && r.rows) r.rows.forEach(function (row) {
                out.push({
                    txpowid: row.TXPOWID, block: Number(row.BLOCK), timemilli: Number(row.TIMEMILLI),
                    direction: row.DIRECTION, deltas: row.DELTAS, counterparty: row.COUNTERPARTY,
                    inputs: row.INPUTS, outputs: row.OUTPUTS
                });
            });
            cb(out, !!(r && r.status));
        });
    }

    function histStats(cb) {
        if (!ready) { cb({ count: 0, minBlock: 0, maxBlock: 0 }); return; }
        MDS.sql("SELECT COUNT(*) AS C, MIN(block) AS MN, MAX(block) AS MX FROM pp_history", function (r) {
            var row = (r && r.status && r.rows && r.rows.length) ? r.rows[0] : null;
            cb({ count: row ? Number(row.C || 0) : 0, minBlock: row ? Number(row.MN || 0) : 0, maxBlock: row ? Number(row.MX || 0) : 0 });
        });
    }

    // -------------------------------------------------------- generic kv (sync bookkeeping)
    function kvGet(k, cb) {   // cb(value, ok) — ok=false means the read FAILED (distinct from "no row")
        if (!ready) { cb("", false); return; }
        MDS.sql("SELECT v FROM pp_kv WHERE k='" + esc(k) + "'", function (r) {
            var ok = !!(r && r.status);
            cb(ok && r.rows && r.rows.length ? String(r.rows[0].V) : "", ok);
        });
    }
    function kvSet(k,v,cb){
        if(!ready){if(cb)cb(false);return;}
        MDS.sql("MERGE INTO pp_kv (k,v) KEY(k) VALUES ('"+esc(k)+"','"+esc(v)+"')",function(r){if(cb)cb(!!r&&r.status===true);});
    }

    // -------------------------------------------------------- known PandaPools covenant addresses
    // For the personal My-Activity filter: keep only on-chain rows that touch a pool covenant address AND moved
    // my wallet. Grows on discovery + owned pools (both 0x and Mx forms, lowercased), PERSISTED, never shrinks
    // (a past swap on a pool that has since closed must still match), and excludes the SENTINEL (so background
    // re-announce dust beacons aren't surfaced as personal activity).
    function knownAddrsGet(cb) {
        if (!ready) { cb({}, false); return; }
        MDS.sql("SELECT v FROM pp_kv WHERE k='knownaddrs'", function (r) {
            var set = {};
            if (r && r.status && r.rows && r.rows.length) {
                try { (JSON.parse(r.rows[0].V) || []).forEach(function (a) { if (a) set[String(a).toLowerCase()] = true; }); } catch (e) {}
            }
            cb(set, !!(r && r.status));
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
    // covenant (the script is deterministic from opk/oadr/tok/kmin, so we store params, not the script). Current signing state and available chain proofs are also required. Recorded on create/migrate + backfilled on discovery; KEPT on close (a stale
    // recipe just re-tracks a spent covenant = a harmless no-op). Grows, never auto-removed.
    var failedConfirmations={},pendingHintPersistence=false;
    function persistRecovery(cb){function done(ok){if(ok)pendingHintPersistence=false;cb(ok);}if(MDS.persistRecovery)MDS.persistRecovery(done);else done(true);}
    function confirmationFailed(opk){return !!failedConfirmations[String(opk).toLowerCase()];}
    function ownRecord(p,cb) {
        cb=cb||function(){};
        if(!ready||!recoveryReady||!p||!p.address||!p.opk||!p.oadr||!p.tok||!p.kmin){cb(false);return;}
        var a=esc(p.address.toLowerCase()),script=p.covenantScript||p.script||Covenant.script(p.opk,p.oadr,p.tok,p.kmin);
        var uses=ReserveRecovery.integer(p.minimumOwnerUses,262144)?Number(p.minimumOwnerUses):-1,hold=p.signingStateUnverified===true?1:0,insertHold=p.signingStateUnverified===false?0:1;
        var vals="'"+a+"','"+esc(p.mxaddress||"")+"','"+esc(p.opk)+"','"+esc(p.oadr)+"','"+esc(p.tok)+"',"+(ReserveRecovery.integer(p.tokDecimals,44)?Number(p.tokDecimals):8)+",'"+esc(String(p.kmin))+"','"+esc(script)+"',"+uses+","+insertHold;
        // No DELETE gap. Existing recipes remain intact if a write fails or another context records them.
        MDS.sql("INSERT INTO pp_ownpools (address,mx,opk,oadr,tok,tdec,kmin,script,opkuses,signing_unverified) SELECT "+vals+" WHERE NOT EXISTS (SELECT 1 FROM pp_ownpools WHERE address='"+a+"')",function(){
            // Atomic monotonic merges: neither rediscovery nor an older backup can lower these guards.
            MDS.sql("UPDATE pp_ownpools SET opkuses=CASE WHEN opkuses<"+uses+" THEN "+uses+" ELSE opkuses END, signing_unverified=CASE WHEN signing_unverified<"+hold+" THEN "+hold+" ELSE signing_unverified END WHERE address='"+a+"'",function(r){
                if(!r||r.status!==true){cb(false);return;}
                MDS.sql("SELECT opk,opkuses,signing_unverified FROM pp_ownpools WHERE address='"+a+"'",function(check){
                    var row=check&&check.status===true&&check.rows&&check.rows[0];
                    if(!row||String(row.OPK).toLowerCase()!==String(p.opk).toLowerCase()||Number(row.OPKUSES)<uses||Number(row.SIGNING_UNVERIFIED)<hold){cb(false);return;}
                    persistRecovery(function(ok){if(!ok){cb(false);return;}if(p.coinidM&&p.coinidT&&ReserveRecovery.complete(p))ownRememberReserves(p,cb);else cb(true);});
                });
            });
        });
    }
    function ownRememberReserves(p,cb){
        cb=cb||function(){};
        if(!recoveryReady||!ReserveRecovery.complete(p)||!/^0x[0-9a-fA-F]{64}$/.test(p.coinidM)||!/^0x[0-9a-fA-F]{64}$/.test(p.coinidT)){cb(false);return;}
        var where=" WHERE address='"+esc(p.address.toLowerCase())+"'";
        MDS.sql("SELECT lastcoinm,lastcoint FROM pp_ownpools"+where,function(r){
            if(!r||r.status!==true||!Array.isArray(r.rows)){cb(false);return;}
            if(!r.rows.length){cb(true);return;}
            var old=r.rows[0];
            if(String(old.LASTCOINM||"").toLowerCase()===p.coinidM.toLowerCase()&&String(old.LASTCOINT||"").toLowerCase()===p.coinidT.toLowerCase()){
                if(pendingHintPersistence)persistRecovery(cb);else cb(true);return;
            }
            pendingHintPersistence=true;
            MDS.sql("UPDATE pp_ownpools SET lastcoinm='"+esc(p.coinidM)+"',lastcoint='"+esc(p.coinidT)+"'"+where,function(updated){if(!updated||updated.status!==true){cb(false);return;}persistRecovery(cb);});
        });
    }
    function ownAll(cb) {
        if(!ready||!recoveryReady){cb([],false);return;}
        MDS.sql("SELECT * FROM pp_ownpools",function(r){
            var out=[];
            if(r&&r.status===true&&Array.isArray(r.rows))r.rows.forEach(function(row){
                out.push({address:row.ADDRESS,mxaddress:row.MX||"",opk:row.OPK,oadr:row.OADR,tok:row.TOK,tokDecimals:Number(row.TDEC),kmin:row.KMIN,script:row.SCRIPT||"",minimumOwnerUses:Number(row.OPKUSES),signingStateUnverified:Number(row.SIGNING_UNVERIFIED)!==0,coinidM:row.LASTCOINM||"",coinidT:row.LASTCOINT||""});
            });
            cb(out,!!r&&r.status===true&&Array.isArray(r.rows));
        });
    }
    // Called only after the owner's explicit current-wallet/other-signers attestation.
    function ownAcknowledge(opk,uses,cb){
        if(!recoveryReady||!/^0x[0-9a-fA-F]{64}$/.test(opk)||!ReserveRecovery.integer(uses,262143)){cb(false);return;}
        var k=opk.toLowerCase();
        ownAll(function(ps,ok){
            var matching=ps.filter(function(p){return p.opk.toLowerCase()===k;});
            if(!ok||!matching.length||matching.some(function(p){return p.minimumOwnerUses>uses;})){cb(false);return;}
            failedConfirmations[k]=true;
            function fail(){MDS.sql("UPDATE pp_ownpools SET signing_unverified=1 WHERE LOWER(opk)='"+esc(k)+"'",function(){persistRecovery(function(){cb(false);});});}
            MDS.sql("UPDATE pp_ownpools SET signing_unverified=0,opkuses="+Number(uses)+" WHERE LOWER(opk)='"+esc(k)+"' AND opkuses<="+Number(uses),function(r){
                if(!r||r.status!==true){fail();return;}
                persistRecovery(function(saved){
                    if(!saved){fail();return;}
                    ownAll(function(current,readOk){
                        var same=current.filter(function(p){return p.opk.toLowerCase()===k;});
                        if(!readOk||same.length!==matching.length||!same.every(function(p){return !p.signingStateUnverified&&p.minimumOwnerUses===Number(uses);})){fail();return;}
                        delete failedConfirmations[k];cb(true);
                    });
                });
            });
        });
    }

    return {
        init: init, isReady: function () { return ready; },
        lpRecord: lpRecord, lpUpdateFeeBase: lpUpdateFeeBase, lpRemove: lpRemove, lpGet: lpGet,
        actRecord: actRecord, actRecordFailed: actRecordFailed, actList: actList, actSetStatus: actSetStatus,
        confirmed: confirmed, statusText: statusText, CONFIRM_BLOCKS: CONFIRM_BLOCKS,
        feedList: feedList, knownAddrsGet: knownAddrsGet, knownAddrsAdd: knownAddrsAdd,
        confirmationFailed: confirmationFailed, ownRecord: ownRecord, ownAll: ownAll, ownRememberReserves: ownRememberReserves, ownAcknowledge: ownAcknowledge,
        histInsert: histInsert, histAll: histAll, histStats: histStats,
        kvGet: kvGet, kvSet: kvSet
    };
})();
