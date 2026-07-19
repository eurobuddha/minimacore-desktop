/**
 * mdsw — callback-style wrappers over the MDS bridge (MDS.cmd / MDS.sql / MDS.net) + a kv store. Callback (not
 * promise) based to match the proven donor and stay reliable under Rhino (no event loop). Attaches to AX.mds.
 * In the Node test harness g.MDS is a mock; on a node it is the real MDS object.
 *
 * ⚠️ FILENAME IS LOAD-BEARING — never rename this back to mds.js: the node's MDSFileHandler intercepts ANY
 * web request whose filename is "mds.js" (case-insensitive, ANY path — MDSFileHandler.java:513/538) and serves
 * the node's own canonical MDS library instead. As lib/mds.js this module was silently never served in the
 * browser → AX.mds undefined → boot died on the very first command (found on the FIRST real-node install).
 *
 * Node command responses: {status, pending, response, error}. A vault-locked node returns pending:true on WRITE
 * commands — treated as "accepted/queued" (the coin may not mine; a book-presence belt handles that later).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    /** cmd(command, cb(fullResult)). */
    function cmd(command, cb) { g.MDS.cmd(command, function (r) { cb(r); }); }

    /** cmdR(command, cb(err, response)) — err is null on status:true OR pending:true. */
    function cmdR(command, cb) {
        g.MDS.cmd(command, function (r) {
            if (r && (r.status === true || r.pending === true)) cb(null, r.response, r);
            else cb(new Error('cmd failed: ' + command + ' — ' + (r && r.error)), null, r);
        });
    }

    function sql(query, cb) { g.MDS.sql(query, function (r) { cb(r); }); }
    function netGet(url, cb) { g.MDS.net.GET(url, function (r) { cb(r); }); }
    function netPost(url, data, cb) { g.MDS.net.POST(url, data, function (r) { cb(r); }); }

    /** MDS.net response body may be a string, a base64 blob, or already-parsed (donor pattern). */
    function netText(res) {
        if (!res || res.response == null) return null;
        var r = res.response;
        if (typeof r === 'string') return r;
        if (typeof r === 'object' && r.data) { try { return g.atob ? g.atob(r.data) : r.data; } catch (e) { return null; } }
        try { return JSON.stringify(r); } catch (e) { return null; }
    }

    // ---- kv store: a single SQL table (both hosts share it; SharedPreferences equivalent) ----
    // Writes surface a failure (err) so a silent persistence loss of e.g. trading_currency can't hide.
    function kvInit(cb) {
        sql("CREATE TABLE IF NOT EXISTS `ax_kv` (`k` varchar(200) NOT NULL PRIMARY KEY, `v` text NOT NULL)", function (r) { cb && cb(sqlErr(r)); });
    }
    function kvGet(key, dflt, cb) {
        sql("SELECT v FROM ax_kv WHERE k='" + esc(key) + "'", function (r) {
            cb((r && r.status && r.rows && r.rows.length) ? r.rows[0].V : (dflt === undefined ? null : dflt));
        });
    }
    function kvSet(key, val, cb) {
        sql("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + esc(key) + "', '" + esc(String(val)) + "')", function (r) { cb && cb(sqlErr(r)); });
    }
    function kvDel(key, cb) { sql("DELETE FROM ax_kv WHERE k='" + esc(key) + "'", function (r) { cb && cb(sqlErr(r)); }); }

    function sqlErr(r) { return (r && r.status) ? null : new Error('sql failed: ' + (r && r.error)); }

    /** SQL string escaper (single-quote doubling) — every value that reaches a query MUST pass through this. */
    function esc(s) { return String(s).split("'").join("''"); }

    // ---- cross-instance ETH-send lock: the UI and service.js share this SQL DB and both send ETH to the ONE
    // seed-derived wallet, so a single-row CAS lock serialises their broadcasts (a clash is fund-safe via F1's
    // fresh-pending retry, but this stops the wasteful clash). TTL > max broadcast time so a slow send isn't stolen
    // mid-flight; degrade-safe — any lock error must fall through (never block a time-critical settlement).
    var ethTok = null;
    var ETH_LOCK_TTL = 45000;
    function ethLockInit(cb) {
        sql("CREATE TABLE IF NOT EXISTS `ax_ethlock` (`id` int NOT NULL PRIMARY KEY, `owner` varchar(80), `ts` bigint)", function () {
            sql("INSERT INTO `ax_ethlock` (`id`,`owner`,`ts`) SELECT 1,'',0 WHERE NOT EXISTS (SELECT 1 FROM `ax_ethlock` WHERE `id`=1)", function () {
                g.MDS.cmd('random size:8', function (r) { ethTok = String((r && r.response && r.response.random) || ('e' + Date.now())).replace(/^0x/i, ''); cb && cb(); });
            });
        });
    }
    /** Acquire the ETH broadcast lock (steal if stale/free/mine). cb(won). Degrades to won=true if uninitialised. */
    function ethLockAcquire(cb) {
        if (!ethTok) return cb(true);   // not wired (tests / pre-boot) → no lock, rely on F1
        var now = Date.now(), stale = now - ETH_LOCK_TTL, t = esc(ethTok);
        sql("UPDATE `ax_ethlock` SET `owner`='" + t + "', `ts`=" + now + " WHERE `id`=1 AND (`owner`='' OR `owner` IS NULL OR `ts` < " + stale + " OR `owner`='" + t + "')", function () {
            sql("SELECT `owner` FROM `ax_ethlock` WHERE `id`=1", function (r) {
                var rs = (r && r.rows) || [];
                cb(rs.length ? (rs[0].OWNER === ethTok) : true);   // no row (DB error) → don't block, fall through to F1
            });
        });
    }
    function ethLockRelease(cb) {
        if (!ethTok) return cb && cb();
        sql("UPDATE `ax_ethlock` SET `owner`='' WHERE `id`=1 AND `owner`='" + esc(ethTok) + "'", function () { cb && cb(); });
    }

    AX.mds = {
        cmd: cmd, cmdR: cmdR, sql: sql, netGet: netGet, netPost: netPost, netText: netText,
        kvInit: kvInit, kvGet: kvGet, kvSet: kvSet, kvDel: kvDel, esc: esc,
        ethLockInit: ethLockInit, ethLockAcquire: ethLockAcquire, ethLockRelease: ethLockRelease
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
