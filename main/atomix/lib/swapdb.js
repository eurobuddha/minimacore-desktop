/**
 * swapdb — durable swap state over MDS.sql (H2), a faithful port of native SwapDb.java. Two layers:
 *   (1) the TRUSTLESS idempotency core — `secrets` (every known preimage), an append-only `events` log keyed on
 *       the hashlock (HTLC_STARTED/CPTXN_SENT/CPTXN_COLLECT/CPTXN_EXPIRED), and `myhtlc` (what I requested when I
 *       initiated, so on collect I re-verify the counterparty locked the right amount/token before revealing);
 *   (2) a UX projection — `swaps` (one resumable card per swap) + `market_trades` (the network-wide observed
 *       price feed — written ONLY by the service-side AX.market collector; the page just reads it).
 * The engine's guards read these so a restart never double-locks or double-claims. All calls are async (MDS.sql is
 * callback-based); every cb is cb(err[, value]). Column names come back UPPERCASE from H2. Attaches to AX.swapdb.
 * Requires AX.mds. Depends on Date.now() for timestamps (available under MDS Rhino, unlike the workflow sandbox).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds;

    // ---- event names (verbatim from native SwapDb / upstream sql.js) ----
    var EV_STARTED = 'HTLC_STARTED', EV_CPSENT = 'CPTXN_SENT', EV_COLLECT = 'CPTXN_COLLECT', EV_EXPIRED = 'CPTXN_EXPIRED';
    // MDS-only (backport to native): a counterparty amount/token MISMATCH is logged as its own event — native logs
    // EV_COLLECT here, and since the claim gates on haveCollect, ONE hostile dust coin carrying a victim's active
    // hash permanently poisons the REAL claim (mutual-refund grief). EV_MISMATCH never gates anything.
    var EV_MISMATCH = 'CPTXN_MISMATCH';
    // ---- UX swap status ----
    var ST_STARTED = 'STARTED', ST_LOCKED = 'LOCKED', ST_CLAIMING = 'CLAIMING',
        ST_COMPLETE = 'COMPLETE', ST_REFUNDED = 'REFUNDED', ST_ERROR = 'ERROR';
    // ---- market-trade status (network price feed) ----
    var MT_OPEN = 'OPEN', MT_EXECUTED = 'EXECUTED', MT_REFUNDED = 'REFUNDED';

    function now() { return Date.now(); }
    /** Normalise a hashlock for keys: lower-case, strip 0x — so 0x-prefixed and bare forms collide to one row. */
    function norm(h) { if (h == null) return ''; var s = String(h).trim().toLowerCase(); return s.indexOf('0x') === 0 ? s.slice(2) : s; }
    function esc(s) { return M.esc(s == null ? '' : s); }
    /** A number safe to inline into SQL (finite → its decimal form, else 0) — never lets NaN/'' corrupt a query. */
    function num(n) { var v = Number(n); return isFinite(v) ? String(v) : '0'; }
    function sqlErr(r) { return (r && r.status) ? null : new Error('sql failed: ' + (r && r.error)); }
    function rows(r) { return (r && r.rows) ? r.rows : []; }

    // Run a write, report only the error. Run a read, hand back rows.
    function write(q, cb) { M.sql(q, function (r) { cb && cb(sqlErr(r)); }); }
    function read(q, cb) { M.sql(q, function (r) { var e = sqlErr(r); cb(e, e ? [] : rows(r)); }); }

    // ================= schema =================
    function init(cb) {
        var ddl = [
            "CREATE TABLE IF NOT EXISTS `secrets` (`hash` varchar(200) NOT NULL PRIMARY KEY, `secret` text NOT NULL, `added` bigint)",
            "CREATE TABLE IF NOT EXISTS `events` (`id` bigint auto_increment PRIMARY KEY, `hash` varchar(200), `event` varchar(60), `token` text, `amount` text, `txnhash` text, `eventdate` bigint)",
            "CREATE INDEX IF NOT EXISTS `idx_events_hash` ON `events`(`hash`)",
            "CREATE TABLE IF NOT EXISTS `myhtlc` (`hash` varchar(200) NOT NULL PRIMARY KEY, `reqamount` text, `token` text, `eventdate` bigint)",
            "CREATE TABLE IF NOT EXISTS `swaps` (`hash` varchar(200) NOT NULL PRIMARY KEY, `role` varchar(20), `direction` varchar(40), " +
                "`selltoken` varchar(40), `sellamount` text, `buytoken` varchar(40), `buyamount` text, `counterparty` text, " +
                "`status` varchar(20), `contractid` varchar(200), `mytimelock` bigint, `mylegminima` int, `created` bigint, `updated` bigint)",
            "CREATE TABLE IF NOT EXISTS `market_trades` (`coinid` varchar(200) NOT NULL PRIMARY KEY, `hash` varchar(200), " +
                "`price` double, `size_minima` text, `req_amount` text, `req_token` text, `owner` text, `receiver` text, " +
                "`created_block` bigint, `timelock` bigint, `observed_at` bigint, `status` varchar(20), `secret` text)"
        ];
        // Serialise the DDL — H2 dislikes some concurrent DDL, and a table must exist before its index.
        AX.flow.each(ddl, function (stmt, i, next) { write(stmt, next); }, cb);
    }

    // ================= secrets =================
    /** Store a preimage for its hashlock — ATOMIC + idempotent + never-overwrite: a single INSERT…WHERE NOT EXISTS
     *  so a concurrent re-insert can't PK-throw and an existing (first-written) secret is never clobbered. cb(err).
     *  Fund-safety: the preimage is the only thing that can claim MY leg, so first-write-wins is mandatory. */
    function insertSecret(hash, secret, cb) {
        if (!hash || !secret) return cb(null);
        var h = esc(norm(hash));
        write("INSERT INTO `secrets` (`hash`,`secret`,`added`) SELECT '" + h + "','" + esc(secret) + "'," + now() +
            " WHERE NOT EXISTS (SELECT 1 FROM `secrets` WHERE `hash`='" + h + "')", cb);
    }
    function getSecret(hash, cb) {
        read("SELECT `secret` FROM `secrets` WHERE `hash`='" + esc(norm(hash)) + "' LIMIT 1", function (e, rs) {
            if (e) return cb(e);
            cb(null, rs.length ? rs[0].SECRET : null);
        });
    }

    // ================= event log =================
    function logEvent(hash, event, token, amount, txnhash, cb) {
        write("INSERT INTO `events` (`hash`,`event`,`token`,`amount`,`txnhash`,`eventdate`) VALUES ('" +
            esc(norm(hash)) + "','" + esc(event) + "','" + esc(token) + "','" + esc(amount) + "','" + esc(txnhash) + "'," + now() + ")", cb);
    }
    function hasEvent(hash, event, cb) {
        read("SELECT 1 AS X FROM `events` WHERE `hash`='" + esc(norm(hash)) + "' AND `event`='" + esc(event) + "' LIMIT 1",
            function (e, rs) { cb(e, !e && rs.length > 0); });
    }
    function getEvents(hash, cb) {
        read("SELECT `event`,`token`,`amount`,`txnhash`,`eventdate` FROM `events` WHERE `hash`='" + esc(norm(hash)) + "' ORDER BY `eventdate` DESC",
            function (e, rs) {
                if (e) return cb(e);
                cb(null, rs.map(function (r) { return { event: r.EVENT, token: r.TOKEN, amount: r.AMOUNT, note: r.TXNHASH, date: Number(r.EVENTDATE) }; }));
            });
    }

    // ================= myhtlc (what I requested when initiating) =================
    function insertMyHtlc(hash, reqAmount, reqToken, cb) {
        write("MERGE INTO `myhtlc` (`hash`,`reqamount`,`token`,`eventdate`) KEY(`hash`) VALUES ('" +
            esc(norm(hash)) + "','" + esc(reqAmount) + "','" + esc(reqToken) + "'," + now() + ")", cb);
    }
    /** {reqAmount, reqToken} for an initiated swap, or null if I did not start this HTLC. */
    function getRequest(hash, cb) {
        read("SELECT `reqamount`,`token` FROM `myhtlc` WHERE `hash`='" + esc(norm(hash)) + "' LIMIT 1", function (e, rs) {
            if (e) return cb(e);
            cb(null, rs.length ? { reqAmount: rs[0].REQAMOUNT, reqToken: rs[0].TOKEN } : null);
        });
    }

    // ================= swaps (UX projection) =================
    function upsertSwap(s, cb) {
        if (!s.created) s.created = now();
        write("MERGE INTO `swaps` (`hash`,`role`,`direction`,`selltoken`,`sellamount`,`buytoken`,`buyamount`," +
            "`counterparty`,`status`,`contractid`,`mytimelock`,`mylegminima`,`created`,`updated`) KEY(`hash`) VALUES ('" +
            esc(norm(s.hash)) + "','" + esc(s.role) + "','" + esc(s.direction) + "','" + esc(s.sellToken) + "','" + esc(s.sellAmount) + "','" +
            esc(s.buyToken) + "','" + esc(s.buyAmount) + "','" + esc(s.counterparty) + "','" + esc(s.status) + "','" + esc(s.contractId) + "'," +
            num(s.myTimelock) + "," + (s.myLegIsMinima ? 1 : 0) + "," + num(s.created) + "," + now() + ")", cb);
    }
    function setSwapStatus(hash, status, cb) {
        write("UPDATE `swaps` SET `status`='" + esc(status) + "',`updated`=" + now() + " WHERE `hash`='" + esc(norm(hash)) + "'", cb);
    }
    function setSwapContractId(hash, contractId, cb) {
        write("UPDATE `swaps` SET `contractid`='" + esc(contractId) + "',`updated`=" + now() + " WHERE `hash`='" + esc(norm(hash)) + "'", cb);
    }
    function readSwap(r) {
        return {
            hash: r.HASH, role: r.ROLE, direction: r.DIRECTION,
            sellToken: r.SELLTOKEN, sellAmount: r.SELLAMOUNT, buyToken: r.BUYTOKEN, buyAmount: r.BUYAMOUNT,
            counterparty: r.COUNTERPARTY, status: r.STATUS, contractId: r.CONTRACTID,
            myTimelock: Number(r.MYTIMELOCK), myLegIsMinima: Number(r.MYLEGMINIMA) !== 0,
            created: Number(r.CREATED), updated: Number(r.UPDATED)
        };
    }
    function getSwap(hash, cb) {
        read("SELECT * FROM `swaps` WHERE `hash`='" + esc(norm(hash)) + "' LIMIT 1", function (e, rs) {
            cb(e, e ? null : (rs.length ? readSwap(rs[0]) : null));
        });
    }
    /** Remove a swap row — release a record-before-broadcast reservation whose lock PROVABLY never broadcast. Never
     *  call for a lock that may have landed. */
    function deleteSwap(hash, cb) { write("DELETE FROM `swaps` WHERE `hash`='" + esc(norm(hash)) + "'", cb); }
    function allSwaps(cb) {
        read("SELECT * FROM `swaps` ORDER BY `created` DESC", function (e, rs) { cb(e, e ? [] : rs.map(readSwap)); });
    }
    /** Hashes of swaps not yet finished — the set the watcher still cares about (for secret matching). */
    function activeHashes(cb) {
        read("SELECT `hash` FROM `swaps` WHERE `status` NOT IN ('" + ST_COMPLETE + "','" + ST_REFUNDED + "','" + ST_ERROR + "')",
            function (e, rs) { cb(e, e ? [] : rs.map(function (r) { return r.HASH; })); });
    }

    // ================= market_trades (network-wide history from on-chain HTLC locks) =================
    /** Record/refresh an observed open lock (keyed by coinid); never downgrades a terminal row back to OPEN. */
    function upsertOpenTrade(t, cb) {
        if (!t.coinid) return cb && cb(null);
        // INSERT-if-absent (H2): a terminal row keeps its status; observed_at stays first-seen.
        write("INSERT INTO `market_trades` (`coinid`,`hash`,`price`,`size_minima`,`req_amount`,`req_token`,`owner`," +
            "`receiver`,`created_block`,`timelock`,`observed_at`,`status`) SELECT '" + esc(t.coinid) + "','" + esc(norm(t.hash)) + "'," +
            num(t.price) + ",'" + esc(t.sizeMinima) + "','" + esc(t.reqAmount) + "','" + esc(t.reqToken) + "','" + esc(t.owner) + "','" +
            esc(t.receiver) + "'," + num(t.createdBlock) + "," + num(t.timelock) + "," + now() + ",'" + MT_OPEN +
            "' WHERE NOT EXISTS (SELECT 1 FROM `market_trades` WHERE `coinid`='" + esc(t.coinid) + "')", cb);
    }
    function readTrade(r) {
        return {
            coinid: r.COINID, hash: r.HASH, price: Number(r.PRICE), sizeMinima: r.SIZE_MINIMA,
            reqAmount: r.REQ_AMOUNT, reqToken: r.REQ_TOKEN, owner: r.OWNER, receiver: r.RECEIVER,
            createdBlock: Number(r.CREATED_BLOCK), timelock: Number(r.TIMELOCK), observedAt: Number(r.OBSERVED_AT),
            status: r.STATUS, secret: r.SECRET
        };
    }
    function openTrades(cb) {
        read("SELECT * FROM `market_trades` WHERE `status`='" + MT_OPEN + "'", function (e, rs) { cb(e, e ? [] : rs.map(readTrade)); });
    }
    function markTradeExecuted(coinid, secret, cb) {
        var set = "`status`='" + MT_EXECUTED + "'" + (secret ? ",`secret`='" + esc(secret) + "'" : "");
        write("UPDATE `market_trades` SET " + set + " WHERE `coinid`='" + esc(coinid) + "'", cb);
    }
    function markTradeRefunded(coinid, cb) {
        write("UPDATE `market_trades` SET `status`='" + MT_REFUNDED + "' WHERE `coinid`='" + esc(coinid) + "'", cb);
    }
    function recentTrades(limit, cb) {
        read("SELECT * FROM `market_trades` ORDER BY `created_block` DESC, `observed_at` DESC LIMIT " + num(limit),
            function (e, rs) { cb(e, e ? [] : rs.map(readTrade)); });
    }
    /** Executed prints for the chart, oldest→newest so a line plots left-to-right. */
    function executedTrades(limit, cb) {
        read("SELECT * FROM (SELECT * FROM `market_trades` WHERE `status`='" + MT_EXECUTED + "' ORDER BY `created_block` DESC LIMIT " +
            num(limit) + ") ORDER BY `created_block` ASC", function (e, rs) { cb(e, e ? [] : rs.map(readTrade)); });
    }

    AX.swapdb = {
        EV_STARTED: EV_STARTED, EV_CPSENT: EV_CPSENT, EV_COLLECT: EV_COLLECT, EV_EXPIRED: EV_EXPIRED, EV_MISMATCH: EV_MISMATCH,
        ST_STARTED: ST_STARTED, ST_LOCKED: ST_LOCKED, ST_CLAIMING: ST_CLAIMING, ST_COMPLETE: ST_COMPLETE, ST_REFUNDED: ST_REFUNDED, ST_ERROR: ST_ERROR,
        MT_OPEN: MT_OPEN, MT_EXECUTED: MT_EXECUTED, MT_REFUNDED: MT_REFUNDED,
        init: init, norm: norm,
        insertSecret: insertSecret, getSecret: getSecret,
        logEvent: logEvent, hasEvent: hasEvent, getEvents: getEvents,
        insertMyHtlc: insertMyHtlc, getRequest: getRequest,
        upsertSwap: upsertSwap, setSwapStatus: setSwapStatus, setSwapContractId: setSwapContractId,
        getSwap: getSwap, deleteSwap: deleteSwap, allSwaps: allSwaps, activeHashes: activeHashes,
        upsertOpenTrade: upsertOpenTrade, openTrades: openTrades, markTradeExecuted: markTradeExecuted,
        markTradeRefunded: markTradeRefunded, recentTrades: recentTrades, executedTrades: executedTrades
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
