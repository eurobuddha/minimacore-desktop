/**
 * ladder — the FAST market maker (mirror of Dexicon Android 0.1.20 maker/Ladder.java + LadderRunner.java): AtomiX's
 * market editor model (A1..A6 asks above mid, B1..B6 bids below; pegged to the MEXC mid × (1 + skew %) at step %
 * spacing, or manual rows) published as one FAST order per rung, kept live by service.js.
 * Feed rules are AtomiX PriceOracle's: fresh ≤ 5 min tight; stale → spread widens linearly to ×10 over 90 min; no
 * price, or stale past 12 h → withdraw; a > 50 % jump needs a second agreeing read. The MEXC fetch itself is
 * PandaPrice (resting/price.js, already loaded in the service); feed() below gives it the APK's one fallback, MEXC's own
 * ticker as CoinGecko rebroadcasts it, for when MEXC cannot be reached. Asks round UP, bids DOWN, to 8 dp.
 * Rhino-safe (ES5). Requires AX.fill, AX.maker. Attaches to AX.ladder.
 *
 * kv 'mm_config' = config JSON · 'mm_ids' = { rungKey: orderId } · 'mm_status' = status text · 'mm_dirty' = '1' after SAVE
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var F = AX.fill, M = AX.maker;
    // 10 rungs a side (owner 18 Nov 2026: "why am I restricted to 6 legs? make it 10 max"). A config saved with six rows
    // reads as before (the missing rows are blank); an editor that only shows six still writes six.
    var MAX_LEVELS = 10, FRESH_MS = 5 * 60000, WIDEN_FULL_MS = 90 * 60000, MAX_WIDEN = 10, HARD_STALE_MS = 12 * 3600000;
    // JUMP/CONFIRM: security review 30 Oct (mirror of the APK 0.1.54 MexcFeed) — a move over 3 % is followed only once it
    // HOLDS (a second read within 1 % of it, at least 60 s later), so a cheap push on MEXC cannot reprice the ladder
    var PASS_GAP_MS = 15000, SPLIT_GAP_MS = 180000, JUMP = 0.03, CONFIRM_BAND = 0.01, CONFIRM_MS = 60000;

    function D(v) { return F.d(v); }
    function parse(s, signed) {
        var v = s === undefined || s === null ? '' : String(s).trim();
        if (v === '') return D(0);
        if (!(signed ? /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/ : /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/).test(v)) return null;
        return D(v);
    }
    function blankConfig() {
        var c = { enabled: false, peg: false, mid: '', step: '', levels: '1', askSize: '', bidSize: '', skew: '', reprice: '1', autoCross: false, crossPerHour: '3', asks: [], bids: [] };
        for (var i = 0; i < MAX_LEVELS; i++) { c.asks.push(['', '']); c.bids.push(['', '']); }
        return c;
    }
    function fromJson(s) {
        var c = blankConfig(), j;
        try { j = JSON.parse(s || '{}') || {}; } catch (e) { return c; }
        for (var k in c) if (j[k] !== undefined && k !== 'asks' && k !== 'bids') c[k] = j[k];
        for (var i = 0; i < MAX_LEVELS; i++) {
            if (j.asks && j.asks[i]) c.asks[i] = [String(j.asks[i][0] || ''), String(j.asks[i][1] || '')];
            if (j.bids && j.bids[i]) c.bids[i] = [String(j.bids[i][0] || ''), String(j.bids[i][1] || '')];
        }
        c.enabled = !!c.enabled; c.peg = !!c.peg; c.autoCross = !!c.autoCross; c.crossPerHour = String(c.crossPerHour);
        return c;
    }
    function levelCount(c) { var n = parseInt(c.levels, 10); if (!(n >= 1)) n = 1; return Math.min(MAX_LEVELS, n); }

    function generate(mid, stepPct, levels, askSize, bidSize) {
        var out = [], i, off, p, a8, b8;
        if (!mid || mid.lte(0) || !stepPct || stepPct.lte(0)) return out;
        a8 = F.down8(askSize || D(0)); b8 = F.down8(bidSize || D(0));
        for (i = 1; i <= Math.max(1, Math.min(MAX_LEVELS, levels)); i++) {
            off = stepPct.times(i).div(100);
            if (a8.gt(0)) out.push({ key: 'A' + i, side: 'sell', price: F.up8(mid.times(D(1).plus(off))), amount: a8 });
            if (b8.gt(0)) { p = F.down8(mid.times(D(1).minus(off))); if (p.gt(0)) out.push({ key: 'B' + i, side: 'buy', price: p, amount: b8 }); }
        }
        return out;
    }

    /** Rungs to have live now. Pegged: around feedMid with the spread × widen; manual: the typed rows. */
    function desired(c, feedMid, widen) {
        var out = [], i, step, ask, bid, skew, mid;
        if (!c.enabled) return out;
        if (c.peg) {
            step = parse(c.step); ask = parse(c.askSize); bid = parse(c.bidSize); skew = parse(c.skew, true);
            if (!step || !ask || !bid || !skew || !(feedMid > 0)) return out;
            if (skew.lt(-20)) skew = D(-20); if (skew.gt(20)) skew = D(20);
            mid = D(String(feedMid)).times(D(1).plus(skew.div(100)));
            return generate(mid, step.times(D(String(Math.max(1, widen)))), levelCount(c), ask, bid);
        }
        for (i = 0; i < MAX_LEVELS; i++) {
            row(out, 'A' + (i + 1), 'sell', c.asks[i], true);
            row(out, 'B' + (i + 1), 'buy', c.bids[i], false);
        }
        return out;
    }
    function row(out, key, side, r, up) {
        var p = parse(r[0]), a = parse(r[1]);
        if (!p || !a || p.lte(0) || a.lte(0)) return;
        out.push({ key: key, side: side, price: up ? F.up8(p) : F.down8(p), amount: F.down8(a) });
    }

    /** Pegged: edit when the live price drifted ≥ reprice % (min 0.1); manual: on any price change; either way a
     *  part-filled rung is topped back up to its size. */
    function needsEdit(want, livePrice, liveRemaining, peg, reprice) {
        if (!D(liveRemaining).eq(want.amount)) return true;
        if (!peg) return !D(livePrice).eq(want.price);
        var th = parse(reprice); if (!th || th.lt(D('0.1'))) th = D('0.1');
        return D(livePrice).minus(want.price).abs().times(100).div(want.price).gte(th);
    }
    function commits(rungs) {
        var m = D(0), u = D(0);
        for (var i = 0; i < rungs.length; i++) { if (rungs[i].side === 'sell') m = m.plus(rungs[i].amount); else u = u.plus(F.up8(rungs[i].amount.times(rungs[i].price))); }
        return { minima: m, mxusd: u };
    }
    function validate(c) {
        var f = [c.mid, c.step, c.levels, c.askSize, c.bidSize, c.reprice], i;
        for (i = 0; i < f.length; i++) if (parse(f[i]) === null) return 'A field holds something that is not a number: ' + f[i];
        if (parse(c.skew, true) === null) return 'Skew must be a number (it may be negative)';
        for (i = 0; i < MAX_LEVELS; i++) if (parse(c.asks[i][0]) === null || parse(c.asks[i][1]) === null || parse(c.bids[i][0]) === null || parse(c.bids[i][1]) === null) return 'Rung ' + (i + 1) + ' has a malformed price or amount';
        if (!c.enabled) return null;
        if (c.peg) {
            if (parse(c.step).lte(0)) return 'Pegged needs a step % above 0';
            if (parse(c.askSize).lte(0) && parse(c.bidSize).lte(0)) return 'Pegged needs an ask size or a bid size';
            return null;
        }
        return desired(c, 0, 1).length ? null : 'No rung has both a price and an amount';
    }

    // ---- feed rules (AtomiX PriceOracle) over PandaPrice's fetch ----
    function wideningFactor(ageMs) {
        if (ageMs <= FRESH_MS) return 1;
        var t = (ageMs - FRESH_MS) / (WIDEN_FULL_MS - FRESH_MS);
        return 1 + (MAX_WIDEN - 1) * Math.max(0, Math.min(1, t));
    }
    /** The two-read jump guard AtomiX applies: a mid > 50 % away from the last one the ladder used is held until a
     *  second read lands within 10 % of it. state = { mid, suspect }. Returns the mid to price from (0 = none). */
    function guard(state, mid, now) {
        now = now || Date.now();
        if (!(mid > 0)) return state.mid || 0;
        if (state.mid > 0 && Math.abs(mid - state.mid) / state.mid > JUMP) {
            // security review 7 Nov (mirror of APK 0.2.46): reads that stay on the SAME side beyond JUMP for CONFIRM_MS
            // confirm the move (a trend no longer resets the timer forever); while pending, pass() withdraws the pegged
            // ladder and auto-cross waits, so nothing is quoted or refilled at the old price
            var sameSide = state.suspect > 0 && (mid - state.mid > 0) === (state.suspect - state.mid > 0);
            if (!sameSide) { state.suspect = mid; state.suspectAt = now; return state.mid; }
            state.suspect = mid;
            if (now - (state.suspectAt || 0) < CONFIRM_MS) return state.mid;
        }
        state.suspect = 0; state.mid = mid; return mid;
    }
    function feedLine(P) {
        var mid = P.mid(), age = P.ageMs();
        if (!(mid > 0)) return 'MEXC: ' + (P.lastError ? 'unavailable (' + P.lastError + ')' : 'no price yet');
        return (P.source && P.source !== 'MEXC' ? P.source + ' mid (MEXC direct unreachable) ' : 'MEXC mid ') + mid + ' · ' + Math.floor(age / 1000) + 's ago' + (age > FRESH_MS ? ' — STALE · spread ×' + wideningFactor(age).toFixed(1) : '');
    }

    // ---- the price fallback (mirror of the APK maker/MexcFeed.java, 9 Nov) ----
    // MEXC is the only price. When MEXC cannot be REACHED (both direct calls fail to return JSON; a thin or crossed book
    // is an answer and stands), the feed reads MEXC's OWN MINIMA/USDT ticker as CoinGecko rebroadcasts it: never another
    // exchange, never an average. It passes PandaPrice.accept like any read, is aged from CoinGecko's fetch time (so
    // an old one widens the spread), and the jump guard above applies to it as to any mid.
    var GECKO_MEXC_URL = 'https://api.coingecko.com/api/v3/coins/minima/tickers?exchange_ids=mxc', VIA_GECKO = 'MEXC via CoinGecko';
    /** "2026-11-09T09:53:00+00:00" (or Z) → unix ms, 0 when it is anything else. By hand, so Rhino and a browser cannot disagree. */
    function isoMs(s) {
        var m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(Z|[+-]\d\d:\d\d)$/.exec(String(s || '')), t, z;
        if (!m) return 0;
        t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); z = m[7];
        if (z !== 'Z') t -= (z.charAt(0) === '-' ? -1 : 1) * ((+z.substring(1, 3)) * 60 + (+z.substring(4, 6))) * 60000;
        return t > 0 ? t : 0;
    }
    /** CoinGecko's MEXC MINIMA/USDT ticker → [bid, ask, dataAtMs]: MEXC's last trade ± half MEXC's bid-ask spread, dated by
     *  CoinGecko's fetch (a future stamp counts as now). null unless the MEXC/USDT row is there and not stale/anomalous. Pure. */
    function parseGeckoMexc(d, nowMs) {
        var ts = d && d.tickers, i, t, last, sp, at, half, yes = function (v) { return v === true || v === 'true'; };
        if (!ts || !ts.length) return null;
        for (i = 0; i < ts.length; i++) {
            t = ts[i];
            if (!t || !t.market || t.market.identifier !== 'mxc' || t.target !== 'USDT') continue;
            if (yes(t.is_stale) || yes(t.is_anomaly)) return null;
            last = Number(t.last); sp = t.bid_ask_spread_percentage === null || t.bid_ask_spread_percentage === undefined ? -1 : Number(t.bid_ask_spread_percentage);
            at = isoMs(t.last_fetch_at);
            if (!(last > 0) || !(sp >= 0) || !(at > 0)) return null;
            half = last * sp / 200;
            return [last - half, last + half, Math.min(at, nowMs)];
        }
        return null;
    }
    /** PandaPrice.refreshAsync with the fallback: depth, then bookTicker (as before), then MEXC via CoinGecko ONLY when
     *  neither MEXC call returned JSON. Same 30 s gap and stuck-fetch rule; no timers; never a guessed price. */
    function refresh(P, done) {
        var now = Date.now();
        done = done || function () { };
        if (P.fetching && now - P.lastTryMs > P.FETCH_STUCK_MS) { P.fetching = false; P.lastError = 'price feed timed out'; }
        if (P.fetching || now - P.lastTryMs < P.FETCH_GAP_MS) return done(null, P.mid());
        P.fetching = true; P.lastTryMs = now;
        function end(err) { P.fetching = false; if (err) { P.lastError = err; return done(err); } done(null, P.mid()); }
        function take(bid, ask, src, dataAt) {   // one read through PandaPrice.accept's rules → '' or why it was refused
            try { P.accept(bid, ask); } catch (e) { return String(e); }
            P.source = src; if (dataAt && dataAt < P.fetchedAt) P.fetchedAt = dataAt;
            return '';
        }
        P.http(P.DEPTH_URL, function (e1, depth) {
            var thin = e1 ? '' : take(P.effectiveLevel(depth && depth.bids), P.effectiveLevel(depth && depth.asks), 'MEXC');
            if (!e1 && !thin) return end();
            P.http(P.BOOK_URL, function (e2, book) {
                var bad = e2 ? '' : take(Number(book && book.bidPrice || 0), Number(book && book.askPrice || 0), 'MEXC');
                if (!e2 && !bad) return end();
                if (!e1 || !e2) return end(bad || thin);   // MEXC answered: its answer stands, no fallback
                P.http(GECKO_MEXC_URL, function (e3, t) {
                    var r = e3 ? null : parseGeckoMexc(t, Date.now());
                    var why = e3 ? String(e3) : r ? take(r[0], r[1], VIA_GECKO, r[2]) : 'no fresh MEXC ticker on CoinGecko';
                    end(why ? 'MEXC ' + e2 + '; via CoinGecko ' + why : '');
                });
            });
        });
    }
    /** Give PandaPrice the fallback. service.js calls it once, after resting/price.js is loaded. */
    function feed(P) { P.source = 'MEXC'; P.refreshAsync = function (done) { refresh(P, done); }; return P; }

    // ---- the runner (service.js tick) ----
    var state = { lastPass: 0, lastSplit: {}, feed: { mid: 0, suspect: 0 } };
    function kvJson(mds, k, def, cb) { mds.kvGet(k, def, function (v) { try { cb(JSON.parse(v || def)); } catch (e) { cb(JSON.parse(def)); } }); }

    /** One reconcile pass. ctx = { mds, relay, me, price (PandaPrice), log }. cb() always. */
    function pass(ctx, cb) {
        var mds = ctx.mds, now = Date.now();
        mds.kvGet('mm_config', '', function (cs) {
            var c = fromJson(cs);
            if (c.enabled && c.peg && ctx.price) ctx.price.refreshAsync();
            // the first MEXC price of a fresh service is still on its way: keep the live ladder instead of withdrawing it
            if (c.enabled && c.peg && ctx.price && !(ctx.price.mid() > 0) && !ctx.price.lastError) return cb();
            mds.kvGet('mm_dirty', '', function (dirty) {
                if (!dirty && now - state.lastPass < PASS_GAP_MS) return cb();
                state.lastPass = now;
                var go = function () {
                    kvJson(mds, 'mm_ids', '{}', function (ids) {
                        if (!c.enabled) return cancelAll(ctx, ids, 'OFF', cb);
                        var mid = 0, age = 0, widen = 1;
                        if (c.peg) {
                            age = ctx.price.ageMs();
                            mid = guard(state.feed, ctx.price.mid());
                            if (state.feed.suspect > 0) return cancelAll(ctx, ids, 'WITHDRAWN — MEXC moved over ' + (JUMP * 100) + ' %; re-quotes once the move holds for ' + (CONFIRM_MS / 1000) + ' s (' + feedLine(ctx.price) + ').', cb);
                            if (!(mid > 0) || age > HARD_STALE_MS) return cancelAll(ctx, ids, 'WITHDRAWN — no usable MEXC price (' + feedLine(ctx.price) + '). Re-quotes when the feed is back.', cb);
                            widen = wideningFactor(age);
                        }
                        reconcile(ctx, c, desired(c, mid, widen), ids, widen, !!dirty, cb);
                    });
                };
                if (dirty) mds.kvSet('mm_dirty', '', go); else go();
            });
        });
    }

    /** Diff the wanted rungs against the live ones, then send every create / edit as ONE batch (one wallet read,
     *  one address, one tip — mirror of LadderRunner). Edits are in place (a higher seq): a re-price leaves no gap. */
    // saved: this pass follows a SAVE, so every rung re-prices to the new settings, not only those past the reprice %
    function reconcile(ctx, c, want, ids, widen, saved, cb) {
        M.walletCoins(ctx.mds, F.MINIMA, function (ea, mc) { M.walletCoins(ctx.mds, F.MXUSD, function (eb, uc) {
        if (ea || eb) return finish(ctx, c, want, ids, ['wallet read failed: ' + (ea || eb).message], [], widen, cb);
        var inWallet = {}, byKey = {}, ops = [];
        mc.concat(uc).forEach(function (x) { inWallet[String(x.coinid).toLowerCase()] = true; });
        M.load(ctx.mds, function (e0, list) {
            want.forEach(function (r) {
                byKey[r.key] = r;
                var o = M.find(list || [], ids[r.key] || ''), price = F.plain(r.price), amount = F.plain(r.amount);
                if (!o || o.status !== 'live' || o.side !== r.side) {
                    if (o && o.status === 'live') M.cancel(ctx.mds, ctx.relay, ctx.me, o.orderId, function () { });
                    ops.push({ key: r.key, orderId: null, side: r.side, price: price, amount: amount });
                    return;
                }
                // a backing coin that left the wallet (spent by a split or a fill) → re-back now, not at the next refresh
                // an order the engine republished with NO coins (nothing fresh to back it) is gone too, or it never re-backs
                var gone = !(o.coins || []).length || o.coins.some(function (id) { return !inWallet[String(id).toLowerCase()]; });
                if (gone || needsEdit(r, o.price, o.remaining, c.peg && !saved, c.reprice)) ops.push({ key: r.key, orderId: o.orderId, side: r.side, price: price, amount: amount });
            });
            M.batch(ctx.mds, ctx.relay, ctx.me, ops, mc, uc, function (errs, made) {
                var errors = [], unbacked = [];
                ops.forEach(function (op) {
                    if (made[op.key] && !op.orderId) ids[op.key] = made[op.key].orderId;
                    var err = errs[op.key];
                    if (err) { errors.push(op.key + ': ' + err); if (/^not enough/.test(err)) unbacked.push(byKey[op.key]); }
                });
                finish(ctx, c, want, ids, errors, unbacked, widen, cb);
            });
        });
        }); });
    }

    function finish(ctx, c, want, ids, errors, unbacked, widen, cb) {
        var keep = {}, k, drop = [], i;
        for (i = 0; i < want.length; i++) keep[want[i].key] = true;
        for (k in ids) if (!keep[k]) drop.push(k);
        M.load(ctx.mds, function (e0, list) {
            (function cancelNext() {
                if (drop.length) {
                    var key = drop.shift(), o = M.find(list, ids[key]); delete ids[key];
                    if (o && o.status === 'live') return M.cancel(ctx.mds, ctx.relay, ctx.me, o.orderId, function () { cancelNext(); });
                    return cancelNext();
                }
                M.load(ctx.mds, function (e1, l2) {
                    var asks = 0, bids = 0, s, o;
                    for (i = 0; i < want.length; i++) { o = M.find(l2 || [], ids[want[i].key] || ''); if (o && o.status === 'live') { if (want[i].side === 'sell') asks++; else bids++; } }
                    s = (asks + bids ? 'LIVE · ' + asks + ' ask' + (asks === 1 ? '' : 's') + ' · ' + bids + ' bid' + (bids === 1 ? '' : 's') : 'NOT LIVE')
                        + (c.peg ? (widen > 1.0001 ? ' · MEXC feed STALE, spread ×' + widen.toFixed(1) : ' · tracking MEXC') : '');
                    for (i = 0; i < errors.length; i++) s += '\n' + errors[i];
                    splitIfShort(ctx, want, ids, unbacked, function (extra) {
                        ctx.mds.kvSet('mm_ids', JSON.stringify(ids), function () { setStatus(ctx, s + extra, cb); });
                    });
                });
            })();
        });
    }

    /** A side with an unbackable rung is re-cut into one coin per rung of that side (the ladder's own rung coins
     *  included — manual orders' coins never), at most every 3 minutes per token. */
    function splitIfShort(ctx, want, ids, unbacked, cb) {
        var own = {}, k;
        for (k in ids) own[ids[k]] = true;
        var short = { sell: false, buy: false };
        unbacked.forEach(function (r) { short[r.side] = true; });
        splitSide(ctx, short.sell ? want.filter(function (r) { return r.side === 'sell'; }) : [], true, own, function (a) {
            splitSide(ctx, short.buy ? want.filter(function (r) { return r.side === 'buy'; }) : [], false, own, function (b) { cb(a + b); });
        });
    }
    function splitSide(ctx, rungs, asks, own, cb) {
        if (!rungs.length) return cb('');
        var tok = asks ? F.MINIMA : F.MXUSD, name = asks ? 'MINIMA' : 'MxUSD', now = Date.now(), per = D(0), i, give;
        if (state.lastSplit[tok] && now - state.lastSplit[tok] < SPLIT_GAP_MS) return cb('\nsplitting ' + name + ' coins for the ladder — rungs go live after the split confirms');
        for (i = 0; i < rungs.length; i++) { give = asks ? rungs[i].amount : F.up8(rungs[i].amount.times(rungs[i].price)); if (give.gt(per)) per = give; }
        state.lastSplit[tok] = now;
        split(ctx.mds, tok, rungs.length, per, own, function (err) {
            if (err) { delete state.lastSplit[tok]; return cb('\ncannot split ' + name + ' for the ladder: ' + err.message); }
            ctx.log('ladder split ' + name + ' ' + rungs.length + ' × ' + F.plain(per));
            cb('\nsplit ' + name + ' into ' + rungs.length + ' × ' + F.plain(per) + ' — rungs go live after one block');
        });
    }

    /** ONE self-send: coins of tokenid → `parts` coins of `per` (+ change). Coins backing live orders are never
     *  touched, except those of the orders in `own` (the ladder's rungs, re-backed next pass); every error path runs
     *  txndelete. cb(err, txpowid). */
    function split(mds, tokenid, parts, per, own, cb) {
        M.load(mds, function (e0, list) {
            M.walletCoins(mds, tokenid, function (e1, coins) {
                if (e1) return cb(e1);
                var ex = {}, i, free = [], need = per.times(parts), pick, have = D(0);
                for (i = 0; i < (list || []).length; i++) if (list[i].status === 'live' && !(own && own[list[i].orderId])) (list[i].coins || []).forEach(function (id) { ex[String(id).toLowerCase()] = true; });
                for (i = 0; i < coins.length; i++) if (!ex[String(coins[i].coinid).toLowerCase()]) { free.push(coins[i]); have = have.plus(F.coinValue(coins[i])); }
                pick = F.pick(free, need, 32);
                if (!pick) return cb(new Error('only ' + F.plain(have) + ' free (not backing an order), the ladder needs ' + F.plain(need)));
                mds.cmdR('getaddress', function (e2, a) {
                    if (e2 || !a || !a.address) return cb(e2 || new Error('getaddress failed'));
                    var tk = String(tokenid).toLowerCase() === F.MINIMA ? '' : ' tokenid:' + tokenid, id = 'sp' + Date.now().toString(36), steps = ['txncreate id:' + id], k = 0, change = pick.sum.minus(need);
                    for (i = 0; i < pick.coins.length; i++) steps.push('txninput id:' + id + ' coinid:' + pick.coins[i].coinid + ' scriptmmr:true');
                    for (i = 0; i < parts; i++) steps.push('txnoutput id:' + id + ' amount:' + F.plain(per) + ' address:' + a.address + tk);
                    if (change.gt(0)) steps.push('txnoutput id:' + id + ' amount:' + F.plain(change) + ' address:' + a.address + tk);
                    steps.push('txnsign id:' + id + ' publickey:auto');
                    (function step() {
                        if (k >= steps.length) return mds.cmdR('txnpost id:' + id, function (e, post) {
                            var txp = post && post.txpow && post.txpow.txpowid;
                            mds.cmd('txndelete id:' + id, function () { cb(e || (txp ? null : new Error('split: no txpowid')), txp); });
                        });
                        var c = steps[k++];
                        mds.cmdR(c, function (e) { if (e) return mds.cmd('txndelete id:' + id, function () { cb(new Error(c.split(' ')[0] + ': ' + e.message)); }); step(); });
                    })();
                });
            });
        });
    }

    function cancelAll(ctx, ids, status, cb) {
        var keys = Object.keys(ids);
        M.load(ctx.mds, function (e0, list) {
            (function next() {
                if (!keys.length) return ctx.mds.kvSet('mm_ids', JSON.stringify(ids), function () { setStatus(ctx, status, cb); });
                var k = keys.shift(), o = M.find(list || [], ids[k]); delete ids[k];
                if (o && o.status === 'live') return M.cancel(ctx.mds, ctx.relay, ctx.me, o.orderId, function (err) { if (err) ctx.log('ladder cancel ' + k + ' failed: ' + err.message); next(); });
                next();
            })();
        });
    }
    function setStatus(ctx, s, cb) {
        ctx.mds.kvGet('mm_status', '', function (old) {
            if (old === s) return cb();
            ctx.log('ladder: ' + s.replace(/\n/g, ' '));
            ctx.mds.kvSet('mm_status', s, function () { if (ctx.changed) ctx.changed(); cb(); });
        });
    }

    /** The ladder's guarded MEXC mid, or 0 while a jump is unconfirmed (auto-cross prices from this, never the raw feed). */
    function guardedMid() { return state.feed.suspect > 0 ? 0 : (state.feed.mid || 0); }
    AX.ladder = { guardedMid: guardedMid, MAX_LEVELS: MAX_LEVELS, parse: parse, blankConfig: blankConfig, fromJson: fromJson, levelCount: levelCount, generate: generate, desired: desired,
                  needsEdit: needsEdit, commits: commits, validate: validate, wideningFactor: wideningFactor, guard: guard, feedLine: feedLine, feed: feed, parseGeckoMexc: parseGeckoMexc, GECKO_MEXC_URL: GECKO_MEXC_URL, pass: pass, split: split,
                  _state: state };
})(typeof globalThis !== 'undefined' ? globalThis : this);
