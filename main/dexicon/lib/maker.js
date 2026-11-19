/**
 * maker — MY orders: the kv-backed model shared by the page (which creates/edits/cancels) and the service
 * (which co-signs fills, republishes on coin changes and refreshes expiry). Backing coins are selected from the
 * wallet's state-free, unspent coins of the token the order gives away (sell → MINIMA, buy → MxUSD).
 * Rhino-safe (ES5). Requires AX.mds, AX.fill, AX.envelope, AX.relay. Attaches to AX.maker.
 *
 * kv 'myorders' = JSON array of { orderId, side, price, amount, remaining, coins:[coinid], address, seq, expiry, status }
 *   status: 'live' | 'cancelled' | 'filled'. seq increases on every republish (edit, cancel, refresh, coin change).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var F = AX.fill, E = AX.envelope;
    // owner 7 Nov, the maker heartbeat (mirror of APK 0.2.77): orders live 60 min and are re-signed once under 50 min remain,
    // so a silent maker drops off every relay within 60 min; takers hide orders not re-signed in 65 min (relay.js LIVE_SECONDS)
    var MARKET = 'MINIMA/MxUSD', EXPIRY_SECONDS = 60 * 60, REFRESH_BEFORE_SECONDS = 50 * 60, MAX_COINS = 32;
    /** A light-node taker proves a coin only inside its chain window (~1024 blocks on mainnet). Backing coins older
     *  than this are re-locked by a self-send before they fall out of every taker's view. kv 'coin_max_age' overrides. */
    var COIN_MAX_AGE = 500;
    /** A remainder under 1 MINIMA after a fill is dust nobody can usefully take: the order closes instead of dangling
     *  on every relay (owner, 2026-10-22). Takers also lift a whole order rather than leave less than this behind. */
    var DUST = '1';
    function dust(remaining, amount) { var r = F.d(remaining); return r.gt(0) && r.lt(F.d(DUST)) && r.lt(F.d(amount)); }

    function now() { return Math.floor(Date.now() / 1000); }
    function nextSeq(o) { var s = now(); return s > (o.seq || 0) ? s : (o.seq || 0) + 1; }

    function load(mds, cb) {
        mds.kvGet('myorders', '[]', function (v) {   // mdsw.kvGet calls back with the VALUE only
            var list = []; try { list = JSON.parse(v || '[]'); } catch (e) { list = []; }
            cb(null, list);
        });
    }
    function save(mds, list, cb) { mds.kvSet('myorders', JSON.stringify(list), function (err) { cb(err); }); }

    var SIMPLE = /^RETURN SIGNEDBY\(0x[0-9A-Fa-f]{64}\)$/;
    /** address(lower) → simple script text, from the node's `scripts` list. cb(err, map). */
    function simpleScripts(mds, cb) {
        mds.cmdR('scripts', function (err, r) {
            if (err) return cb(err);
            var rows = Object.prototype.toString.call(r) === '[object Array]' ? r : [], map = {};
            for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].address && SIMPLE.test(String(rows[i].script))) map[String(rows[i].address).toLowerCase()] = rows[i].script;
            cb(null, map);
        });
    }

    /** Spendable, state-free, unspent coins of one token (relevant:true = mine). Only coins at SIMPLE addresses are
     *  usable as backing: a taker needs the address script (published in the order) and txnsign auto signs simple
     *  inputs only. Each coin gets `.script` attached. cb(err, coins). */
    function walletCoins(mds, tokenid, cb) {
        simpleScripts(mds, function (e0, scripts) {
            if (e0) return cb(e0);
            mds.cmdR('coins relevant:true checkmempool:true tokenid:' + tokenid, function (err, r) {   // checkmempool: a coin a pending txn spends is already gone
                if (err) return cb(err);
                var rows = Object.prototype.toString.call(r) === '[object Array]' ? r : [];
                var out = [];
                for (var i = 0; i < rows.length; i++) {
                    var c = rows[i];
                    if (!c || c.spent === true || (c.state && c.state.length) || String(c.tokenid).toLowerCase() !== tokenid.toLowerCase()) continue;
                    var sc = scripts[String(c.address).toLowerCase()];
                    if (!sc) continue;
                    c.script = sc; out.push(c);
                }
                cb(null, out);
            });
        });
    }

    /** Distinct address scripts for a set of coins (the order's `scripts`). */
    function scriptsFor(coins, ids) {
        var want = {}; for (var i = 0; i < ids.length; i++) want[String(ids[i]).toLowerCase()] = true;
        var seen = {}, out = [];
        for (i = 0; i < coins.length; i++) { var c = coins[i]; if (want[String(c.coinid).toLowerCase()] && c.script && !seen[c.script]) { seen[c.script] = true; out.push(c.script); } }
        return out;
    }

    /** Age in blocks of a coin at `tip` (0 when unknown). */
    function ageOf(c, tip) { var cr = parseInt(c.created, 10); return (tip > 0 && cr > 0) ? Math.max(0, tip - cr) : 0; }
    function isFresh(c, tip, maxAge) { return ageOf(c, tip) <= (maxAge || COIN_MAX_AGE); }

    /** Coins a maker needs to back `side`/`price`/`amount`, excluding coins already backing other live orders.
     *  Only FRESH coins (age ≤ maxAge at `tip`) qualify when tip is known: a stale coin is invisible to light-node takers. */
    function backing(side, price, amount, coins, excludeIds, tip, maxAge) {
        var give = side === 'sell' ? F.d(amount) : F.up8(F.d(amount).times(F.d(price)));
        var ex = {}; for (var i = 0; i < (excludeIds || []).length; i++) ex[String(excludeIds[i]).toLowerCase()] = true;
        var free = coins.filter(function (c) { return !ex[String(c.coinid).toLowerCase()] && isFresh(c, tip || 0, maxAge); });
        var p = F.pick(free, give, MAX_COINS);
        if (!p) throw new Error('not enough free, fresh ' + (side === 'sell' ? 'MINIMA' : 'MxUSD') + ' coins to back ' + F.plain(give) + (side === 'sell' ? ' MINIMA' : ' MxUSD'));
        return p.coins.map(function (c) { return c.coinid; });
    }

    /** Current tip block + configured max coin age. cb(tip, maxAge). */
    function chainCtx(mds, cb) {
        mds.cmdR('block', function (err, b) {
            var tip = (!err && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0;
            mds.kvGet('coin_max_age', '', function (v) { var m = parseInt(v, 10); cb(tip, m > 0 ? m : COIN_MAX_AGE); });
        });
    }

    /**
     * Re-lock stale coins: ONE transaction spending exactly these coins back to my own address (same token), so they
     * become fresh coins light-node takers can prove. The node signs all inputs (they are mine). cb(err, txpowid).
     */
    function relock(mds, coins, toAddress, cb) {
        if (!coins.length) return cb(null, null);
        var tok = coins[0].tokenid, sum = F.d(0), id = 'rl' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
        for (var i = 0; i < coins.length; i++) sum = sum.plus(F.coinValue(coins[i]));
        var steps = ['txncreate id:' + id];
        for (i = 0; i < coins.length; i++) steps.push('txninput id:' + id + ' coinid:' + coins[i].coinid + ' scriptmmr:true');
        steps.push('txnoutput id:' + id + ' amount:' + F.plain(sum) + ' address:' + toAddress + (String(tok).toLowerCase() === F.MINIMA ? '' : ' tokenid:' + tok));
        steps.push('txnsign id:' + id + ' publickey:auto');
        var k = 0;
        (function step() {
            if (k >= steps.length) {
                return mds.cmdR('txnpost id:' + id, function (e, post) {
                    var txpowid = post && post.txpow && post.txpow.txpowid;
                    mds.cmd('txndelete id:' + id, function () { cb(e || (txpowid ? null : new Error('relock: no txpowid')), txpowid); });
                });
            }
            var c = steps[k++];
            mds.cmdR(c, function (e) { if (e) return mds.cmd('txndelete id:' + id, function () { cb(new Error(c.split(' ')[0] + ': ' + e.message)); }); step(); });
        })();
    }

    function coinsBackingOthers(list, exceptId) {
        var ids = [];
        for (var i = 0; i < list.length; i++) if (list[i].status === 'live' && list[i].orderId !== exceptId) ids = ids.concat(list[i].coins || []);
        return ids;
    }

    function envelopeFor(me, o) {
        return E.order(me, { market: MARKET, side: o.side, price: o.price, amount: o.status === 'live' ? o.remaining : '0',
                             coins: o.status === 'live' ? o.coins : [], scripts: o.status === 'live' ? (o.scripts || []) : [],
                             address: o.address, orderId: o.orderId, seq: o.seq, expiry: o.expiry });
    }

    /** Publish one order's current state to the relays and persist. cb(err, results). */
    function publish(mds, relay, me, o, cb) {
        var raw;
        try { raw = envelopeFor(me, o); } catch (e) { return cb(e); }
        relay.publish(raw, function (results) {
            var ok = 0; for (var i = 0; i < results.length; i++) if (results[i].ok) ok++;
            cb(ok ? null : new Error('no relay accepted the order' + (results.length ? ': ' + results[0].error : ' (no relays)')), results);
        });
    }

    /** Create: select backing coins, sign, publish, save. cb(err, order). */
    function create(mds, relay, me, params, cb) {
        var side = params.side, price = F.plain(F.d(params.price)), amount = F.plain(F.down8(F.d(params.amount)));
        if (side !== 'buy' && side !== 'sell') return cb(new Error('side must be buy or sell'));
        if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(price) || F.d(price).lte(0)) return cb(new Error('price must be a positive decimal with at most 8 dp'));
        if (F.d(amount).lte(0)) return cb(new Error('amount must be positive'));
        load(mds, function (e0, list) {
            mds.cmdR('getaddress', function (e1, addr) {
                if (e1 || !addr || !addr.address) return cb(e1 || new Error('getaddress failed'));
                walletCoins(mds, side === 'sell' ? F.MINIMA : F.MXUSD, function (e2, coins) {
                    if (e2) return cb(e2);
                    chainCtx(mds, function (tip, maxAge) {
                    var ids;
                    try { ids = backing(side, price, amount, coins, coinsBackingOthers(list, null), tip, maxAge); } catch (e) { return cb(e); }
                    var bytes = new Uint8Array(8);
                    fillRandom(bytes);
                    var o = { orderId: '0x' + AX.hex.to(bytes), side: side, price: price, amount: amount, remaining: amount, coins: ids, scripts: scriptsFor(coins, ids),
                              address: addr.address, seq: now(), expiry: now() + EXPIRY_SECONDS, status: 'live', created: now() };
                    publish(mds, relay, me, o, function (e3, results) {
                        if (e3) return cb(e3);
                        list.push(o);
                        save(mds, list, function (e4) { cb(e4, o, results); });
                    });
                    });
                });
            });
        });
    }
    /** orderId only needs uniqueness, not secrecy: browser CSPRNG when present, else Math.random (Rhino). */
    function fillRandom(u8) {
        if (g.crypto && g.crypto.getRandomValues) { g.crypto.getRandomValues(u8); return; }
        for (var i = 0; i < u8.length; i++) u8[i] = Math.floor(Math.random() * 256);
    }

    /** Cancel: amount 0 with a higher seq, publish, mark cancelled. */
    function cancel(mds, relay, me, orderId, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o) return cb(new Error('unknown order'));
            o.status = 'cancelled'; o.seq = nextSeq(o); o.expiry = now() + 600;
            publish(mds, relay, me, o, function (e1) {
                // 'stale seq' = the relay already holds this order at the same or a newer seq — a cancel sent twice in one second.
                if (e1 && /stale seq$/.test(String(e1.message || e1))) e1 = null;
                save(mds, list, function (e2) { cb(e1 || e2, o); });
            });
        });
    }

    /** Edit price and/or amount: re-select backing, higher seq, publish. */
    function edit(mds, relay, me, orderId, params, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o || o.status !== 'live') return cb(new Error('order is not live'));
            var price = params.price !== undefined ? F.plain(F.d(params.price)) : o.price;
            var amount = params.amount !== undefined ? F.plain(F.down8(F.d(params.amount))) : o.remaining;
            if (F.d(price).lte(0) || F.d(amount).lte(0)) return cb(new Error('price and amount must be positive'));
            walletCoins(mds, o.side === 'sell' ? F.MINIMA : F.MXUSD, function (e2, coins) {
                if (e2) return cb(e2);
                chainCtx(mds, function (tip, maxAge) {
                var ids;
                try { ids = backing(o.side, price, amount, coins, coinsBackingOthers(list, orderId), tip, maxAge); } catch (e) { return cb(e); }
                o.price = price; o.amount = amount; o.remaining = amount; o.coins = ids; o.scripts = scriptsFor(coins, ids); o.seq = nextSeq(o); o.expiry = now() + EXPIRY_SECONDS;
                publish(mds, relay, me, o, function (e3) { save(mds, list, function (e4) { cb(e3 || e4, o); }); });
                });
            });
        });
    }

    /**
     * After a fill the maker signed: reduce remaining, drop the spent coins (the change coin joins once it
     * confirms, via refresh), republish or mark filled. cb(err, order).
     */
    function afterFill(mds, relay, me, orderId, filled, spentCoinIds, cb) {
        load(mds, function (e0, list) {
            var o = find(list, orderId);
            if (!o) return cb(new Error('unknown order'));
            var rem = F.d(o.remaining).minus(F.d(filled));
            var spent = {}; for (var i = 0; i < spentCoinIds.length; i++) spent[String(spentCoinIds[i]).toLowerCase()] = true;
            o.coins = (o.coins || []).filter(function (c) { return !spent[String(c).toLowerCase()]; });
            o.remaining = rem.gt(0) ? F.plain(rem) : '0';
            if (rem.lte(0) || dust(rem, o.amount)) o.status = 'filled';   // dust left over closes the order
            o.seq = nextSeq(o);
            if (o.status === 'filled') { o.expiry = now() + 600; }
            publish(mds, relay, me, o, function (e1) { save(mds, list, function (e2) { cb(e1 || e2, o); }); });
        });
    }

    /**
     * Periodic refresh (service): for every live order make sure its coins still exist unspent, are FRESH and cover
     * the remaining amount (re-select if not), re-lock stale backing coins by a self-send, and republish when coins
     * changed or expiry is within 2 hours. cb(err, republishedCount, relockedTxpowid).
     */
    function refresh(mds, relay, me, cb) {
        load(mds, function (e0, list) {
            var live = list.filter(function (o) { return o.status === 'live'; });
            if (!live.length) return cb(null, 0, null);
            var byTok = { sell: null, buy: null }, n = 0;
            walletCoins(mds, F.MINIMA, function (eA, minima) {
                walletCoins(mds, F.MXUSD, function (eB, mxusd) {
                    if (eA || eB) return cb(eA || eB);
                    byTok.sell = minima || []; byTok.buy = mxusd || [];
                    chainCtx(mds, function (tip, maxAge) {
                    mds.cmdR('getaddress', function (eG, addr) {
                    var myAddr = (!eG && addr && addr.address) || null;
                    // 1. stale coins backing live orders → one relock txn (they come back fresh after a block; the
                    //    orders keep their (now unspendable) coin ids until the next refresh re-backs them).
                    var stale = [], seen = {};
                    live.forEach(function (o) { byTok[o.side].forEach(function (c) {
                        if ((o.coins || []).indexOf(c.coinid) >= 0 && !isFresh(c, tip, maxAge) && !seen[c.coinid]) { seen[c.coinid] = true; stale.push(c); }
                    }); });
                    var byToken = {}; stale.forEach(function (c) { (byToken[c.tokenid] = byToken[c.tokenid] || []).push(c); });
                    var toks = Object.keys(byToken), ti = 0, relocked = null;
                    (function relockNext() {
                        if (ti >= toks.length || !myAddr) return orders();
                        relock(mds, byToken[toks[ti++]], myAddr, function (eR, txpowid) { if (!eR && txpowid) relocked = txpowid; relockNext(); });
                    })();
                    function orders() {
                    var i = 0;
                    function step() {
                        if (i >= live.length) return save(mds, list, function (e) { cb(e, n, relocked); });
                        var o = live[i++];
                        if (dust(o.remaining, o.amount)) { o.status = 'filled'; o.seq = nextSeq(o); o.expiry = now() + 600; return publish(mds, relay, me, o, function () { n++; step(); }); }   // a dust remainder from before the rule
                        var have = {}; byTok[o.side].forEach(function (c) { if (isFresh(c, tip, maxAge)) have[String(c.coinid).toLowerCase()] = true; });
                        var stillThere = (o.coins || []).every(function (c) { return have[String(c).toLowerCase()]; });
                        var covers = false;
                        try { var cov = F.pick(byTok[o.side].filter(function (c) { return (o.coins || []).indexOf(c.coinid) >= 0 && isFresh(c, tip, maxAge); }), o.side === 'sell' ? F.d(o.remaining) : F.up8(F.d(o.remaining).times(F.d(o.price))), MAX_COINS); covers = !!cov; } catch (e) { covers = false; }
                        var needRepub = !stillThere || !covers || (o.expiry - now() < REFRESH_BEFORE_SECONDS);
                        var oldSeq = o.seq, oldExp = o.expiry, oldCoins = o.coins, oldScripts = o.scripts;
                        if (!stillThere || !covers) {
                            try { o.coins = backing(o.side, o.price, o.remaining, byTok[o.side], coinsBackingOthers(list, o.orderId), tip, maxAge); o.scripts = scriptsFor(byTok[o.side], o.coins); }
                            catch (e) {
                                // Nothing fresh to back it with right now (e.g. the relock is still confirming): keep the order
                                // but publish it with NO coins — takers skip it; next refresh re-backs it.
                                o.coins = []; o.scripts = [];
                            }
                        }
                        if (!needRepub) return step();
                        o.seq = nextSeq(o); o.expiry = now() + EXPIRY_SECONDS;
                        // review 7 Nov (M2): only a re-sign some relay accepted is kept; a rejected one stays due for the next pass
                        publish(mds, relay, me, o, function (pe) { if (!pe) n++; else { o.seq = oldSeq; o.expiry = oldExp; o.coins = oldCoins; o.scripts = oldScripts; } step(); });
                    }
                    step();
                    }
                    });
                    });
                });
            });
        });
    }

    /** Back every op from ONE wallet snapshot, in order, never giving a coin to two orders (mirror of
     *  MakerEngine.allocate): an op may reuse its own order's coins, never another live order's or one an earlier op
     *  just took. ops: [{key, orderId|null, side, price, amount}]. Returns [{coins}|{err}]. Pure. */
    function allocate(ops, minima, mxusd, list, tip, maxAge) {
        var taken = {}, own = {}, out = [], i, j;
        for (i = 0; i < list.length; i++) if (list[i].status === 'live') { own[list[i].orderId] = list[i].coins || []; (list[i].coins || []).forEach(function (id) { taken[String(id).toLowerCase()] = true; }); }
        for (i = 0; i < ops.length; i++) {
            var op = ops[i], mine = (op.orderId && own[op.orderId]) || [], ownLc = {}, excl = [], k;
            for (j = 0; j < mine.length; j++) ownLc[String(mine[j]).toLowerCase()] = true;
            for (k in taken) if (!ownLc[k]) excl.push(k);
            try {
                var ids = backing(op.side, op.price, op.amount, op.side === 'sell' ? minima : mxusd, excl, tip, maxAge);
                for (k in ownLc) delete taken[k];
                for (j = 0; j < ids.length; j++) taken[String(ids[j]).toLowerCase()] = true;
                out.push({ coins: ids });
            } catch (e) { out.push({ err: e.message }); }
        }
        return out;
    }

    /** The whole ladder in one go (owner 2026-10-26, like the minimaXT overlay's single book update): ONE address,
     *  ONE tip, backing planned from the caller's wallet snapshot, every envelope signed, then published back to back
     *  and saved ONCE. Edits are kept whatever the relays said (as edit()); creates only when a relay accepted.
     *  cb(errors {key: message}, made {key: order}). */
    function batch(mds, relay, me, ops, minima, mxusd, cb) {
        var errors = {}, made = {};
        if (!ops.length) return cb(errors, made);
        var anyCreate = ops.some(function (o) { return !o.orderId; });
        var go = function (addr) {
            load(mds, function (e0, list) {
                chainCtx(mds, function (tip, maxAge) {
                    var norm = [], i;
                    for (i = 0; i < ops.length; i++) {
                        try {
                            var price = F.plain(F.d(ops[i].price)), amount = F.plain(F.down8(F.d(ops[i].amount)));
                            if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(price) || F.d(price).lte(0) || F.d(amount).lte(0)) throw new Error('bad');
                            norm.push({ key: ops[i].key, orderId: ops[i].orderId, side: ops[i].side, price: price, amount: amount });
                        } catch (e) { errors[ops[i].key] = 'bad price or amount'; }
                    }
                    var alloc = allocate(norm, minima, mxusd, list, tip, maxAge), send = [];
                    for (i = 0; i < norm.length; i++) {
                        var op = norm[i], a = alloc[i], o;
                        if (a.err) { errors[op.key] = a.err; continue; }
                        if (!op.orderId) {
                            if (!addr) { errors[op.key] = 'getaddress failed'; continue; }
                            var bytes = new Uint8Array(8); fillRandom(bytes);
                            o = { orderId: '0x' + AX.hex.to(bytes), side: op.side, address: addr, status: 'live', created: now(), seq: now() };
                        } else {
                            o = find(list, op.orderId);
                            if (!o || o.status !== 'live') { errors[op.key] = 'order is not live'; continue; }
                            o.seq = nextSeq(o);
                        }
                        o.price = op.price; o.amount = op.amount; o.remaining = op.amount; o.coins = a.coins;
                        o.scripts = scriptsFor(op.side === 'sell' ? minima : mxusd, a.coins); o.expiry = now() + EXPIRY_SECONDS;
                        send.push({ op: op, o: o });
                    }
                    var k = 0;
                    (function next() {
                        if (k >= send.length) return save(mds, list, function () { cb(errors, made); });
                        var s = send[k++];
                        publish(mds, relay, me, s.o, function (e) {
                            if (e) errors[s.op.key] = e.message; else made[s.op.key] = s.o;
                            if (!s.op.orderId && !e) list.push(s.o);
                            next();
                        });
                    })();
                });
            });
        };
        if (!anyCreate) return go(null);
        mds.cmdR('getaddress', function (e, a) { go(!e && a && a.address ? a.address : null); });
    }

    /** Of one relay's live orders, which of MINE must be re-sent: any it shows live that is cancelled / filled here,
     *  an older version of one that is live here, or one live here (and unexpired) that the relay does not hold at
     *  all — a relay keeps its book in memory, so a restart drops every order (28 Oct). Mirror of MakerEngine.stale. */
    function stale(relayHas, mySignPk, list) {
        var out = [], held = {};
        relayHas.forEach(function (e) {
            if (String(e.signPk).toLowerCase() !== String(mySignPk).toLowerCase()) return;
            held[e.orderId] = true;
            var o = find(list, e.orderId);
            if (o && (o.status !== 'live' || o.seq > e.seq)) out.push(o);
        });
        list.forEach(function (o) { if (o.status === 'live' && o.expiry > now() + 60 && !held[o.orderId]) out.push(o); });
        return out;
    }

    /** Make every relay agree with this node (owner 2026-10-26: a cancelled order must never stay live on any relay).
     *  cb({checked, fixed, failed, lines}). */
    function syncRelays(mds, relay, me, cb) {
        var rep = { checked: 0, fixed: 0, failed: 0, lines: [] }, urls = relay.relays.slice(), touched = false, mySignPk = '0x' + AX.hex.to(me.signPk);
        load(mds, function (e0, list) {
            (function nextRelay() {
                if (!urls.length) return touched ? save(mds, list, function () { cb(rep); }) : cb(rep);
                var url = urls.shift();
                relay.snapshot(url, function (err, has) {
                    if (err) return nextRelay();
                    rep.checked++;
                    var fix = stale(has, mySignPk, list);
                    (function nextFix() {
                        if (!fix.length) return nextRelay();
                        var o = fix.shift(), raw;
                        if (o.status !== 'live' && o.expiry <= now() + 60) { o.expiry = now() + 600; touched = true; }   // a cancel must still be valid to land
                        try { raw = envelopeFor(me, o); } catch (e) { rep.failed++; return nextFix(); }
                        relay.publishTo(url, raw, function (r) {
                            if (r.ok || r.error === 'stale seq') { rep.fixed++; rep.lines.push('relay ' + url + ' still showed ' + o.orderId + ' — re-sent (' + o.status + ')'); }
                            else { rep.failed++; rep.lines.push('relay ' + url + ' still shows ' + o.orderId + ' and refused the fix: ' + r.error); }
                            nextFix();
                        });
                    })();
                });
            })();
        });
    }

    function find(list, orderId) { for (var i = 0; i < list.length; i++) if (list[i].orderId === orderId) return list[i]; return null; }

    AX.maker = { MARKET: MARKET, COIN_MAX_AGE: COIN_MAX_AGE, load: load, save: save, walletCoins: walletCoins, simpleScripts: simpleScripts, scriptsFor: scriptsFor, backing: backing,
                 ageOf: ageOf, isFresh: isFresh, chainCtx: chainCtx, relock: relock, envelopeFor: envelopeFor,
                 publish: publish, create: create, cancel: cancel, edit: edit, afterFill: afterFill, refresh: refresh, find: find, DUST: DUST, dust: dust, allocate: allocate, batch: batch, stale: stale, syncRelays: syncRelays };
})(typeof globalThis !== 'undefined' ? globalThis : this);
