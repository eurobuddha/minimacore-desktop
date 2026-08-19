/**
 * order — port of native swap/Order.java. The maker's advertised order: two-sided ladder per traded symbol
 * ("USDT"), wire-serialised as the signed state[99] blob. Byte-parity with native is an interop anchor, INCLUDING
 * the naming inversion: scalar `buy` = best ASK (maker SELLS mxUSDT, higher price), `sell` = best BID (maker BUYS
 * mxUSDT, lower); `bids` pair with `sell`, `asks` with `buy`. Attaches to AX.order.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var SYM = 'USDT';
    var MAX_LEVELS = 6;

    function level(p, a) { return { p: Number(p), a: Number(a) }; }
    function pair(enable, buy, sell, min) {
        return { en: !!enable, buy: Number(buy) || 0, sell: Number(sell) || 0, min: Number(min) || 0, bids: [], asks: [] };
    }

    /** A fresh empty order for identity `id` (used for a tombstone / disarmed responder). */
    function make() {
        return {
            mpk: '', eth: '', cid: '', ts: 0, minimaAvail: 0, usdtAvail: 0,
            signerPk: '', coinid: '', pairs: {}
        };
    }

    function finite(v) { return (isFinite(v) && v > 0) ? v : 0; }
    /** MA-19: a non-empty hex string (optional 0x). Local copy so ingest validation has no load-order dependency. */
    function isHex(v) {
        if (v == null) return false;
        var s = String(v).trim().replace(/^0x/i, '');
        return s.length > 0 && /^[0-9a-fA-F]+$/.test(s);
    }

    // ---- effective levels: enable-aware; a disabled pair advertises NOTHING (this is how a tombstone works) ----
    function effectiveBids(o, sym) {
        var p = o.pairs[sym];
        if (!p || !p.en) return [];
        if (p.bids.length) return p.bids;
        return p.sell > 0 ? [level(p.sell, o.usdtAvail > 0 ? o.usdtAvail / p.sell : 0)] : [];
    }
    function effectiveAsks(o, sym) {
        var p = o.pairs[sym];
        if (!p || !p.en) return [];
        if (p.asks.length) return p.asks;
        return p.buy > 0 ? [level(p.buy, o.minimaAvail)] : [];
    }
    function hasLiquidity(o) {
        for (var sym in o.pairs) if (effectiveBids(o, sym).length || effectiveAsks(o, sym).length) return true;
        return false;
    }

    // ---- sanitize a pair: valid levels only, bids price-DESC / asks price-ASC (best first), ≤ MAX_LEVELS,
    //      derive the legacy best-price scalars. ----
    function validLevel(l) { return l && isFinite(l.p) && l.p > 0 && isFinite(l.a) && l.a > 0; }
    function sanitizePair(p) {
        p.bids = p.bids.filter(validLevel).sort(function (a, b) { return b.p - a.p; }).slice(0, MAX_LEVELS);
        p.asks = p.asks.filter(validLevel).sort(function (a, b) { return a.p - b.p; }).slice(0, MAX_LEVELS);
        p.sell = p.bids.length ? p.bids[0].p : 0;   // best (highest) bid
        p.buy = p.asks.length ? p.asks[0].p : 0;    // best (lowest) ask
    }
    function sanitize(o) { for (var sym in o.pairs) sanitizePair(o.pairs[sym]); return o; }

    /** Trim a pair's advertised ask ladder to its first k (best-price) tranches — a maker must never advertise
     *  a tranche its free balance can't back (native Order.trimAsks). If trimmed to nothing, ALSO clear the
     *  legacy best-ask scalar — else effectiveAsks would resurrect a synthetic single ask for the whole balance,
     *  exactly the unbacked tranche being avoided. */
    function trimAsks(p, k) {
        if (!p || !p.asks.length || k < 0) return;
        while (p.asks.length > k) p.asks.pop();
        if (!p.asks.length) p.buy = 0;
    }

    // ---- wire codec (exact native field names + inversion) ----
    function toJson(o) {
        var pairs = {};
        for (var sym in o.pairs) {
            var p = o.pairs[sym], j = { en: p.en, buy: p.buy, sell: p.sell, min: p.min };
            if (p.bids.length) j.bids = p.bids.map(function (l) { return { p: l.p, a: l.a }; });
            if (p.asks.length) j.asks = p.asks.map(function (l) { return { p: l.p, a: l.a }; });
            pairs[sym] = j;
        }
        return { mpk: o.mpk, eth: o.eth, cid: o.cid, ts: o.ts, bal: { m: o.minimaAvail, u: o.usdtAvail }, pairs: pairs };
    }
    function fromJson(j) {
        var o = make();
        o.mpk = j.mpk || ''; o.eth = j.eth || ''; o.cid = j.cid || ''; o.ts = Number(j.ts) || 0;
        // MA-19 (defence in depth): the Ed25519 signature proves AUTHORSHIP, not well-formedness. Blank a non-hex
        // mpk/eth so a hostile maker can't smuggle a node-command-injecting string through to htlc.lock. A blanked
        // key makes the order un-tradeable, not fatal.
        if (o.mpk && !isHex(o.mpk)) o.mpk = '';
        if (o.eth && !isHex(o.eth)) o.eth = '';
        if (j.bal) { o.minimaAvail = finite(Number(j.bal.m)); o.usdtAvail = finite(Number(j.bal.u)); }
        var jp = j.pairs || {};
        for (var sym in jp) {
            var v = jp[sym], p = pair(v.en, v.buy, v.sell, v.min);
            if (v.bids) for (var i = 0; i < v.bids.length; i++) p.bids.push(level(v.bids[i].p, v.bids[i].a));
            if (v.asks) for (var k = 0; k < v.asks.length; k++) p.asks.push(level(v.asks[k].p, v.asks[k].a));
            o.pairs[sym] = p;
        }
        return o;
    }

    /** Canonical signed bytes = JSON.stringify(toJson(o)) — the blob in state[99] the signature covers. */
    function canonicalJson(o) { return JSON.stringify(toJson(o)); }

    AX.order = {
        SYM: SYM, MAX_LEVELS: MAX_LEVELS, make: make, level: level, pair: pair, finite: finite,
        effectiveBids: effectiveBids, effectiveAsks: effectiveAsks, hasLiquidity: hasLiquidity,
        sanitize: sanitize, sanitizePair: sanitizePair, trimAsks: trimAsks,
        toJson: toJson, fromJson: fromJson, canonicalJson: canonicalJson
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
