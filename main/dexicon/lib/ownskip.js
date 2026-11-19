/**
 * ownskip — an order never fills against your OWN on-chain order (owner 19 Nov 2026: "market orders should not be
 * refused if we have orders in the stack"). The vendored PandaDEX planners (resting/composite.js PandaComposite.plan,
 * resting/book.js PandaBook.plan) route over every fillable order, your own included. install() wraps both so your own
 * orders are taken out of the book BEFORE they plan: the plan routes past them to the next best third-party order or
 * pool, inside the same limit, with the same price order and tie-breaks, and its totals and average never count them.
 * Pools are untouched, your own pool included (owner: a pool trade pays its fee; an LP may arbitrage its own pool).
 * The FAST book already skips your own orders (ui/app.js crossing) and lib/fill.js refuses one as the last line.
 * resting/ stays byte-identical to pandadex-mds (test/vendor.sh), which is why this is a wrapper and not an edit there.
 * Rhino-safe (ES5). Attaches to AX.ownskip.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var ONLY_OWN = 'Only your own orders are at this price, so there is nothing to trade against. Nothing was sent.';
    var KEYS = "Still reading this wallet's keys, so your own orders cannot be told apart yet. Try again in a moment";
    var raw = null;   // the unwrapped planners, kept for onlyOwn

    function split(book, isMine, wantMine) {
        var out = [], i;
        for (i = 0; i < (book || []).length; i++) if (book[i] && !!isMine(book[i]) === wantMine) out.push(book[i]);
        return out;
    }
    /** Wrap the two planners, once. isMine(order) → true for an order of this node; keysKnown() → false while the
     *  node's key list is unread (every order would look foreign): a non-empty book is then not planned at all. */
    function install(C, B, isMine, keysKnown) {
        if (raw) return;
        raw = { C: C, B: B, comp: C.plan, book: B.plan, isMine: isMine };
        function others(book) {
            if (book && book.length && keysKnown && !keysKnown()) throw new Error(KEYS);
            return split(book, isMine, false);
        }
        C.plan = function (book, pools, takerBuys, wantMinima, limitPrice, chainBlock) { return raw.comp.call(C, others(book), pools, takerBuys, wantMinima, limitPrice, chainBlock); };
        B.plan = function (book, buy, amount, limit, block) { return raw.book.call(B, others(book), buy, amount, limit, block); };
    }
    /** The plain sentence when this order has NOTHING but your own orders to trade against (no third-party order or
     *  pool inside its limit, and at least one of your own orders there); '' when it can trade, or simply rests. */
    function onlyOwn(book, pools, buy, minima, price, block) {
        if (!raw) return '';
        if (!raw.C.isEmpty(raw.comp.call(raw.C, split(book, raw.isMine, false), pools, buy, minima, price, block))) return '';
        return raw.book.call(raw.B, split(book, raw.isMine, true), buy, minima, price, block).takes.length ? ONLY_OWN : '';
    }

    AX.ownskip = { install: install, onlyOwn: onlyOwn, ONLY_OWN: ONLY_OWN, _reset: function () { if (raw) { raw.C.plan = raw.comp; raw.B.plan = raw.book; raw = null; } } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
