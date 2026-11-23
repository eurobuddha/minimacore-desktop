/**
 * takeable — owner 22 Nov 2026: "If an order is not tradable, it shouldn't be displayed anywhere as a real market."
 * A FAST order lists its backing coins by id; a taker can only take it when THIS node can see every one of them
 * unspent (`coins coinid:` on a light node finds a third-party coin only when it was created inside the node's tree,
 * the last ~1024 blocks, and is unspent at its tip). Order 0x77da4748491f267c showed as market while its coin
 * 0xEB4FCEE14E5C14E6E45F69D45B336A9166C73109D3A32328E49DE2885CA88AD8 was ~1826 blocks old: no light node could take it.
 *
 * A verdict is about the ORDER (keyed maker + orderId, re-asked when it is re-signed with other coins/scripts/size/
 * price). 'ok' means the node has shown this order can be taken AS DISPLAYED (0.0.98): the rows its `coins coinid:`
 * returned show EVERY listed coin (a) unspent and out of the mempool, (b)+(c) of the token the maker gives and
 * state-free (AX.fill.makerCoinProblem — the rule plan() refuses a take on), (d) at the address of one of the order's own
 * published `scripts` (scriptAddress: computed here, no node call), and (e) together covering what it displays (ask:
 * amount MINIMA; bid: up8(amount × price) MxUSD). (f) A coin backs at most ONE shown order: the first 'ok' order listing
 * it by price, then time (expiry: the earlier signed first); a later one is 'no'.
 *
 *   check(order, V, me)    PURE. {state:'ok'|'unknown'|'no', reason, why, coins} for one order (V = Cache.verdicts()).
 *   layout(orders, V, me)  PURE, O(n log n). Per side best price first: which orders are SHOWN (the 'ok' ones filling
 *                          LADDER_LEVELS price levels, then SWEEP_MAX_ORDERS more — only 'ok' orders count, so an
 *                          unknown or 'no' order never takes a slot nor evicts a shown one), which are hidden (every
 *                          'no'/'unknown' order before the point where the shown scope is full), and `ask`: the orders
 *                          worth a lookup (the same cut). Orders past the cut are neither shown, counted nor asked.
 *   visible / hidden / summary / report / describe   views over layout (hidden lists at most LIST_MAX, counts all).
 *   Cache(cmd, opts)       the verdicts and the lookups (see warm for the queue and the guarantees). 0.0.112: opts.onMissing(order)
 *                          is told an order whose coin this node does not see (the page asks its maker for the coin's
 *                          proof, lib/proofs.js); proven(ids) re-checks the orders such a 'no' named once a proof was imported.
 *
 * Identifiers are never shortened. Rhino-safe (ES5). Needs Decimal, AX.fill, AXSHA3. Attaches to AX.takeable.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    /** At most this many lookups (node commands) per block HEIGHT, the take's own excluded. */
    var MAX_LOOKUPS_PER_BLOCK = 128;
    /** On a MegaMMR node, at most this many `megammr:true` lookups per height (see lookupCmd). */
    var MEGA_PER_BLOCK = 16, MEGA_SHOWN = 12;   // the shown orders' re-checks take at most 12 of them while others wait (as SHOWN_SHARE)
    /** The shown orders' re-checks take at most this many of them while anything else waits. */
    var SHOWN_SHARE = 96;
    /** ui/pd_app.js renderBookRows draws 10 price levels a side. */
    var LADDER_LEVELS = 10;
    /** One click takes from at most this many orders (ui/app.js reads it from here). */
    var SWEEP_MAX_ORDERS = 12;
    /** An 'ok' is shown only while it was confirmed within this many block heights (at tip-3 .. tip). */
    var STALE_BLOCKS = 3;
    /** A 'no' is asked again after this many heights; a coin being spent in the mempool after MEMPOOL_EVERY. */
    var NO_EVERY = 10, MEMPOOL_EVERY = 2;
    /** Verdicts of orders gone from the book for this many heights are dropped. */
    var KEEP_BLOCKS = 2;
    /** The expanded hidden list shows at most this many orders (all are counted). */
    var LIST_MAX = 50;
    /** A lookup with no answer in this long is abandoned like an error: it never becomes a 'no'. */
    var TIMEOUT_MS = 20000;
    /** NEWBLOCKs closer together than this are the node catching up (see onBlock); the page's 10-second timer settles. */
    var SETTLE_MS = 10000;
    var WHY_NO = 'a backing coin is spent or older than this node\'s chain window';
    var WHY_MEMPOOL = 'a backing coin is being spent (mempool)';
    var WHY_SCRIPT = 'a backing coin is not at one of the order\'s own scripts';
    var WHY_TOKEN = 'a backing coin is the wrong token or carries state';
    var WHY_COVER = 'its backing coins do not cover what it offers';
    var WHY_TWICE = 'its backing coin already backs another order';
    var WHY_TAKE = 'a take of it failed';
    var WHY_COPY = 'its backing coin was proved by another maker';
    var WHY_ATTEST = 'its maker has not proved it controls this coin';

    function lc(s) { return String(s || '').toLowerCase(); }
    function isArr(x) { return Object.prototype.toString.call(x) === '[object Array]'; }
    function noop() { }
    function own(o, mySignPk) { return !!mySignPk && lc(o.signPk) === lc(mySignPk); }
    function priceOf(o) { try { var d = new g.Decimal(String(o.price)); return d.gt(0) ? d : null; } catch (e) { return null; } }
    /** One order, one key: relays key orders by maker + orderId (two makers may use the same orderId). */
    function okey(o) { return lc(o.signPk) + '|' + lc(o.orderId); }
    /** What a verdict is about: a re-signed order with other coins, scripts, size or price is a new question. */
    function fp(o) { return [o.side, o.price, o.amount, (o.coins || []).join(','), (o.scripts || []).join('|')].join('#'); }

    /** UTF-8 bytes of a string as a plain array (no TextEncoder in Rhino). */
    function utf8(str) {
        var out = [], i, c;
        for (i = 0; i < str.length; i++) {
            c = str.charCodeAt(i);
            if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) { c = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00); }
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
            else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return out;
    }
    /** The node's address of a script, as `newscript` registers it (objects/Address.java): the root of a one-leaf MMR =
     *  SHA3-256( MiniNumber 0 · MiniString(script) · MiniNumber 0 ), where MiniNumber 0 = bytes 00 01 00 (scale, length,
     *  unscaled) and MiniString = 4-byte big-endian length + UTF-8. No node call. Pinned against the AtomiX HTLC
     *  addresses the node reports (test/takeable.test.js). '0x' + 64 upper-case hex, cached per script text (bounded).
     *  Needs AXSHA3 (doors/sha3.js, loaded by index.html). */
    var ADDR = {}, ADDR_N = 0, ADDR_MAX = 4096;
    function scriptAddress(script) {
        var k = String(script), hit = ADDR[k], b, n;
        if (hit) return hit;
        b = utf8(k); n = b.length;
        hit = '0x' + String(g.AXSHA3.sha3_256([0, 1, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].concat(b, [0, 1, 0]))).toUpperCase();
        if (ADDR_N >= ADDR_MAX) { ADDR = {}; ADDR_N = 0; }
        ADDR[k] = hit; ADDR_N++;
        return hit;
    }
    function addrsOf(order) { var a = {}, i; for (i = 0; i < (order.scripts || []).length; i++) a[lc(scriptAddress(order.scripts[i]))] = true; return a; }
    /** Why this coin row cannot back this order as displayed (null when it can): (b)(c) via AX.fill, (d) its address. */
    function coinProblem(order, row, addrs) {
        var why = AX.fill.makerCoinProblem(order, row);
        if (why) return { why: WHY_TOKEN, reason: why };
        if (!addrs[lc(row.address)]) return { why: WHY_SCRIPT, reason: 'coin ' + row.coinid + ' is at ' + row.address + ', not at the address of any script this order publishes' };
        return null;
    }
    /** (e) The rows' total against what the order shows; null when covered. */
    function coverProblem(order, rows) {
        var F = AX.fill, sum = F.d(0), need, i;
        for (i = 0; i < rows.length; i++) sum = sum.plus(F.coinValue(rows[i]));
        need = order.side === 'sell' ? F.d(order.amount) : F.up8(F.d(order.amount).times(F.d(order.price)));
        return sum.lt(need) ? { why: WHY_COVER, reason: 'backing coins cover only ' + sum.toFixed() + ' of ' + need.toFixed() + (order.side === 'sell' ? ' MINIMA' : ' MxUSD') } : null;
    }

    /** The verdict of one order. V = Cache.verdicts() = {orders: key → entry, tip: the height verdicts are aged against}. */
    function check(order, V, mySignPk) {
        var coins = (order && order.coins) || [], e;
        if (!coins.length) return { state: 'no', reason: 'lists no backing coins (its maker is re-backing it)', why: 'coinless', coins: [] };
        if (own(order, mySignPk)) return { state: 'ok', reason: 'your own order (shown, never taken)', own: true, coins: [] };
        e = V && V.orders && V.orders[okey(order)];
        if (!e || e.fp !== fp(order) || !e.state) return { state: 'unknown', reason: 'not yet checked by this node', coins: [] };
        if (e.state === 'no') return { state: 'no', reason: e.reason, why: e.why, coins: e.coins || [], atBlock: e.tried };
        if (e.state === 'ok') return V.tip - e.height <= STALE_BLOCKS ? { state: 'ok', reason: '', coins: [], atBlock: e.height }
            : { state: 'unknown', reason: 'not re-confirmed for more than ' + STALE_BLOCKS + ' blocks (last at block ' + e.height + ')', coins: [] };
        return { state: 'unknown', reason: e.reason || 'not yet checked by this node', coins: [] };
    }

    /**
     * The one pass every view and the queue share. Per side, best price first, then time (expiry, then key: stable).
     * Returns {shown: {key: true}, sides: {buy: [x], sell: [x]}, hiddenNo, hiddenUnknown (counts), list (first LIST_MAX
     * hidden: 'no' then 'unknown', best price first), whys ({why: count} of the hidden 'no')}, x = {order, key, check,
     * shown, cut (true past the point where the shown scope is full: not shown, counted or asked)}.
     */
    function layout(orders, V, mySignPk) {
        var sides = { buy: [], sell: [] }, out = { shown: {}, sides: { buy: [], sell: [] }, hiddenNo: 0, hiddenUnknown: 0, list: [], whys: {} },
            claimed = {}, nos = [], unk = [], i, o, p;
        for (i = 0; i < (orders || []).length; i++) {
            o = orders[i];
            if (!o || !(o.coins || []).length || !sides[o.side]) continue;
            if (own(o, mySignPk)) { out.shown[okey(o)] = true; continue; }
            p = priceOf(o);
            if (p) sides[o.side].push({ order: o, p: p, key: okey(o) });
        }
        function time(a, b) { return (Number(a.order.expiry) || 0) - (Number(b.order.expiry) || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); }
        sides.sell.sort(function (a, b) { return a.p.cmp(b.p) || time(a, b); });
        sides.buy.sort(function (a, b) { return b.p.cmp(a.p) || time(a, b); });
        ['buy', 'sell'].forEach(function (s) {
            var levels = 0, last = null, extra = 0, full = false, fresh, j, k, x, c, cs;
            for (j = 0; j < sides[s].length; j++) {
                x = sides[s][j]; cs = x.order.coins;
                if (full) { x.cut = true; out.sides[s].push(x); continue; }
                c = check(x.order, V, mySignPk);
                // review 23 Nov (COPYCAT, partial): a coin this node sees only through an imported proof is takeable only in
                // the orders of the maker whose proof it imported; another identity listing it is hidden and claims nothing
                // 0.0.130: an order whose addresses its maker attested is never hidden by this rule (a copycat that answered
                // with a proof first is recorded as the prover; the attestation says who controls the coin)
                for (k = 0; c.state === 'ok' && V && V.owners && attestOf(x.order, V).state !== 'ok' && k < cs.length; k++) {
                    if (V.owners[lc(cs[k])] && V.owners[lc(cs[k])] !== '*' && V.owners[lc(cs[k])] !== lc(x.order.pubId)) c = { state: 'no', reason: 'its backing coin ' + cs[k] + ' was proved to this node by another maker, ' + V.owners[lc(cs[k])], why: WHY_COPY, coins: [String(cs[k])] };
                }
                // 0.0.129, the coin-key attestation: an address attested for another identity (and not this one), or a
                // signature this node refused, hides the order; with V.requireAttest, so does a missing attestation
                if (c.state === 'ok') {
                    var at = attestOf(x.order, V);
                    if (at.state === 'ok') c.attested = true;
                    else if (at.state !== 'missing' || (V && V.requireAttest)) c = { state: 'no', reason: WHY_ATTEST + ' (' + at.why + ')', why: WHY_ATTEST, coins: [] };
                }
                if (c.state === 'ok') {
                    for (k = 0; k < cs.length && !claimed[lc(cs[k])]; k++) { }
                    if (k < cs.length) c = { state: 'no', reason: 'its backing coin ' + cs[k] + ' already backs order ' + claimed[lc(cs[k])] + ' (first by price, then time)', why: WHY_TWICE, coins: [String(cs[k])] };
                    else for (k = 0; k < cs.length; k++) claimed[lc(cs[k])] = String(x.order.orderId);
                }
                x.check = c;
                if (c.state === 'ok') {
                    fresh = last === null || x.p.cmp(last) !== 0;
                    if (extra === 0 && (levels < LADDER_LEVELS || !fresh)) { if (fresh) { levels++; last = x.p; } }
                    else if (extra < SWEEP_MAX_ORDERS) extra++;
                    else { full = true; x.cut = true; out.sides[s].push(x); continue; }
                    x.shown = true; out.shown[x.key] = true;
                    if (extra >= SWEEP_MAX_ORDERS) full = true;                  // the scope is full: what follows is past the cut
                } else if (c.state === 'no') { out.hiddenNo++; out.whys[c.why || WHY_NO] = (out.whys[c.why || WHY_NO] || 0) + 1; if (nos.length < LIST_MAX) nos.push(x); }
                else { out.hiddenUnknown++; if (unk.length < LIST_MAX) unk.push(x); }
                out.sides[s].push(x);
            }
        });
        out.list = nos.concat(unk).slice(0, LIST_MAX);
        return out;
    }

    /** 0.0.129: the attestation of an order's addresses (each script's) for its signPk, from V.attests (lc address →
     *  {lc signPk: true|false}): {state: 'ok' | 'missing' | 'foreign' | 'bad', why}. */
    function attestOf(o, V) {
        var A = (V && V.attests) || {}, me = lc(o.signPk), i, ad, m, k, other, miss = '';
        for (i = 0; i < (o.scripts || []).length; i++) {
            ad = lc(scriptAddress(o.scripts[i])); m = A[ad] || {};
            if (m[me] === true) continue;
            if (m[me] === false) return { state: 'bad', why: 'its signature for address ' + ad + ' is not valid' };
            other = ''; for (k in m) if (m.hasOwnProperty(k) && m[k] === true) other = k;
            if (other) return { state: 'foreign', why: 'address ' + ad + ' is attested by its key for another maker, ' + other };
            if (!miss) miss = 'no attestation of address ' + ad + ' yet';
        }
        return miss ? { state: 'missing', why: miss } : { state: 'ok', why: '' };
    }
    /** {okey(order): true} for the orders that are market (shown 'ok', and mine). */
    function visible(orders, V, mySignPk) { return layout(orders, V, mySignPk).shown; }
    /** The hidden orders: {no, unknown (counts), list: [{order, check}] (at most LIST_MAX), whys}. */
    function hidden(orders, V, mySignPk) { var l = layout(orders, V, mySignPk); return { no: l.hiddenNo, unknown: l.hiddenUnknown, list: l.list, whys: l.whys }; }
    function plural(n) { return n + ' FAST order' + (n === 1 ? '' : 's'); }
    /** The line under the book ('' when nothing is hidden). */
    function summary(h) {
        var parts = [], ks = Object.keys(h.whys || {});
        if (h.no) parts.push(plural(h.no) + ' hidden: not takeable from this node (' + (ks.length === 1 ? ks[0] : 'tap for each reason') + ')');
        if (h.unknown) parts.push('checking ' + plural(h.unknown) + '…');
        return parts.join(' · ');
    }
    /** One hidden order as plain text lines, every identifier whole. */
    function describe(entry) {
        var o = entry.order, c = entry.check, lines = [o.side.toUpperCase() + ' ' + o.amount + ' MINIMA @ ' + o.price + ' — ' + (c.state === 'no' ? 'not takeable: ' : '') + c.reason
            + (c.atBlock > 0 ? ' (checked at block ' + c.atBlock + ')' : ''), 'order ' + o.orderId, 'maker ' + o.signPk], i;
        for (i = 0; i < (o.coins || []).length; i++) lines.push('coin ' + o.coins[i] + ((c.coins || []).indexOf(String(o.coins[i])) >= 0 ? ' — the coin the reason names' : ''));
        return lines;
    }
    /** {no, unknown (counts), summary (the line), entries: [[lines]] (the first LIST_MAX), more (how many not listed)}. */
    function report(h) {
        var entries = h.list.map(describe);
        return { no: h.no, unknown: h.unknown, summary: summary(h), entries: entries, more: h.no + h.unknown - entries.length };
    }

    /**
     * The verdicts and the lookups. cmd(command, cb(err, rows)) runs ONE node command (AX.mds.cmdR).
     *
     * A lookup is `coins coinid:<id> checkmempool:true`; when it returns nothing for an order that was 'ok' or shown
     * before, `coins coinid:<id>` tells a coin being spent in the mempool ('no' for MEMPOOL_EVERY heights) from one that
     * is spent or outside the window ('no' for NO_EVERY); for any other order it is 'no' for NO_EVERY at once. A node rejecting checkmempool gets the plain lookup for the session, said once through opts.log. Rows
     * live only for the height they were read at (rows, reset on every new height): coin(id) serves a take only such a
     * row, and ask(id) — the take's own lookup, outside the budget — refreshes it.
     *
     * warm(orders, me) — ONE queue per call, rebuilt from the latest book, spending what is left of this height's
     * budget (MAX_LOOKUPS_PER_BLOCK) down it:
     *   0. the SHOWN orders not confirmed at this height, oldest confirmation first — at most SHOWN_SHARE lookups while
     *      the tiers below have work, then again after them (so the display stays honest without starving the rest);
     *   1. orders with no evidence against them: 'unknown' (an error, a timeout, an 'ok' gone stale), a coin that was
     *      being spent in the mempool, or an order shown before (also when re-signed) — oldest attempt first;
     *   2. orders never checked, best price first;
     *   3. 'no' orders whose NO_EVERY heights have passed, oldest attempt first.
     *   Only orders before layout's cut are queued; an order attempted at this height is not queued again (the visit
     *   marks are the attempt heights, so they reset with every height). An order's coins are asked one at a time and
     *   the order is left at its first failing condition (junk costs one or two lookups). Coins shared by orders are asked
     *   once per height. A warm asked while one runs re-runs with the latest book when it ends, in the same height,
     *   while budget is left. A lookup error never turns an 'ok' into anything (it just ages); it leaves others 'unknown'.
     *
     * Guarantees (test/takeable.test.js proves each):
     *   P1 nothing is shown that was not confirmed within STALE_BLOCKS heights (check ages against V.tip);
     *   P2 a shown order whose coins total S lookups is re-confirmed every ceil(D / SHOWN_SHARE) heights when the shown
     *      orders need D lookups in all (every height while D <= 96); tier 1 is served before new orders, so an order
     *      with no evidence against it — an honest one whose lookup failed once, or that was shown and re-signed — is
     *      asked within ceil(W / (128 - min(D, 96))) heights, W = the tier-1 lookups older than it, however many new
     *      junk orders arrive (junk is never in tier 1: it is never 'ok' and never shown); one whose coin was being spent
     *      in the mempool joins tier 1 MEMPOOL_EVERY heights later;
     *   P3 a take never builds on a row read at an older height (coin());
     *   P4 at most MAX_LOOKUPS_PER_BLOCK lookups per height, whatever the number of NEWBLOCK events or warms.
     */
    function Cache(cmd, opts) {
        opts = opts || {};
        this.cmd = cmd; this.onChange = opts.onChange || noop; this.log = opts.log || noop;
        // 0.0.112, the coin proof hand-over (lib/proofs.js): told an order whose coin this node does not see; returns true
        // when it asked the order's maker for proofs (then proven(ids) re-checks the order at once)
        this.onMissing = opts.onMissing || null;
        this.afterPass = opts.afterPass || noop;   // 0.0.121: told when a warm pass ends (the page sends the queued proof requests)
        this.maxPerBlock = opts.maxPerBlock || MAX_LOOKUPS_PER_BLOCK;
        this.shownShare = Math.min(this.maxPerBlock, opts.shownShare || Math.floor(this.maxPerBlock * SHOWN_SHARE / MAX_LOOKUPS_PER_BLOCK));
        this.o = {};          // okey → {fp, state, reason, why, coins, height (last 'ok'), tried, retry, shown, seen}
        this.rows = {};       // lc coin id → {row} | {gone:'missing'|'mempool'}: read at height this.tip
        this.tip = 0;         // the node's height (rows belong to it)
        this.age = 0;         // the height verdicts are aged against (stays put while the node catches up)
        this.spent = 0; this.busy = false; this.again = null; this.lastMs = null; this.catching = false; this.changed = false;
        this.mempool = true;
        this.megammr = false; // 0.0.114: the node keeps a MegaMMR (status.megammr): lookups search it (lookupCmd)
        this.megaSpent = 0; this.megaShown = 0; this.inShown = false;   // megammr:true lookups at this height (MEGA_PER_BLOCK), the shown tier's share
        this.owners = {};     // lc coin id → lc publicId of the maker whose imported proof made it visible (proven)
        this.attests = {};    // 0.0.129: lc address → {lc signPk: true (attested) | false (a refused signature)}
        this.requireAttest = false;   // kv require_attest (the page): a missing attestation hides the order too
        this.onAttest = opts.onAttest || null;   // told an order judged 'ok' (the page asks its maker for attestations)
        this.rev = 0;         // bumps whenever a verdict changes
        this.passes = 0;      // warm passes completed
    }
    Cache.prototype.verdicts = function () { return { orders: this.o, tip: this.age, owners: this.owners, attests: this.attests, requireAttest: this.requireAttest }; };
    /** 0.0.129: an attestation verdict from the proof taker (lib/proofs.js verify): ok true/false for (address, signPk). */
    Cache.prototype.attest = function (address, signPk, ok) {
        var m = this.attests[lc(address)] || (this.attests[lc(address)] = {});
        if (m[lc(signPk)] === ok) return;
        if (Object.keys(this.attests).length > 4096) { this.attests = {}; m = this.attests[lc(address)] = {}; }
        m[lc(signPk)] = ok; this.rev++; this.changed = true; told(this);
    };
    /** The row of a coin read at THIS height (never older: P3), or null. */
    Cache.prototype.coin = function (id) { var r = this.rows[lc(id)]; return r && r.row ? r.row : null; };
    /** 0.0.114: on a node whose `status` says megammr, plain `coins coinid:` does not search the MegaMMR (a coin older than
     *  the tree is not found though `txninput` would spend it); `megammr:true` does. The page sets cache.megammr from status.
     *  Review 23 Nov (MINOR): `megammr:true` copies the node's WHOLE unspent-coin table into a list under the database read
     *  lock and scans it (TxPoWSearcher.searchCoins) — every chain coin, per lookup. So the plain lookup goes first (the
     *  tree: cheap, finds every coin inside the window) and only a coin it does not find is asked of the MegaMMR, at most
     *  MEGA_PER_BLOCK (16) a height; past that the order is 'unknown' and re-checked at the next height; the shown orders' re-checks take at most 12
     *  of them while other orders wait (so ~36 shown old-coin orders stay confirmed within STALE_BLOCKS). 16 because a
     *  shown book is ~44 orders a side at most, almost all on young coins: 16 full-table walks a height (~50 s on mainnet)
     *  bound the lock time while leaving room for the few old coins a book holds. */
    Cache.prototype.lookupCmd = function (id, pool, mega) { return 'coins coinid:' + id + (mega ? ' megammr:true' : '') + (pool ? ' checkmempool:true' : ''); };
    /**
     * A new height. tip <= the last one: ignored (no budget, no aging). Otherwise the rows are dropped (P3); and unless
     * this NEWBLOCK came less than SETTLE_MS after the previous one (`nowMs` given: the node catching up), the budget
     * resets and verdicts age to the new height. While catching up the budget is NOT reset and verdicts keep their age
     * until settle(): the page calls it on its 10-second timer, and it settles once SETTLE_MS pass without a NEWBLOCK.
     */
    Cache.prototype.onBlock = function (tip, nowMs) {
        if (!(tip > this.tip)) return false;
        var burst = nowMs !== undefined && this.lastMs !== null && nowMs - this.lastMs < SETTLE_MS;
        if (nowMs !== undefined) this.lastMs = nowMs;
        this.tip = tip; this.rows = {};
        if (burst) { this.catching = true; return false; }
        this.newAge();
        return true;
    };
    Cache.prototype.newAge = function () {
        var k, e;
        this.catching = false; this.age = this.tip; this.spent = 0; this.megaSpent = 0; this.megaShown = 0; this.rev++; this.changed = true;   // aging may hide or show
        for (k in this.o) if (this.o.hasOwnProperty(k)) { e = this.o[k]; if (this.tip - e.seen > KEEP_BLOCKS) delete this.o[k]; }
    };
    /** True when a catch-up just settled (budget reset, verdicts aged): the caller warms. */
    Cache.prototype.settle = function (nowMs) {
        if (!this.catching || this.lastMs === null || nowMs - this.lastMs < SETTLE_MS) return false;
        this.newAge(); return true;
    };
    function entry(self, o) {
        var k = okey(o), e = self.o[k], f = fp(o);
        if (!e) e = self.o[k] = { fp: f, state: '', tried: 0, height: 0, retry: 0, shown: false, seen: self.tip };
        if (e.fp !== f) { e.fp = f; e.state = ''; e.reason = ''; e.why = ''; e.coins = []; e.tried = 0; e.height = 0; e.retry = 0; }
        return e;
    }
    function put(self, o, e, v) {
        var before = e.state + '|' + e.reason;
        e.state = v.state; e.reason = v.reason || ''; e.why = v.why || ''; e.coins = v.coins || [];
        if (v.state === 'ok') e.height = self.tip;
        if (v.state === 'no') e.retry = self.tip + (v.why === WHY_MEMPOOL ? MEMPOOL_EVERY : NO_EVERY);
        self.rev++;
        if (before !== e.state + '|' + e.reason) self.changed = true;   // told once, when the pass ends (or by flag/refresh)
    }
    function told(self) { if (self.changed) { self.changed = false; self.onChange(); } }
    /** The order judged from this height's rows, or null while a coin has no row yet. */
    function judge(self, o) {
        var addrs = addrsOf(o), rows = [], i, r, bad;
        for (i = 0; i < o.coins.length; i++) {
            r = self.rows[lc(o.coins[i])];
            if (!r) return null;
            if (r.gone) return { state: 'no', reason: r.gone === 'mempool' ? WHY_MEMPOOL + ': ' + o.coins[i] : WHY_NO, why: r.gone === 'mempool' ? WHY_MEMPOOL : WHY_NO, coins: [String(o.coins[i])] };
            if ((bad = coinProblem(o, r.row, addrs))) return { state: 'no', reason: bad.reason, why: bad.why, coins: [String(o.coins[i])] };
            rows.push(r.row);
        }
        bad = coverProblem(o, rows);
        return bad ? { state: 'no', reason: bad.reason, why: bad.why, coins: [] } : { state: 'ok' };
    }
    /** After a take fetched an order's coins: re-judge it from this height's rows; returns check(). */
    Cache.prototype.refresh = function (o, mySignPk) {
        var v = judge(this, o), e;
        if (v) { e = entry(this, o); e.tried = this.tip; put(this, o, e, v); told(this); }
        return check(o, this.verdicts(), mySignPk);
    };
    /** A take of this order failed for a reason that is not the taker's own: 'no' with the node's reason for NO_EVERY
     *  heights (or until re-signed); its rows are dropped so the next look is fresh. */
    Cache.prototype.flag = function (o, reason) {
        var e = entry(this, o);
        e.tried = this.tip; this.recheck(o.coins || []);
        put(this, o, e, { state: 'no', reason: String(reason), why: WHY_TAKE }); told(this);
    };
    /** A take could not use these coins: drop their rows (the next take asks again); the verdict stands until then. */
    Cache.prototype.recheck = function (ids) { for (var i = 0; i < (ids || []).length; i++) delete this.rows[lc(ids[i])]; this.rev++; };
    /** 0.0.112: this node now sees these coins (their proofs were imported, lib/proofs.js; `by`: which maker proved each
     *  imported one, see layout): their rows are dropped and every
     *  order a 'no' named one of them for is unchecked again, so the next warm (the caller's) asks it at this height. */
    Cache.prototype.proven = function (ids, by) {
        var want = {}, i, k, e;
        for (k in by || {}) if (by.hasOwnProperty(k)) this.owners[k] = by[k];
        if (Object.keys(this.owners).length > 4096) this.owners = by || {};
        for (i = 0; i < (ids || []).length; i++) { want[lc(ids[i])] = true; delete this.rows[lc(ids[i])]; }
        for (k in this.o) if (this.o.hasOwnProperty(k)) {
            e = this.o[k];
            for (i = 0; e.state === 'no' && i < (e.coins || []).length; i++) if (want[lc(e.coins[i])]) { e.state = ''; e.reason = ''; e.why = ''; e.coins = []; e.retry = 0; e.tried = 0; this.changed = true; }
        }
        this.rev++; told(this);
    };
    /** One coin lookup now (counted only by warm). cb(err, row or null, 'missing'|'mempool'); the row is kept for this
     *  height. An answer arriving after the height moved on is an error (it says nothing about the new height).
     *  `quick`: a coin not returned is 'missing' without the second (mempool) lookup — warm asks so for orders never
     *  'ok' nor shown (junk costs one command); the take and orders with a good record get the distinction. */
    Cache.prototype.ask = function (id, cb, count, quick) {
        var self = this, tip = this.tip, mega = false;
        function one(pool, next) {
            var settled = false, timer = null;
            if (count) count();
            function answer(err, rows) {
                if (settled) return;
                settled = true;
                if (timer !== null) g.clearTimeout(timer);
                // CommandRunner: "Invalid parameter : checkmempool" (AX.mds errors also echo the command, so match the reason)
                if (err && pool && /invalid param[a-z]*\s*:\s*checkmempool/i.test(String(err.message || err))) {
                    if (self.mempool) {
                        self.mempool = false;
                        self.log('This node rejects `coins coinid: checkmempool:true`: FAST orders are checked with the plain `coins coinid:` lookup for the rest of this session, so a coin already being spent in the mempool can show as takeable until it is mined.');
                    }
                    return one(false, next);
                }
                if (self.tip !== tip) return next(new Error('the chain moved on while coin ' + id + ' was being looked up'));
                if (err || !isArr(rows)) return next(err || new Error('no answer for coin ' + id));
                next(null, rows[0] && rows[0].coinid && rows[0].spent !== true ? rows[0] : null);
            }
            if (typeof g.setTimeout === 'function') timer = g.setTimeout(function () { answer(new Error('timeout')); }, TIMEOUT_MS);
            try { self.cmd(self.lookupCmd(id, pool, mega), answer); } catch (e) { answer(e); }
        }
        one(this.mempool, function first(err, row) {
            if (err) return cb(err, null);
            if (row) { self.rows[lc(id)] = { row: row }; return cb(null, row); }
            if (self.megammr && !mega) {   // not in the tree: the MegaMMR, within its budget
                if (self.megaSpent >= MEGA_PER_BLOCK) return cb(new Error('this height\'s MegaMMR lookups (' + MEGA_PER_BLOCK + ') are used up'), null);
                self.megaSpent++; if (self.inShown) self.megaShown++; mega = true;
                return one(self.mempool, first);
            }
            if (!self.mempool || quick) { self.rows[lc(id)] = { gone: 'missing' }; return cb(null, null, 'missing'); }
            // review 23 Nov (MINOR-2): on the MegaMMR this second look is another full walk — it is counted in the budget too
            if (mega) { if (self.megaSpent >= MEGA_PER_BLOCK) return cb(new Error('this height\'s MegaMMR lookups (' + MEGA_PER_BLOCK + ') are used up'), null); self.megaSpent++; if (self.inShown) self.megaShown++; }
            one(false, function (e2, plain) {   // not returned with the mempool check: is it in the mempool, or gone?
                if (e2) return cb(e2, null);
                var gone = plain ? 'mempool' : 'missing';
                self.rows[lc(id)] = { gone: gone }; cb(null, null, gone);
            });
        });
    };
    /** The queue for this height (tiers 0..3 above), O(n log n). */
    Cache.prototype.queue = function (orders, mySignPk) {
        var l = layout(orders, this.verdicts(), mySignPk), t0 = [], t1 = [], t2 = [], t3 = [], self = this;
        ['buy', 'sell'].forEach(function (s) {
            var xs = l.sides[s], i, x, e, k;
            for (i = 0; i < xs.length; i++) {
                x = xs[i]; k = x.key; e = self.o[k];
                if (e) e.seen = self.tip;
                if (x.cut) continue;
                if (x.shown) { e.shown = true; if (e.height < self.tip && e.tried < self.tip) t0.push({ x: x, k: e.height }); continue; }
                if (e && e.fp === fp(x.order) && e.tried >= self.tip) continue;                         // attempted at this height
                if (!e || e.fp !== fp(x.order) || !e.state) { if (e && e.shown) t1.push({ x: x, k: -1 }); else t2.push({ x: x, k: t2.length }); continue; }
                if (e.state === 'ok') { if (self.age - e.height > STALE_BLOCKS) t1.push({ x: x, k: e.tried }); continue; }   // stale; a fresh one is unshown only when its coin backs a better order
                if (e.state === 'unknown') { t1.push({ x: x, k: e.tried }); continue; }
                if (self.tip < e.retry) continue;
                (e.why === WHY_MEMPOOL || e.shown ? t1 : t3).push({ x: x, k: e.tried });
            }
        });
        function byK(a, b) { return a.k - b.k; }
        t0.sort(byK); t1.sort(byK); t3.sort(byK);
        // t2 keeps best price first per side; interleave the sides so neither waits for the other
        var buys = [], sells = [], i, mixed = [];
        for (i = 0; i < t2.length; i++) (t2[i].x.order.side === 'buy' ? buys : sells).push(t2[i]);
        for (i = 0; i < Math.max(buys.length, sells.length); i++) { if (buys[i]) mixed.push(buys[i]); if (sells[i]) mixed.push(sells[i]); }
        function orders_(a) { return a.map(function (y) { return y.x.order; }); }
        return { shown: orders_(t0), rest: orders_(t1).concat(orders_(mixed), orders_(t3)) };
    };
    Cache.prototype.warm = function (orders, mySignPk, done) {
        var self = this, q, si = 0, ri = 0, qTip;
        if (this.busy) { this.again = { orders: orders, me: mySignPk, done: done }; return; }
        this.busy = true;
        q = this.queue(orders || [], mySignPk); qTip = this.tip;
        function count() { self.spent++; }
        function finish() {
            self.busy = false; self.passes++; told(self); self.afterPass();
            if (self.again) { var a = self.again; self.again = null; return self.warm(a.orders, a.me, function () { if (done) done(); if (a.done) a.done(); }); }
            if (done) done();
        }
        // a loop, not recursion: an order whose rows were all read at this height costs nothing and returns at once
        function nextOrder() {
            for (;;) {
                var o;
                if (self.tip !== qTip) return finish();                       // a new height: this queue is stale; the next warm builds a fresh one
                if (si < q.shown.length && (self.spent < self.shownShare || ri >= q.rest.length) && !(self.megammr && self.megaShown >= MEGA_SHOWN && ri < q.rest.length)) { o = q.shown[si++]; self.inShown = true; }
                else if (ri < q.rest.length) { o = q.rest[ri++]; self.inShown = false; }
                else if (si < q.shown.length) { o = q.shown[si++]; self.inShown = true; }
                else return finish();
                var r = visit(o);
                if (r !== 'next') return r === 'stop' ? finish() : undefined;   // 'wait': a lookup is in flight
            }
        }
        function visit(o) {
            var e = entry(self, o), ci = 0, tip = self.tip, addrs = addrsOf(o), quick = !(e.state === 'ok' || e.shown);
            function step(async) {
                var r = null, v, out;
                for (; ci < o.coins.length; ci++) { r = self.rows[lc(o.coins[ci])]; if (!r || r.gone || coinProblem(o, r.row, addrs)) break; r = null; }
                if (self.tip !== tip) out = 'next';                            // a new height mid-order: queued again next pass
                else if (ci >= o.coins.length || r) {                          // every row read, or the first failing one
                    v = judge(self, o);
                    // 0.0.121 (review 23 Nov, M2): queued for this height's request to its maker → 'no' until its proof is
                    // imported (proven() re-checks it at once); this height's requests full → 'unknown', re-checked next height
                    var m = v && v.why === WHY_NO && self.onMissing ? self.onMissing(o) : false;
                    if (m === true) v.reason = WHY_NO + ' — asked its maker to prove coin ' + v.coins[0];
                    else if (m === 'later') v = { state: 'unknown', reason: 'a backing coin is older than this node\'s chain window: its maker is asked to prove it at the next block' };
                    else if (m) v.reason = WHY_NO + ' — ' + m;
                    if (v) { e.tried = self.tip; put(self, o, e, v); if (v.state === 'ok' && self.onAttest) self.onAttest(o); }
                    out = 'next';
                } else if (self.spent + (self.mempool && !quick ? 2 : 1) * (self.megammr ? 2 : 1) > self.maxPerBlock) out = 'stop';   // MINOR-2: on a MegaMMR node each look may be asked twice (tree, then MegaMMR): up to 4   // a lookup may take 2 commands (P4); this order resumes next height
                else {
                    self.ask(o.coins[ci], function (err) {
                        if (err) {
                            e.tried = self.tip;
                            if (e.state !== 'ok') put(self, o, e, { state: 'unknown', reason: 'the node did not answer for coin ' + o.coins[ci] + ' (' + (err.message || err) + ')' });
                            return nextOrder();
                        }
                        step(true);
                    }, count, quick);
                    return 'wait';
                }
                if (!async) return out;
                if (out === 'stop') finish(); else nextOrder();
            }
            return step(false);
        }
        nextOrder();
    };

    AX.takeable = { check: check, layout: layout, visible: visible, hidden: hidden, summary: summary, describe: describe, report: report, Cache: Cache,
                    scriptAddress: scriptAddress, okey: okey, attestOf: attestOf, WHY_ATTEST: WHY_ATTEST,
                    MAX_LOOKUPS_PER_BLOCK: MAX_LOOKUPS_PER_BLOCK, MEGA_PER_BLOCK: MEGA_PER_BLOCK, SHOWN_SHARE: SHOWN_SHARE, LADDER_LEVELS: LADDER_LEVELS, SWEEP_MAX_ORDERS: SWEEP_MAX_ORDERS,
                    STALE_BLOCKS: STALE_BLOCKS, NO_EVERY: NO_EVERY, MEMPOOL_EVERY: MEMPOOL_EVERY, KEEP_BLOCKS: KEEP_BLOCKS, LIST_MAX: LIST_MAX,
                    TIMEOUT_MS: TIMEOUT_MS, SETTLE_MS: SETTLE_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
