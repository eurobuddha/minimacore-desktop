/*
 * history.js — bounded, adaptive paging of the node's `history relevant:true` into pp_history.
 *
 * This is deferred item #67. Before it, the Activity tab issued a single `history max:4` and showed whatever
 * came back — about four transactions. That is fine for a glance and useless for accounting: a pool statement
 * built on four rows is silently near-empty, which is the worst way for a financial report to be wrong.
 *
 * WHY THE PAGE SIZE IS NOT TINY HERE. The famous 256,000-byte reply cap is NOT a node limit — it lives in
 * the Android broadcast receiver (`MinimaReceiver.MAX_MESSAGE_LEN`), so it binds the native APK and nothing
 * else. There is no equivalent in the MDS bridge (`MDSCommandHandler` imposes no size limit) and none in the
 * node core. The native app must page at max:1 because an over-limit broadcast is an UNCATCHABLE Binder
 * failure that force-kills the app; over MDS the worst case is a reply that doesn't arrive, which is
 * recoverable. Do not copy the native's max:1 here — it would make a full backfill take hours for no reason.
 *
 * The page size still ADAPTS: it starts large, halves on any page that fails to come back, and at max:1
 * skips a single oversized transaction rather than stalling everything behind it. Because the failure mode
 * is recoverable, the starting size is a throughput choice, not a safety constraint — a too-large start
 * costs a couple of wasted round-trips and nothing more.
 *
 * TWO MODES, exactly as the native HistorySync:
 *   BACKFILL     — one time, pages to the end of what the node still retains, then sets a done flag.
 *   INCREMENTAL  — steady state, pages only until it meets a txpowid it already holds.
 * Both stop on a short page, which is the node telling us there is no more history.
 *
 * Everything it writes is permanent (see Store.ensureHistory): the node's own window moves on, this does not.
 */
var History = (function () {

    // No reply cap on this transport — see the header. Halves if a page doesn't land. The host may raise it:
    // minimaCore Desktop talks straight to the node's HTTP RPC, which has no size limit at all, so it sets a
    // much larger page through the MDS shim rather than editing this file (3-way byte-parity rule).
    var START_MAX = (typeof MDS !== "undefined" && MDS.historyPageMax) ? MDS.historyPageMax : 64;
    var PAGE_DELAY = 250;     // ms between pages: a background catch-up, not a race
    var MAX_FETCHES = 600;    // hard stop across all pages + retries, so a pathological node can't spin forever
    var MAX_SKIP = 3;         // consecutive max:1 failures tolerated before giving up

    var running = false;

    function isRunning() { return running; }

    /** Sync now. `cb(added, ok)` fires once, when there is nothing left to fetch. */
    function sync(cb) {
        if (running) { if (cb) cb(0, true); return; }
        running = true;
        Store.kvGet("hist_backfilled", function (done) {
            var st = {
                backfill: done !== "true",
                pageMax: START_MAX,
                added: 0, fetches: 0, skips: 0,
                cb: cb
            };
            page(st, 0);
        });
    }

    function finish(st, ok) {
        running = false;
        Store.kvSet("hist_synced_at", String(Date.now()), function () {
            if (st.cb) st.cb(st.added, ok);
        });
    }

    function page(st, offset) {
        if (++st.fetches > MAX_FETCHES) { finish(st, true); return; }
        MDS.cmd("history relevant:true max:" + st.pageMax + " offset:" + offset, function (j) {
            var resp = (j && j.status) ? j.response : null;
            var txpows = resp && Array.isArray(resp.txpows) ? resp.txpows : null;
            if (!txpows) { shrink(st, offset); return; }        // dropped / over-cap stub → smaller page

            st.skips = 0;
            var details = resp && Array.isArray(resp.details) ? resp.details : [];
            var got = txpows.length;
            var pending = got, hitKnown = false;
            if (got === 0) { afterPage(); return; }

            txpows.forEach(function (tx, i) {
                var e = entryFrom(tx, details[i]);
                if (!e || !e.txpowid) { if (--pending === 0) afterPage(); return; }
                Store.histInsert(e, function (isNew) {
                    if (isNew) st.added++; else hitKnown = true;
                    if (--pending === 0) afterPage();
                });
            });

            function afterPage() {
                if (got < st.pageMax) { markDone(st, function () { finish(st, true); }); return; }   // end of history
                if (!st.backfill && hitKnown) { finish(st, true); return; }                          // caught up
                setTimeout(function () { page(st, offset + got); }, PAGE_DELAY);
            }
        });
    }

    /** A page came back empty or errored: halve and retry the SAME offset. At max:1 the single transaction is
     *  itself over the cap — skip past it so one giant txpow can't stall everything behind it. */
    function shrink(st, offset) {
        if (st.pageMax > 1) {
            st.pageMax = Math.max(1, Math.floor(st.pageMax / 2));
            setTimeout(function () { page(st, offset); }, PAGE_DELAY);
        } else if (++st.skips <= MAX_SKIP) {
            setTimeout(function () { page(st, offset + 1); }, PAGE_DELAY);
        } else {
            finish(st, false);
        }
    }

    function markDone(st, cb) {
        if (!st.backfill) { cb(); return; }
        Store.kvSet("hist_backfilled", "true", cb);
    }

    /**
     * One stored row from a txpow + its `details`.
     *
     * `details.difference` is the node's own per-token net effect on THIS wallet — the ledger primitive, and
     * the thing a statement sums. The raw coin arrays come along too, because they are what makes a routed
     * swap splittable: a pool's own share is Σ(outputs at it) − Σ(inputs at it).
     */
    function entryFrom(tx, detail) {
        if (!tx) return null;
        var hdr = tx.header || {};
        var body = tx.body || {};
        var txn = body.txn || {};
        var diff = (detail && detail.difference) ? detail.difference : {};
        var ins = Array.isArray(txn.inputs) ? txn.inputs : [];
        var outs = Array.isArray(txn.outputs) ? txn.outputs : [];

        var net = 0;
        for (var k in diff) if (diff.hasOwnProperty(k)) { var v = PP.decOr(diff[k], 0); if (v.cmp(0) !== 0) net += v.cmp(0); }
        var incoming = net > 0;

        return {
            txpowid: tx.txpowid || "",
            block: Number(hdr.block || 0),
            timemilli: Number(hdr.timemilli || 0),
            direction: net > 0 ? "received" : (net < 0 ? "sent" : "self"),
            deltas: JSON.stringify(diff || {}),
            counterparty: firstAddr(incoming ? ins : outs),
            inputs: JSON.stringify(coins(ins)),
            outputs: JSON.stringify(coins(outs))
        };
    }

    /** Normalise a coin array down to what the statement needs. A TOKEN coin's quantity is `tokenamount`;
     *  `amount` is the internal coloured-coin value, so reading it for a token gives the wrong number. */
    function coins(arr) {
        var out = [];
        (arr || []).forEach(function (c) {
            if (!c) return;
            var tid = c.tokenid || "0x00";
            // keep BOTH address forms — the known-address set holds 0x and Mx, and either may be absent
            out.push({
                addr: c.miniaddress || c.address || "",
                address: c.address || "",
                miniaddress: c.miniaddress || "",
                amount: PP.isMinima(tid) ? (c.amount || "0")
                                         : (c.tokenamount !== undefined ? c.tokenamount : (c.amount || "0")),
                tokenid: tid
            });
        });
        return out;
    }

    function firstAddr(arr) {
        if (arr && arr.length && arr[0]) return arr[0].miniaddress || arr[0].address || "";
        return "";
    }

    return { sync: sync, isRunning: isRunning, entryFrom: entryFrom };
})();
