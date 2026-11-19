/**
 * activity — the ACTIVITY tab's stage machine (AX.activity). A line-for-line port of the Android
 * ActivityLog (apks/dexicon 0.1.9), itself ported from PandaPools ActivityLog/ActivityTimeline (0.9.67):
 * receipts newest first capped at 60, CONFIRM_BLOCKS 3, the confirmation wording, never a time- or height-based
 * guess of inclusion. Inclusion is proven by an OUTPUT coin (`coins coinid:<out>` → created, or for a BOOK/POOL
 * trade the exact proceeds coin PDService itself matches) — the txnpost txpowid is the PRE-MINING id.
 * confirmations = tip − created. Pure: no MDS, no DOM; the page (ui/activity.js) does the I/O.
 *
 * Stored stages: BUILDING → POSTED (slow) or SENT → COSIGNED (fast); terminal FAILED / REFUSED / DROPPED / LOST.
 * `block` > 0 means "in block"; depth ≥ CONFIRM_BLOCKS means confirmed (slow) / done (fast).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var A = {
        BUILDING: 'BUILDING', POSTED: 'POSTED', SENT: 'SENT', COSIGNED: 'COSIGNED',
        FAILED: 'FAILED', REFUSED: 'REFUSED', DROPPED: 'DROPPED', LOST: 'LOST',
        CONFIRM_BLOCKS: 3, DROP_BLOCKS: 60, LOST_MS: 10 * 60000, REVIVE_MS: 2 * 3600000, MAX: 60
    };
    function n(v) { var x = Number(v || 0); return isFinite(x) ? x : 0; }
    A.failedTerminal = function (a) { var s = a.stage; return s === A.FAILED || s === A.REFUSED || s === A.DROPPED || s === A.LOST; };
    A.tip = function (a, chainBlock) { return Math.max(n(chainBlock), n(a.tip)); };
    A.depth = function (a, chainBlock) { var b = n(a.block); return b > 0 ? Math.max(0, A.tip(a, chainBlock) - b) : -1; };
    A.confirmed = function (a, cb) { return !A.failedTerminal(a) && A.depth(a, cb) >= A.CONFIRM_BLOCKS; };
    A.settled = function (a, cb) { return A.failedTerminal(a) || A.confirmed(a, cb); };
    A.watch = function (a, cb, now) { return !A.settled(a, cb) || (a.stage === A.DROPPED && n(now) - n(a.ts) < A.REVIVE_MS); };
    A.hasPending = function (rows, cb, now) { for (var i = 0; i < rows.length; i++) if (A.watch(rows[i], cb, now)) return true; return false; };
    function fast(a) { return a.route === 'FAST'; }
    A.confirmationText = function (d) { return d + (d === 1 ? ' confirmation' : ' confirmations'); };
    A.secs = function (ms) { return (Math.round(n(ms) / 100) / 10).toFixed(1) + 's'; };

    A.chip = function (a, cb) {
        if (A.failedTerminal(a)) return a.stage;
        var d = A.depth(a, cb);
        if (d >= A.CONFIRM_BLOCKS) return fast(a) ? 'DONE' : 'CONFIRMED';
        if (d >= 0) return fast(a) ? 'SETTLING' : 'IN BLOCK';
        return a.stage === A.COSIGNED ? 'CO-SIGNED' : a.stage;
    };
    function waiting(a, cb) {
        var post = n(a.postBlock), t = A.tip(a, cb), gone = post > 0 && t > post ? t - post : 0;
        return "in the node's mempool, waiting for a block" + (gone > 0 ? ' (' + gone + (gone === 1 ? ' block' : ' blocks') + ' since posting)' : '');
    }
    A.status = function (a, cb, now) {
        var why = a.reason || '', d, b = n(a.block);
        if (a.stage === A.FAILED) return 'Failed — ' + why;
        if (a.stage === A.REFUSED) return 'Refused by the maker — ' + why;
        if (a.stage === A.DROPPED) return 'Dropped — ' + why;
        if (a.stage === A.LOST) return 'Lost — ' + why;
        d = A.depth(a, cb);
        if (d >= A.CONFIRM_BLOCKS) return (fast(a) ? 'Done' : 'Confirmed') + ' · block ' + b + ' · ' + A.confirmationText(d);
        if (d >= 0) return (fast(a) ? 'Settling · in block ' : 'In block ') + b + ' · ' + A.confirmationText(d);
        if (a.stage === A.BUILDING) return why || 'Building and signing…';
        if (a.stage === A.SENT) return 'Take sent to ' + n(a.relays) + ' relay' + (n(a.relays) === 1 ? '' : 's') + ' · waiting for the maker to co-sign ('
            + Math.max(0, Math.floor((n(now) - n(a.sentMs)) / 1000)) + 's)';
        if (a.stage === A.COSIGNED) return (a.role === 'maker' ? 'Co-signed for ' + a.counterparty + ' in ' + A.secs(a.cosignMs) : 'Maker co-signed in ' + A.secs(a.cosignMs)) + ' · ' + waiting(a, cb);
        if (a.stage === A.POSTED) return 'Posted · ' + waiting(a, cb);
        return String(a.stage);
    };

    /** One tracker observation (inputs checked BEFORE the output lookup). Returns true when the row changed. */
    A.observe = function (a, tip, inputGone, outCreated, now) {
        var changed = false, s = a.stage, why = null;
        if (n(tip) > n(a.tip)) { a.tip = n(tip); changed = true; }
        if (s === A.BUILDING && n(now) - n(a.ts) > A.LOST_MS) { a.stage = A.LOST; a.reason = 'the page closed before the outcome was recorded — check ASSETS and TRADES'; return true; }
        if (s === A.SENT && n(now) - n(a.sentMs) > A.LOST_MS) { a.stage = A.LOST; a.reason = 'no answer from the maker within ' + A.LOST_MS / 60000 + ' minutes'; return true; }
        if ((s === A.POSTED || s === A.COSIGNED) && !n(a.postBlock) && n(tip) > 0) { a.postBlock = n(tip); changed = true; }
        if (!(s === A.POSTED || s === A.COSIGNED || s === A.DROPPED) || n(a.block) > 0) return changed;
        if (n(outCreated) > 0) {
            a.block = n(outCreated);
            if (s === A.DROPPED) { a.stage = a.was || A.POSTED; a.reason = ''; }
            return true;
        }
        if (s === A.DROPPED) return changed;
        if (inputGone) why = 'an input was spent by another transaction';
        else if (n(a.postBlock) > 0 && n(tip) - n(a.postBlock) > A.DROP_BLOCKS) why = 'not mined after ' + A.DROP_BLOCKS + ' blocks';
        if (why) { a.was = s; a.stage = A.DROPPED; a.reason = why; return true; }
        return changed;
    };

    /** Insert or replace by id, newest first, keep MAX. */
    A.upsert = function (rows, row) {
        var out = [row];
        for (var i = 0; i < rows.length; i++) if (rows[i].id !== row.id) out.push(rows[i]);
        out.sort(function (x, y) { return n(y.ts) - n(x.ts); });
        return out.slice(0, A.MAX);
    };
    A.find = function (rows, pred) { for (var i = 0; i < rows.length; i++) if (pred(rows[i])) return rows[i]; return null; };

    /** A fill_<txpowid> row (FAST, written by the service or the page) as an activity row — the ActivityTimeline
     *  merge: rows join fills by exact txpowid only; a fill with no row (maker side, or older fills) becomes one. */
    A.fromFill = function (f) {
        var maker = f.role === 'maker';
        return { id: 'fill_' + f.txpowid, route: 'FAST', role: maker ? 'maker' : 'taker', side: f.side, amount: f.filled, price: f.price,
            mxusd: maker ? (f.side === 'sell' ? f.received : f.paid) : (f.side === 'buy' ? f.gave : f.got), orderId: f.orderId || '',
            counterparty: maker ? (f.taker || '') : (f.maker || ''), txpowid: f.txpowid, outs: f.coins || [], ts: n(f.recvMs) || n(f.ts) * 1000,
            cosignMs: n(f.cosignMs), stage: f.status === 'lost' ? A.LOST : A.COSIGNED, reason: f.status === 'lost' ? 'not mined within 2 hours' : '',
            block: f.status === 'done' ? n(f.block) : 0 };
    };
    A.merge = function (rows, fills) {
        var by = {}, out = rows.slice(), i, r, f;
        for (i = 0; i < rows.length; i++) if (rows[i].txpowid) by[String(rows[i].txpowid).toLowerCase()] = rows[i];
        for (i = 0; i < fills.length; i++) {
            f = fills[i]; if (!f || !f.txpowid) continue;
            r = by[String(f.txpowid).toLowerCase()];
            if (!r) { out.push(A.fromFill(f)); continue; }
            if (f.status === 'done' && n(f.block) > 0 && !n(r.block)) r.block = n(f.block);   // the service's settler saw the output first
        }
        out.sort(function (x, y) { return n(y.ts) - n(x.ts); });
        return out;
    };

    /** PDService's in-flight fill_state meta → a slow row. */
    A.fromSlow = function (meta, nowMs) {
        return { id: 'slow_' + meta.txpowid, route: meta.sourceKind || 'BOOK', role: 'taker', side: meta.buy ? 'buy' : 'sell', amount: meta.size, price: meta.price,
            txpowid: meta.txpowid, proceeds: meta.proceeds, postBlock: n(meta.postBlock), tip: n(meta.postBlock), ins: meta.sourceCoinids || [], outs: [],
            ts: n(nowMs), stage: A.POSTED };
    };

    /** The exact proceeds coin (PandaVerify.proceedsPresent's rule: created ≥ postBlock, same token, value equal;
     *  a token coin's value is tokenamount). Returns the coin or null. */
    A.proceedsCoin = function (coins, tok, amount, postBlock) {
        if (!coins || typeof coins.length !== 'number') return null;
        var want = new g.Decimal(String(amount)), i, c, minima = tok === '0x00', v;
        for (i = 0; i < coins.length; i++) {
            c = coins[i];
            if (!c || n(c.created) < n(postBlock) || String(c.tokenid || '0x00').toLowerCase() !== String(tok).toLowerCase()) continue;
            try { v = new g.Decimal(String(minima ? c.amount : (c.tokenamount !== undefined ? c.tokenamount : c.amount))); } catch (e) { continue; }
            if (v.eq(want)) return c;
        }
        return null;
    };
    AX.activity = A;
})(typeof globalThis !== 'undefined' ? globalThis : this);
