/**
 * ui/app.js — Dexicon page: the FAST layer (signed relay orders, node-co-signed fills) and the relay panel, riding
 * on the vendored PandaDEX page (ui/pd_app.js = RESTING layer: V5 covenant book + PandaPools, chart, tape, assets,
 * on-chain maker). PandaDEX's script exposes window.PD; this file exposes window.DexiconFast, which pd_app.js calls
 * from its ladder, order form, orders list and render(). ui/doors.js exposes window.DexiconDoors (the AtomiX doors).
 * One MDS.init lives here.
 */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var M = AX.maker, F = AX.fill, E = AX.envelope;
    var me = null, meErr = "", client = null, relays = [], discovered = [], polling = false, inboxPolling = false;
    var myOrders = [], fastFills = [], pendingTakes = {}, fastMode = true, version = 'dev';
    var D = function (v) { return PandaDEX.d(v); };

    try { fastMode = localStorage.getItem('dexicon_layer') !== 'chain'; } catch (e) { }

    function notice(s, kind) { PD.notice(s, kind); if (kind === 'error') PD.appendActivity(s, Date.now()); }
    function esc(s) { return PD.esc(s); }
    function nowS() { return Math.floor(Date.now() / 1000); }
    function mySignPk() { return me ? ('0x' + AX.hex.to(me.signPk)).toLowerCase() : ''; }

    // ---------- layer mode ----------
    function setMode(fast) {
        fastMode = !!fast;
        try { localStorage.setItem('dexicon_layer', fastMode ? 'fast' : 'chain'); } catch (e) { }
        $('layerFast').className = fastMode ? 'selected-fast' : '';
        $('layerChain').className = fastMode ? '' : 'selected-chain';
        $('layerBadge').textContent = fastMode ? 'FAST' : 'V5';
        $('layerHint').textContent = fastMode
            ? 'FAST: instant to place, edit and cancel; your coins stay in your wallet and your node co-signs each fill.'
            : 'ON-CHAIN: your funds move into the V5 covenant until filled or cancelled; survives your node going offline.';
        $('gtc').style.display = fastMode ? 'none' : '';
        $('advanced').style.display = fastMode ? 'none' : '';
        fastPreview();
    }

    // ---------- the fast book ----------
    function liveOrders() { return client ? client.orders() : []; }
    /** Levels for the ladder: [{price, minima, exact, mine}] on one side, quantised to the grouping tick like PandaDEX. */
    function levels(sell, tick) {
        var out = {}, keys = [], orders = liveOrders(), i, o, price, amount, level, key, t = tick ? D(tick) : null;
        for (i = 0; i < orders.length; i++) {
            o = orders[i];
            if ((o.side === 'sell') !== !!sell) continue;
            price = PD.num(o.price); amount = PD.num(o.amount);
            if (!price || !amount || !amount.gt(0) || !(o.coins || []).length) continue;   // unbacked: nobody can take it, so not on the book
            level = t ? (sell ? price.div(t).ceil() : price.div(t).floor()).mul(t) : price;   // EXACT: the signed price, unrounded
            key = level.toFixed();
            if (!out[key]) { out[key] = { price: level, minima: D(0), exact: price, mine: false }; keys.push(key); }
            out[key].minima = out[key].minima.add(amount);
            if (sell ? price.lt(out[key].exact) : price.gt(out[key].exact)) out[key].exact = price;
            if (o.signPk.toLowerCase() === mySignPk()) out[key].mine = true;
        }
        return keys.map(function (k) { return out[k]; });
    }
    /** Best fast orders on the OPPOSITE side that a limit at `price` crosses, best price first (never my own). */
    function crossing(isBuy, price) {
        var p = PD.num(price), out = [], orders = liveOrders(), i, o, op;
        if (!p) return out;
        for (i = 0; i < orders.length; i++) {
            o = orders[i]; op = PD.num(o.price);
            if (!op || o.signPk.toLowerCase() === mySignPk() || !(o.coins || []).length) continue;
            if (isBuy && o.side === 'sell' && op.lte(p)) out.push(o);
            if (!isBuy && o.side === 'buy' && op.gte(p)) out.push(o);
        }
        // best price first, always; among equal prices the maker that co-signed my takes fastest first (mirror of APK 0.2.81)
        var sp = speeds();
        out.sort(function (a, b) { var c = isBuy ? D(a.price).cmp(D(b.price)) : D(b.price).cmp(D(a.price)); return c || speedOf(sp, a.signPk) - speedOf(sp, b.signPk); });
        return out;
    }
    /** Owner 7 Nov (APK MakerSpeed): per-maker running average of how long my takes waited for a co-sign. */
    var SPEED_UNKNOWN_MS = 5000;
    function speeds() { try { return JSON.parse(localStorage.getItem('dexicon_maker_speed') || '{}') || {}; } catch (e) { return {}; } }
    function speedOf(sp, pk) { var v = sp[String(pk || '').toLowerCase()]; return typeof v === 'number' ? v : SPEED_UNKNOWN_MS; }
    function recordSpeed(pk, ms) {
        var sp = speeds(), k = String(pk || '').toLowerCase(), keys;
        if (!k) return;
        sp[k] = typeof sp[k] === 'number' ? Math.round((sp[k] + ms) / 2) : ms;
        keys = Object.keys(sp); if (keys.length > 200) delete sp[keys[0]];
        try { localStorage.setItem('dexicon_maker_speed', JSON.stringify(sp)); } catch (e) { }
    }
    function fastPreview() {
        paintFunds();
        var box = $('fastPreview'), isBuy = PD.isBuy(), price = $('price').value, amount = PD.num($('amount').value), hits, lines = [], left, take, now;
        if (!box) return;
        if (run) return;
        if (!fastMode || !amount || !amount.gt(0)) { box.textContent = ''; box.className = 'fast-preview'; return; }
        hits = crossing(isBuy, price);
        if (cta()) cta().innerHTML = (isBuy ? 'PLACE BUY ORDER' : 'PLACE SELL ORDER') + ' <span>→</span>';
        // the sweep (owner 7 Nov, mirror of APK 0.2.76): one click takes every crossing FAST order best-first up to the amount
        if (hits.length && cta()) cta().innerHTML = (isBuy ? 'BUY ' : 'SELL ') + PD.fmt(Decimal.min(amount, offered(isBuy, price))) + ' MINIMA NOW <span>→</span>';
        if (!hits.length) { box.textContent = 'Rests as a FAST ' + (isBuy ? 'bid' : 'ask') + ' on ' + relays.length + ' relay' + (relays.length === 1 ? '' : 's') + ' — instant, cancel any time.'; box.className = 'fast-preview'; return; }
        var cost = D(0), n = 0; left = amount;
        hits.forEach(function (h) { if (!left.gt(0)) return; take = Decimal.min(left, D(h.amount)); cost = cost.add(take.mul(D(h.price))); left = left.sub(take); n++; });
        now = amount.sub(left);
        lines.push('One click trades: takes ' + now.toFixed() + ' MINIMA from ' + n + ' FAST ' + (isBuy ? 'ask' : 'bid') + (n === 1 ? '' : 's') + ' best-first, up to ' + price + '. No second step. Final in one block.');
        if (left.gt(0)) lines.push('The other ' + left.toFixed() + ' MINIMA is not traded (nothing more crosses ' + price + ').');
        (function () {
            var m = PD.bal('minima'), u = PD.bal('usdt');
            if (!m || !u) return;
            lines.push('After this fill: ' + PD.fmtBal(isBuy ? m.sendable.add(now) : m.sendable.sub(now)) + ' MINIMA · ' + PD.fmtBal(isBuy ? u.sendable.sub(cost.toDecimalPlaces(8, Decimal.ROUND_UP)) : u.sendable.add(cost.toDecimalPlaces(8, Decimal.ROUND_DOWN))) + ' MxUSD');
        })();
        box.textContent = lines.join('\n'); box.className = 'fast-preview cross';
    }

    // ---------- your funds (mirror of the APK's Funds/OrderPreview): available, in FAST orders, free, shortfall ----------
    function inOrders() {
        var mo = D(0), uo = D(0);
        myOrders.forEach(function (o) { if (o.status !== 'live') return; if (o.side === 'sell') mo = mo.add(D(o.remaining)); else uo = uo.add(D(o.remaining).mul(D(o.price))); });
        return { minima: mo, usd: uo };
    }
    /** Free to commit to a NEW order: sendable minus what my live FAST orders already promise on that side. */
    function free(buy) {
        var b = PD.bal(buy ? 'usdt' : 'minima'), o = inOrders(), f;
        if (!b) return null;
        f = b.sendable.sub(buy ? o.usd : o.minima);
        return f.lt(0) ? D(0) : f;
    }
    /** Exact MINIMA the crossing FAST orders offer at `price` (not mine, backed). */
    function offered(isBuy, price) { return crossing(isBuy, price).reduce(function (t, o) { return t.add(D(o.amount)); }, D(0)); }
    function useMax() { var b = $('trade').querySelector('.percent-row button:last-child'); if (b) b.click(); }
    /** The Available line, and a red line + a disabled button when the order needs more than is free. */
    function paintFunds() {
        var line = $('availLine'), warn = $('fundsWarn'), isBuy = PD.isBuy(), m = PD.bal('minima'), u = PD.bal('usdt'), o = inOrders(), f = free(isBuy),
            p = PD.num($('price').value), a = PD.num($('amount').value), need, short = false, b = cta();
        if (!line) return;
        if (!fastMode) { line.textContent = 'Available: ' + (isBuy ? (u ? PD.fmtBal(u.sendable) + ' MxUSD' : '—') : (m ? PD.fmtBal(m.sendable) + ' MINIMA' : '—')) + '  ·  tap for max'; warn.textContent = ''; return; }
        line.textContent = 'Available: ' + (f ? PD.fmtBal(f) : '—') + (isBuy ? ' MxUSD' : ' MINIMA') + '  ·  tap for max'
            + '\nwallet ' + (m ? PD.fmtBal(m.sendable) : '—') + ' MINIMA · ' + (u ? PD.fmtBal(u.sendable) : '—') + ' MxUSD'
            + (o.minima.gt(0) || o.usd.gt(0) ? '  ·  in FAST orders ' + PD.fmtBal(o.minima) + ' MINIMA · ' + PD.fmtBal(o.usd) + ' MxUSD' : '');
        if (f && p && a && p.gt(0) && a.gt(0)) {
            // the sweep rests nothing: when FAST orders cross, only what they cover is committed (at most the limit price)
            var cov = offered(isBuy, p.toFixed()), q = cov.gt(0) ? Decimal.min(a, cov) : a;
            need = isBuy ? q.mul(p).toDecimalPlaces(8, Decimal.ROUND_UP) : q;
            short = need.gt(f);
            warn.textContent = short ? 'Exceeds your free ' + (isBuy ? 'MxUSD' : 'MINIMA') + ' by ' + need.sub(f).toFixed() + ' (free ' + PD.fmtBal(f) + ')' : '';
        } else warn.textContent = '';
        if (b && !run) b.disabled = short;
    }

    // ---------- placing ----------
    function place(isBuy) {
        var price = $('price').value.trim(), amount = $('amount').value.trim(), p = PD.num(price), a = PD.num(amount), hits;
        if (run) return;
        if (!me) return notice('Identity not ready — grant WRITE trust in MiniHub and reload.', 'error');
        if (!relays.length) return notice('Add a relay first (RELAYS tab).', 'error');
        if (!p || !p.gt(0) || !a || !a.gt(0)) return notice('Enter a valid price and amount.', 'error');
        hits = crossing(isBuy, price);
        if (hits.length) return executeTake(isBuy, p.toFixed(), a.toFixed());
        createFast({ side: isBuy ? 'buy' : 'sell', price: p.toFixed(), amount: a.toFixed() }, function (err) { if (!err) { $('amount').value = ''; PD.preview(); fastPreview(); } });
    }
    function createFast(spec, cb) {
        PD.setStage('Publishing fast order…'); PD.paintNotice();
        M.create(AX.mds, client, me, spec, function (err, o, results) {
            PD.setStage('');
            if (err) { notice('Order not placed: ' + err.message, 'error'); return cb && cb(err); }
            var ok = results.filter(function (r) { return r.ok; }).length;
            notice('Fast ' + spec.side + ' ' + spec.amount + ' MINIMA @ ' + spec.price + ' live on ' + ok + '/' + results.length + ' relay' + (results.length === 1 ? '' : 's') + ' — order ' + o.orderId, 'posted');
            PD.appendActivity('Fast order ' + o.orderId + ' published (' + spec.side + ' ' + spec.amount + ' @ ' + spec.price + ')', Date.now());
            loadMyOrders(); if (cb) cb(null, o);
        });
    }

    // ---------- my fast orders ----------
    function loadMyOrders(cb) { M.load(AX.mds, function (err, list) { myOrders = list || []; renderMine(); paintFunds(); PD.renderOrdersPage(); PD.renderBookOnly(); if (cb) cb(); }); }
    function mineHtml() {
        var live = myOrders.filter(function (o) { return o.status === 'live'; }), out = [], i, o, total, coins;
        for (i = 0; i < live.length; i++) {
            o = live[i]; total = D(o.remaining).mul(D(o.price)); coins = (o.coins || []).length;
            out.push('<article class="order-card fast-order ' + (o.side === 'sell' ? 'sell-order' : 'buy-order') + (coins ? '' : ' is-pending') + '"><div class="order-top"><div><span class="side">' + (o.side === 'sell' ? 'SELL' : 'BUY')
                + '</span><strong>' + (DexiconMaker.rung(o.orderId) ? 'MAKER ' + DexiconMaker.rung(o.orderId) + ' · ' : '') + PD.fmt(o.remaining) + ' MINIMA <b>@</b> ' + PD.fmtPrice(o.price) + '</strong></div><div class="order-buttons"><button onclick="DexiconFast.editOrder(\'' + PD.jsArg(o.orderId) + '\',\'' + PD.jsArg(PD.fmtPrice(o.price)) + '\')">EDIT</button><button onclick="DexiconFast.cancelOrder(\'' + PD.jsArg(o.orderId) + '\')">CANCEL</button></div></div>'
                + '<div class="order-meta"><span>' + (o.remaining === o.amount ? '' : 'filled ' + PD.fmt(D(o.amount).sub(D(o.remaining))) + ' of ' + PD.fmt(o.amount) + ' · ') + 'total ' + PD.fmt(total) + ' MxUSD · backed by ' + coins + ' coin' + (coins === 1 ? '' : 's') + ' · seq ' + o.seq + '</span><span>' + (coins ? 'LIVE' : 'RE-BACKING') + '</span></div>'
                + (coins ? '' : '<p>⏳ Not fillable until your node re-backs it (backing coins moved or aged out; the service re-locks them).</p>')
                + '<div class="trade-evidence">order ' + esc(o.orderId) + ' · pays to ' + esc(o.address) + '</div></article>');
        }
        return out.join('');
    }
    function renderMine() { var box = $('fastMine'); if (box) box.innerHTML = pendingRows() + mineHtml(); }
    function cancelOrder(orderId) {
        if (!confirm('Cancel this fast order? It disappears from every relay immediately.')) return;
        M.cancel(AX.mds, client, me, orderId, function (err) { notice(err ? 'Cancel failed: ' + err.message : 'Fast order ' + orderId + ' cancelled', err ? 'error' : 'posted'); loadMyOrders(); });
    }
    function editOrder(orderId, price) {
        var next = prompt('New price (MxUSD per MINIMA)', price || ''), d, o;
        if (next === null) return;
        d = PD.num(next); if (!d || !d.gt(0)) return notice('Enter a valid new price.', 'error');
        o = M.find(myOrders, orderId); if (!o) return;
        M.edit(AX.mds, client, me, orderId, { price: d.toFixed(), amount: o.remaining }, function (err) { notice(err ? 'Edit failed: ' + err.message : 'Fast order ' + orderId + ' repriced to ' + d.toFixed(), err ? 'error' : 'posted'); loadMyOrders(); });
    }

    // ---------- taking: ONE click, the MinimaXT way ----------
    // MinimaXT's book carries every maker's coins, so pressing BUY/SELL IS the trade: nothing is looked up after the
    // click, every valid order is tried in turn without asking again, and a log under the button prints each step.
    // Here the order carries coin ids only, so the coins are fetched AHEAD (book change, new block, balance change) and
    // the click uses what is already in memory.
    var prep = { maker: {}, wallet: {}, addr: null, warming: false };
    function warmWallet() {
        [F.MINIMA, F.MXUSD].forEach(function (tok) { M.walletCoins(AX.mds, tok, function (e, coins) { if (!e) prep.wallet[tok] = coins; }); });
        AX.mds.cmdR('getaddress', function (e, r) { if (!e && r && r.address) prep.addr = r.address; });
    }
    /** Fetch (in the background) the backing coins of the best few orders on each side; a spent one is dropped. */
    function warmMakers() {
        if (prep.warming) return;
        var ids = [], seen = {};
        [true, false].forEach(function (buy) { crossing(buy, buy ? '999999999' : '0.00000001').slice(0, 6).forEach(function (o) { (o.coins || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } }); }); });
        prep.warming = true;
        (function step(i) {
            if (i >= ids.length) { prep.warming = false; return; }
            AX.mds.cmdR('coins coinid:' + ids[i], function (err, rows) {
                var c = Array.isArray(rows) ? rows[0] : rows;
                if (!err) { if (c && c.coinid && c.spent !== true) prep.maker[ids[i]] = c; else delete prep.maker[ids[i]]; }
                step(i + 1);
            });
        })(0);
    }
    function makerCoins(o, cb) {
        var have = [], miss = [];
        o.coins.forEach(function (id) { if (prep.maker[id]) have.push(prep.maker[id]); else miss.push(id); });
        if (!miss.length) return cb(null, have, true);
        fetchCoins(miss, function (err, got) { if (err) return cb(err); got.forEach(function (c) { prep.maker[c.coinid] = c; }); cb(null, have.concat(got), false); });
    }
    function fetchCoins(ids, cb) {
        var out = [], i = 0;
        (function step() {
            if (i >= ids.length) return cb(null, out);
            var id = ids[i++];
            AX.mds.cmdR('coins coinid:' + id, function (err, rows) {
                if (err) return cb(err);
                var c = Array.isArray(rows) ? rows[0] : rows;
                if (!c || !c.coinid) return cb(new Error('coin ' + id + ' not visible to this node (spent, or outside its chain window)'));
                if (c.spent === true) return cb(new Error('coin ' + id + ' is already spent'));
                out.push(c); step();
            });
        })();
    }

    // the trade log under the order button, and the locked button
    // the take in progress: {t0, isBuy, price, amount, left, got, unanswered, taking, tried[], act, timer}. Owner 7 Nov, the
    // sweep (mirror of APK 0.2.76): `left` drops by each take SENT, answered or not — an unanswered take may still be
    // co-signed inside its 5-minute void window, so it counts as possibly filled and a run never buys more than asked.
    var run = null, SWEEP_MAX_ORDERS = 12, SWEEP_WAIT_MS = 30000;
    function log(msg) {
        var box = $('tradeLog'), t = run ? ((Date.now() - run.t0) / 1000).toFixed(1) + 's' : '', line = document.createElement('div');
        if (!box) return;
        box.hidden = false;
        line.textContent = (t ? '+' + t + '  ' : '') + msg;
        box.appendChild(line); box.scrollTop = box.scrollHeight;
    }
    function cta() { return $('trade').querySelector('.order-form .cta') || $('trade').querySelector('.cta'); }
    function lock() {
        var b = cta(); if (!b) return;
        b.disabled = true; b.classList.add('busy');
        run.timer = setInterval(function () { if (run) b.innerHTML = 'TRADING… ' + Math.floor((Date.now() - run.t0) / 1000) + 's'; }, 250);
    }
    function unlock() {
        var b = cta();
        if (run && run.timer) clearInterval(run.timer);
        run = null;
        if (b) { b.disabled = false; b.classList.remove('busy'); }
        PD.preview(); fastPreview();
    }
    /** The one click. Walk every crossing order best-first (MinimaXT's loop), build + sign against the first that
     *  plans, send it, and wait for the maker's co-sign; a refusal moves on to the next order by itself. */
    function executeTake(isBuy, price, amount) {
        var box = $('tradeLog');
        if (run) return;
        if (!voids) return loadVoids(function () { if (voids) executeTake(isBuy, price, amount); });   // void records first (coins + orders to skip)
        if (box) box.innerHTML = '';
        run = { t0: Date.now(), isBuy: isBuy, price: price, amount: amount, left: D(amount), got: D(0), unanswered: D(0), taking: D(0), tried: [] };
        lock();
        log((isBuy ? 'BUY ' : 'SELL ') + amount + ' MINIMA @ ' + price + ' (limit)');
        nextOrder();
    }
    function nextOrder() {
        var r = run; if (!r) return;
        if (!r.left.gt(0)) return finishSweep();
        if (r.tried.length >= SWEEP_MAX_ORDERS) { log('Stopped after ' + SWEEP_MAX_ORDERS + ' orders (the per-click limit).'); return finishSweep(); }
        var hits = crossing(r.isBuy, r.price).filter(function (o) { return r.tried.indexOf(o.orderId) < 0; });
        if (!hits.length) {
            if (!r.tried.length) { log('Nothing crosses any more — placing it as a FAST order instead.'); createFast({ side: r.isBuy ? 'buy' : 'sell', price: r.price, amount: r.amount }); return unlock(); }
            log('No other FAST order crosses ' + r.price + '.');
            return finishSweep();
        }
        if (!r.tried.length) log('Found ' + hits.length + ' FAST order' + (hits.length === 1 ? '' : 's') + ' at or better than your price');
        tryOrder(hits[0]);
    }
    function tryOrder(o) {
        var r = run, a = r.left, now = Decimal.min(a, D(o.amount)), myTok = o.side === 'sell' ? F.MXUSD : F.MINIMA;
        // PandaDEX's min-remainder floor: a partial take never leaves under 1 MINIMA on the maker's order — it is shrunk
        // to leave exactly 1 (the sweep moves on for the rest); an order it can't touch is skipped
        now = AX.fill.floorTake(now, o.amount);
        if (!now.gt(0)) { r.tried.push(o.orderId); log('Order ' + o.orderId + ': a partial take would leave under ' + AX.fill.MIN_REM + ' MINIMA — next order'); return nextOrder(); }
        if (now.lt(Decimal.min(a, D(o.amount)))) log('  taking ' + now.toFixed() + ' so ' + AX.fill.MIN_REM + ' MINIMA stays on the maker\'s order (minimum remainder)');
        r.tried.push(o.orderId);
        // security review 7 Nov (mirror of APK 0.2.42): pending takes are keyed by order id — a second take would overwrite
        // the first record and that signed half would never be voided
        if (pendingTakes[o.orderId]) { log('Order ' + o.orderId + ': your earlier take of it is still settling — next order'); return nextOrder(); }
        // review 7 Nov (L): voids are keyed by order id — a new take of an order whose earlier take is still being voided
        // would overwrite that void record
        if (voids && voids[o.orderId]) { log('Order ' + o.orderId + ': your earlier take of it is still being voided — next order'); return nextOrder(); }
        log('Order ' + o.orderId + ' @ ' + o.price + ' · ' + o.amount + ' MINIMA · maker ' + o.address);
        makerCoins(o, function (err, mc, cached) {
            if (err) { log('  maker coins: ' + err.message + ' — next order'); return nextOrder(); }
            log('  maker coins ' + (cached ? 'ready' : 'fetched') + ' (' + mc.length + ')');
            var go = function (myCoins, addr) {
                var p;
                try { p = F.plan(o, now.toFixed(), mc, myCoins, addr); } catch (e) { log('  ' + e.message + ' — next order'); return nextOrder(); }
                log('  you give ' + p.takerGives + (o.side === 'sell' ? ' MxUSD' : ' MINIMA') + ', you get ' + p.makerGives + (o.side === 'sell' ? ' MINIMA' : ' MxUSD'));
                sendTake(o, p, null);   // the sweep never rests a remainder
            };
            if (prep.wallet[myTok] && prep.addr) return go(notPending(prep.wallet[myTok]), prep.addr);
            M.walletCoins(AX.mds, myTok, function (e2, coins) {
                if (e2) { log('  cannot read your coins: ' + e2.message); return finishSweep(); }
                prep.wallet[myTok] = coins;
                AX.mds.cmdR('getaddress', function (e3, ad) { if (e3 || !ad) { log('  getaddress failed'); return finishSweep(); } prep.addr = ad.address; go(notPending(coins), ad.address); });
            });
        });
    }
    /** My coins inside takes still waiting on a maker are not in the mempool until the maker posts, so the node still
     *  lists them — the next order of a sweep must not sign them again. */
    function notPending(coins) {
        var held = {};
        Object.keys(pendingTakes).forEach(function (k) { (pendingTakes[k].mine || []).forEach(function (id) { held[String(id).toLowerCase()] = 1; }); });
        // review 7 Nov (L2): a refused take's coins are being voided (relocked) — never sign them into the next take either
        Object.keys(voids || {}).forEach(function (k) { (voids[k].mine || []).forEach(function (id) { held[String(id).toLowerCase()] = 1; }); });
        return coins.filter(function (c) { return !held[String(c.coinid).toLowerCase()]; });
    }
    /** The sweep's last lines: what was co-signed, what may still be, and that nothing rests. */
    function finishSweep() {
        var r = run; if (!r) return;
        var open = D(r.amount).sub(r.got).sub(r.unanswered);
        if (r.got.gt(0)) log('TRADE DONE: ' + r.got.toFixed() + ' of ' + r.amount + ' MINIMA co-signed — settling, final after one block.');
        if (r.unanswered.gt(0)) log(r.unanswered.toFixed() + ' MINIMA still waiting on makers (filled if they co-sign within 5 minutes, else voided).');
        if (open.gt(0) && (r.got.gt(0) || r.unanswered.gt(0))) log(open.toFixed() + ' MINIMA not traded; nothing was placed as an order.');
        else if (!r.got.gt(0) && !r.unanswered.gt(0)) log('Nothing was traded and no order was placed.');
        // review 7 Nov (M4): the field keeps only what is surely untraded, so a second click never re-buys a take that may still fill
        if (r.got.gt(0) || r.unanswered.gt(0)) $('amount').value = open.gt(0) ? open.toFixed() : '';
        unlock();
    }
    function sendTake(o, p, rest) {
        var r = run, takerBuys = o.side === 'sell', actId = 'fast_' + Date.now(), ts = Date.now();
        r.act = actId;
        DexiconActivity.record({ id: actId, route: 'FAST', role: 'taker', side: takerBuys ? 'buy' : 'sell', amount: p.filled, price: o.price,
            mxusd: takerBuys ? p.takerGives : p.makerGives, orderId: o.orderId, counterparty: o.address, ins: p.inputs.slice(), stage: AX.activity.BUILDING, reason: 'Building and signing your side…' });
        log('  signing your side…');
        F.build(AX.mds, p, function (err, hex) {
            if (err) { DexiconActivity.update(actId, function (a) { a.stage = AX.activity.FAILED; a.reason = 'build failed: ' + err.message; }); log('  build failed: ' + err.message); return finishSweep(); }
            log('  signed in ' + ((Date.now() - ts) / 1000).toFixed(1) + 's');
            r.taking = D(p.filled); r.left = r.left.sub(r.taking);   // counted from here: it can be co-signed
            delete prep.wallet[takerBuys ? F.MXUSD : F.MINIMA]; warmWallet();   // those coins are now in flight
            var inner = JSON.stringify({ k: 'take', orderId: o.orderId, txn: hex, taker: me.publicId() });
            var msg = E.msg(me, o.pubId, AX.identity.seal(me, o.pubId, AX.hex.utf8(inner)), nowS() + 300);
            var theirs = (o.coins || []).map(function (x) { return String(x).toLowerCase(); });
            pendingTakes[o.orderId] = { order: o, plan: p, rest: rest, sent: Date.now(), act: actId, outs: [],
                mine: p.inputs.filter(function (x) { return theirs.indexOf(String(x).toLowerCase()) < 0; }) };   // my coins in it: one voids it
            savePending();
            // my own record of the outputs (signing adds witness only, so the coin ids are final): never the maker's word
            AX.mds.cmdR('txnview data:' + hex, function (ev, view) {
                var t = view && view.transaction, pt0 = pendingTakes[o.orderId];
                if (ev || !t || !t.outputs || !pt0) return;
                pt0.outs = t.outputs.map(function (x) { return x && x.coinid; }).filter(function (id) { return /^0x[0-9A-Fa-f]{64}$/.test(String(id)); });
                savePending();
            });
            client.publish(msg, function (results) {
                var ok = results.filter(function (x) { return x.ok; }).length;
                // review 7 Nov (L1): the slowest relay can return after a fast maker answered and the sweep moved on — a late
                // callback never touches the NEXT take or a later run
                var current = run === r && r.act === actId;
                // security review 7 Nov: a relay that says "failed" may still have passed my signed half on — the take stays
                // pending so sweepTakes voids it after VOID_AFTER_MS
                if (!ok) {
                    DexiconActivity.update(actId, function (a) { if (a.stage === AX.activity.BUILDING || a.stage === AX.activity.SENT) { a.stage = AX.activity.FAILED; a.reason = 'no relay accepted the take: ' + (results[0] && results[0].error); } });
                    if (!current) return;
                    log('  no relay accepted the take: ' + (results[0] && results[0].error)); r.unanswered = r.unanswered.add(r.taking); return finishSweep();
                }
                DexiconActivity.update(actId, function (a) { a.relays = ok; a.sentMs = pendingTakes[o.orderId] ? pendingTakes[o.orderId].sent : Date.now(); if (a.stage === AX.activity.BUILDING) { a.stage = AX.activity.SENT; a.reason = ''; } });
                if (!current) return;
                log('  sent to ' + ok + '/' + results.length + ' relays · waiting for the maker’s node to co-sign…');
                renderMine(); PD.renderOrdersPage();
                if (run === r) r.wait = setTimeout(function () {
                    if (run === r && r.act === actId && pendingTakes[o.orderId] && !pendingTakes[o.orderId].taken) {
                        r.unanswered = r.unanswered.add(r.taking); r.act = null;
                        recordSpeed(o.signPk, SWEEP_WAIT_MS);
                        log('  no answer in ' + SWEEP_WAIT_MS / 1000 + 's — counted as possibly filled (if it is not co-signed within 5 minutes it is voided); next order');
                        nextOrder();
                    }
                }, SWEEP_WAIT_MS);
            });
        });
    }
    /** Follow the take after the co-sign into the same log: in block N, confirmations, done. */
    var lastAct = null;
    setInterval(function () {
        if (!lastAct) return;
        var st = DexiconActivity.statusOf(lastAct.id);
        if (!st || st === lastAct.status) return;
        lastAct.status = st; logLine(st);
        if (/^(Done|Failed|Lost|Dropped|Refused)/.test(st)) lastAct = null;
    }, 2000);
    function logLine(s) { var box = $('tradeLog'), line; if (!box) return; line = document.createElement('div'); line.textContent = new Date().toLocaleTimeString() + '  ' + s; box.appendChild(line); box.scrollTop = box.scrollHeight; }
    /** Security review 30 Oct (mirror of the APK 0.1.51): a signed take has no expiry — a maker could hold it and post it
     *  hours later, only if the price moved its way. A take unanswered for 5 minutes, or refused, is voided: one of MY coins
     *  in it is spent back to me (AX.maker.relock). Durable in kv 'void_takes' so a reload still finishes it. */
    var VOID_AFTER_MS = 5 * 60000, voids = null, voiding = {};
    function toVoid(orderId, pt) {
        loadVoids(function () { voids[orderId] = { mine: pt.mine || [], act: pt.act || '' }; saveVoids(); runVoids(); });
    }
    function loadVoids(cb) { if (voids) return cb(); AX.mds.kvGet('void_takes', '{}', function (v) { try { voids = JSON.parse(v || '{}') || {}; } catch (e) { voids = {}; } cb(); }); }
    function saveVoids() { AX.mds.kvSet('void_takes', JSON.stringify(voids || {}), function () { }); }
    function sweepTakes() {
        var now = Date.now(), moved = false;
        AX.mds.kvSet('ui_alive', String(now), function () { });   // review 7 Nov (M-1): the service voids only while the page is closed
        Object.keys(pendingTakes).forEach(function (k) { if (now - pendingTakes[k].sent > VOID_AFTER_MS) { toVoid(k, pendingTakes[k]); delete pendingTakes[k]; moved = true; } });
        if (moved) { savePending(); renderMine(); }
        loadVoids(runVoids);
    }
    function runVoids() {
        Object.keys(voids || {}).forEach(function (k) {
            var v = voids[k], coin = String((v.mine || [])[0] || '');
            if (voiding[k]) return;
            function done(note) { delete voids[k]; delete voiding[k]; saveVoids(); if (v.act) DexiconActivity.update(v.act, function (a) { if (a.stage !== AX.activity.COSIGNED) a.reason = note; }); }
            if (!/^0x[0-9A-Fa-f]{64}$/.test(coin)) return done('');   // a take from before 0.0.46: nothing recorded to spend
            voiding[k] = true;
            // review 7 Nov (R3-4, mirror of APK 0.2.51): only an ON-CHAIN spend settles the take; a mempool-only spend may
            // never mine (the maker would keep its option) — wait and look again; relock only a coin unspent everywhere
            AX.mds.cmdR('coins relevant:true coinid:' + coin, function (e0, onChain) {
                if (e0) { delete voiding[k]; return; }
                if (!(Object.prototype.toString.call(onChain) === '[object Array]' && onChain.length)) return done(v.relocked ? 'Take voided: your coin ' + coin + ' was spent back to you, so the maker can no longer post your signed half.' : 'Your coin in this take is already spent — the maker may have posted it; check TRADES.');
            AX.mds.cmdR('coins relevant:true checkmempool:true coinid:' + coin, function (e, rows) {
                var c = !e && Object.prototype.toString.call(rows) === '[object Array]' ? rows[0] : null;
                if (e || !c) { delete voiding[k]; return; }   // spent in the mempool only: wait for it to mine or drop
                AX.mds.cmdR('getaddress', function (e2, ad) {
                    if (e2 || !ad || !ad.address) { delete voiding[k]; return; }
                    AX.maker.relock(AX.mds, [c], ad.address, function (e3) {
                        delete voiding[k];   // e3: retried on the next sweep
                        if (!e3) { v.relocked = true; saveVoids(); }
                        // review 7 Nov (M, mirror of service.js voidOne): keep the record until the relock is ON CHAIN — a posted
                        // relock can still be dropped; the next pass then finds the coin spent and closes it
                        if (!e3 && v.act) DexiconActivity.update(v.act, function (a) { if (a.stage !== AX.activity.COSIGNED) a.reason = 'Voiding: your coin ' + coin + ' is being spent back to you; settles when it is on chain.'; });
                    });
                });
            });
            });
        });
    }

    function savePending() { AX.mds.kvSet('pending_takes', JSON.stringify(pendingTakes), function () { }); }
    function loadPending(cb) { AX.mds.kvGet('pending_takes', '{}', function (v) { try { pendingTakes = JSON.parse(v || '{}'); } catch (e) { pendingTakes = {}; } if (cb) cb(); }); }
    function inboxLoop() {
        if (!client || !client.relays.length || !me) { inboxPolling = false; return; }
        inboxPolling = true;
        client.pollInbox(me.publicId(), 25, function (err, msgs) {
            msgs.forEach(function (m) {
                var opened = AX.identity.open(me, m.env.blob), inner, pt;
                if (!opened || !opened.valid) return;
                try { inner = JSON.parse(AX.hex.utf8Decode(opened.plaintext)); } catch (e) { return; }
                pt = inner && pendingTakes[inner.orderId];
                if (!pt || pt.taken) return;   // answered already; sweepTakes settles it
                // only the maker of this order may answer for it, and its txpowid must be a txpowid (security review 30 Oct)
                if (String(opened.fromPublicId || '').toLowerCase() !== String(pt.order.pubId || '').toLowerCase()) return;
                if (inner.k === 'taken' && !/^0x[0-9A-Fa-f]{64}$/.test(String(inner.txpowid))) return;
                inner.coins = pt.outs || [];
                if (!/^[0-9]+(\.[0-9]+)?$/.test(String(inner.filled))) inner.filled = pt.plan.filled;
                if (inner.k === 'taken') {
                    recordSpeed(pt.order.signPk, Date.now() - pt.sent);
                    if (pt.act) DexiconActivity.update(pt.act, function (a) { a.stage = AX.activity.COSIGNED; a.reason = ''; a.cosignMs = Date.now() - pt.sent; a.txpowid = inner.txpowid; a.outs = inner.coins || []; a.amount = inner.filled || a.amount; });
                    AX.mds.kvSet('fill_' + inner.txpowid, JSON.stringify({ role: 'taker', orderId: inner.orderId, side: pt.order.side === 'sell' ? 'buy' : 'sell', price: pt.order.price,
                        filled: inner.filled, gave: pt.plan.takerGives, got: pt.plan.makerGives, txpowid: inner.txpowid, coins: inner.coins || [], maker: pt.order.address, ts: nowS(), status: 'settling' }), function () { loadFills(); });
                    PD.setStage(''); notice('Filled ' + inner.filled + ' MINIMA @ ' + pt.order.price + ' — txpow ' + inner.txpowid + ' (settling)', 'posted');
                    PD.appendActivity('Maker co-signed: ' + inner.filled + ' MINIMA @ ' + pt.order.price + ' · txpow ' + inner.txpowid, Date.now());
                    // security review 7 Nov (HIGH, mirror of APK 0.2.42): "taken" is the maker's word, not proof — a maker could
                    // answer with any txpowid, never post, and keep my signed half as a free option. The take stays pending;
                    // after VOID_AFTER_MS the void pass finds my coin spent (settled) or spends it back to me (voided).
                    pt.taken = true; savePending();
                    if (run && run.act === pt.act) {
                        clearTimeout(run.wait);
                        log('  maker co-signed in ' + ((Date.now() - pt.sent) / 1000).toFixed(1) + 's · ' + (inner.filled || pt.plan.filled) + ' MINIMA @ ' + pt.order.price + ' · txpow ' + inner.txpowid);
                        run.got = run.got.add(run.taking);
                        lastAct = { id: pt.act, status: '' };
                        run.act = null; nextOrder();
                    }
                } else if (inner.k === 'refused') {
                    if (pt.act) DexiconActivity.update(pt.act, function (a) { a.stage = AX.activity.REFUSED; a.reason = String(inner.reason || 'refused'); a.cosignMs = Date.now() - pt.sent; });
                    PD.setStage('');
                    toVoid(inner.orderId, pt);   // a refusal is not proof: the maker still holds my signed half until a coin of it moves
                    delete pendingTakes[inner.orderId]; savePending(); renderMine(); PD.renderOrdersPage();
                    (pt.order.coins || []).forEach(function (id) { delete prep.maker[id]; });
                    // review 7 Nov (H1): "refused" is the maker's word, not proof — it may have posted my signed half anyway, so
                    // until the void spends my coin back the take stays counted as possibly filled and is never re-bought
                    if (run && run.act === pt.act) { clearTimeout(run.wait); run.unanswered = run.unanswered.add(run.taking); run.act = null; log('  maker refused: ' + inner.reason + ' — counted as possibly filled until voided; next order'); nextOrder(); }
                }
            });
            setTimeout(inboxLoop, err ? 2000 : 0);
        });
    }

    // ---------- fills → PandaDEX trade rows (ORDERS › MY TRADES, TRADES, CHART, export) ----------
    function loadFills(cb) {
        AX.mds.sql("SELECT k, v FROM ax_kv WHERE k LIKE 'fill_%'", function (r) {
            var rows = (r && r.rows) || [], out = [];
            rows.forEach(function (row) { try { out.push(JSON.parse(row.V || row.v)); } catch (e) { } });
            out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
            fastFills = out; DexiconActivity.setFills(out); PD.render(); if (cb) cb();
        });
    }
    function trades() {
        return fastFills.map(function (f) {
            var st = String(f.status || 'settling').toUpperCase();
            return { timems: Number(f.ts || 0) * 1000, buy: f.side === 'buy', size: f.filled, price: f.price, maker: f.role === 'maker', txpowid: f.txpowid, orderid: f.orderId,
                     spentcoin: (f.coins && f.coins[0]) || '', block: f.block || '', source_kind: 'FAST ' + st,
                     verification_status: f.status === 'done' ? 'ON-CHAIN block ' + f.block : (f.status === 'lost' ? 'LOST — never mined' : 'SETTLING'), mine: true, fast: true,
                     fill: f };   // TRADES › MY TRADES ledger evidence (exact MxUSD, counterparty, coins); the export reads named fields only
        });
    }
    function pendingRows() {
        return Object.keys(pendingTakes).filter(function (k) { return !pendingTakes[k].taken; }).map(function (k) { var p = pendingTakes[k]; return '<article class="order-card fast-order is-pending pending-row"><div class="order-top"><div><span class="side">' + (p.order.side === 'sell' ? 'BUY' : 'SELL') + '</span><strong>' + PD.fmt(p.plan.filled) + ' MINIMA <b>@</b> ' + PD.fmtPrice(p.order.price) + '</strong></div><div class="order-buttons"><button disabled>WAITING…</button></div></div><div class="order-meta"><span>⏳ waiting for the maker’s node to co-sign (' + Math.round((Date.now() - p.sent) / 1000) + 's)</span><span>' + esc(p.order.orderId) + '</span></div></article>'; }).join('');
    }
    function mergeInto(state) {
        var mine = trades(), tape;
        if (!Array.isArray(state.myTrades)) state.myTrades = [];
        state.myTrades = state.myTrades.concat(mine).sort(function (a, b) { return Number(b.timems) - Number(a.timems); });
        tape = Array.isArray(state.tape) ? state.tape : [];
        state.tape = tape.concat(mine.filter(function (t) { return t.source_kind === 'FAST DONE'; })).sort(function (a, b) { return Number(b.timems) - Number(a.timems); });
    }

    // ---------- relays ----------
    function renderRelays() {
        var box = $('relayList'), html = [], ok = 0, i, u, st;
        if (!box) return;
        for (i = 0; i < relays.length; i++) {
            u = relays[i]; st = client && client.status[u];
            if (st && st.ok) ok++;
            html.push('<div class="relay-row"><b class="' + (st ? (st.ok ? 'ok' : 'bad') : 'unk') + '">●</b><span class="url">' + esc(u) + '</span><span class="meta">' + esc(st ? (st.ok ? 'cursor ' + (client.cursors[u] || 0) : st.error) : 'untried') + '</span><button onclick="DexiconFast.removeRelay(this.parentNode.querySelector(\'.url\').textContent)">REMOVE</button></div>');
        }
        for (i = 0; i < discovered.length; i++) {
            u = discovered[i];
            if (relays.indexOf(u.url) >= 0) continue;
            html.push('<div class="relay-row discovered"><b class="unk">◌</b><span class="url">' + esc(u.url) + '</span><span class="meta">via ' + esc(u.via) + '</span><button onclick="DexiconFast.addRelay(this.parentNode.querySelector(\'.url\').textContent)">ADD</button></div>');
        }
        box.innerHTML = html.join('') || '<div class="empty-card"><strong>No relays yet</strong><span>Add the DEX port of any Parlons node or relay box, then DISCOVER to find the rest.</span></div>';
        $('relayCount').textContent = String(relays.length);
        if ($('relayPill')) { $('relayPill').textContent = '⇄ ' + ok + '/' + relays.length; $('relayPill').className = 'pill ' + (relays.length ? (ok ? 'relays-ok' : 'relays-bad') : ''); }
    }
    function loadRelays(cb) {
        AX.mds.kvGet('relays', 'unset', function (val) {
            relays = AX.relay.fromKv(val);
            if (client) client.setRelays(relays);
            renderRelays(); if (cb) cb();
        });
    }
    function saveRelays() {
        AX.mds.kvSet('relays', JSON.stringify(relays), function (err) {
            if (err) notice('Could not save relays: ' + err.message, 'error');
            if (client) client.setRelays(relays);
            renderRelays(); PD.renderBookOnly();
            if (!polling) pollLoop();
            if (!inboxPolling) inboxLoop();
        });
    }
    function addRelay(url) {
        var u = (url || $('relayInput').value || '').trim().replace(/\/+$/, '');
        if (!AX.relay.okUrl(u)) return notice('Enter an https URL like https://host:port (plain http only for a relay on this machine)', 'error');
        if (relays.indexOf(u) < 0) relays.push(u);
        $('relayInput').value = ''; saveRelays();
        notice('Relay added: ' + u, 'posted');
    }
    function removeRelay(u) { relays = relays.filter(function (x) { return x !== u; }); saveRelays(); }
    /** Decentralised bootstrap: every known relay is asked for the relays IT knows (GET /dex/relays). */
    function discover() {
        if (!relays.length) return notice('Add one relay first; discovery asks it for the others.', 'error');
        var left = relays.length, found = [];
        notice('Asking ' + left + ' relay' + (left === 1 ? '' : 's') + ' for their peers…', 'pending');
        relays.forEach(function (u) {
            var x = new XMLHttpRequest();
            x.open('GET', u + '/dex/relays', true); x.timeout = 8000;
            x.onreadystatechange = function () {
                if (x.readyState !== 4) return;
                try { var j = JSON.parse(x.responseText); (j.relays || []).forEach(function (r) { var ru = String(r.url || r).replace(/\/+$/, ''); if (AX.relay.okUrl(ru) && relays.indexOf(ru) < 0 && !found.some(function (f) { return f.url === ru; })) found.push({ url: ru, via: u }); }); } catch (e) { }
                if (--left === 0) { discovered = found; renderRelays(); notice(found.length ? found.length + ' new relay' + (found.length === 1 ? '' : 's') + ' discovered — tap ADD on the ones you want.' : 'No new relays reported (relays without /dex/relays are ignored).', found.length ? 'posted' : 'live'); }
            };
            x.send();
        });
    }
    function pollLoop() {
        if (!client || !client.relays.length) { polling = false; return; }
        polling = true;
        client.pollBook(25, function (err, changed, url) {
            renderRelays();
            if (err) PD.appendActivity('Relay ' + url + ': ' + err.message, Date.now()); else if (changed) { PD.renderBookOnly(); fastPreview(); warmMakers(); }
            setTimeout(pollLoop, err ? 2000 : 0);
        });
    }

    // ---------- settings ----------
    function loadSettings() {
        AX.mds.kvGet('coin_max_age', '', function (v) { if ($('coinMaxAge')) $('coinMaxAge').value = v || ''; });
        AX.mds.kvGet('mxusd_tokenid', '', function (t) { if ($('devToken')) $('devToken').value = t || ''; if (t) F.overrideOnTestChain(AX.mds, t, function (ok) { if (ok) { PD.appendActivity('DEV CHAIN: dollar leg is token ' + t, Date.now()); PD.balances(); } }); });
    }
    function saveSettings() {
        var age = $('coinMaxAge').value.trim(), tok = $('devToken').value.trim();
        if (age && !/^\d+$/.test(age)) return notice('Coin max age must be a whole number of blocks.', 'error');
        if (tok && !/^0x[0-9A-Fa-f]{64}$/.test(tok)) return notice('Token id must be 0x + 64 hex characters.', 'error');
        AX.mds.kvSet('coin_max_age', age, function () { F.overrideOnTestChain(AX.mds, tok, function (ok) {
            if (tok && !ok) return notice('Refused: this node is not on a test chain. The dollar-token override is for test chains only.', 'error');
            AX.mds.kvSet('mxusd_tokenid', tok, function () { notice('Settings saved' + (tok ? ' — dollar leg is now TEST token ' + tok : ''), 'posted'); PD.balances(); }); }); });
    }
    function usdToken() { return F.MXUSD !== '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90' ? F.MXUSD : null; }
    function copy(text) { if (!text || text === '—' || !navigator.clipboard) return; navigator.clipboard.writeText(String(text)); notice('Copied ' + text, 'posted'); }
    function refresh() { loadMyOrders(); loadFills(); renderRelays(); }

    // ---------- boot ----------
    function boot() {
        fetch('dapp.conf').then(function (r) { return r.json(); }).then(function (c) { version = c.version; $('versionPill').textContent = 'v' + version; window.PANDADEX_VERSION = version; }).catch(function () { });
        setMode(fastMode);
        $('price').addEventListener('input', fastPreview); $('amount').addEventListener('input', fastPreview);
        $('buySide').addEventListener('click', fastPreview); $('sellSide').addEventListener('click', fastPreview);
        AX.prng.init(function () { });
        AX.mds.kvInit(function () {
          AX.mds.cmd('checkmode', function (cm) {   // owner 30 Oct: never run on READ trust — every write would sit "pending"
            var mode = cm && cm.response;
            if (mode && (mode.writemode === false || mode.dblocked === true)) {
                meErr = mode.writemode === false ? 'needs WRITE trust' : 'node is locked';
                if (PD.renderAssets) PD.renderAssets();
                return notice(mode.writemode === false ? 'Dexicon needs WRITE trust: MiniHub → Dexicon → permissions, then reload. Nothing runs without it.'
                    : 'Unlock the node (vault action:passwordunlock), then reload.', 'error');
            }
            DexiconActivity.boot();
            AX.mds.cmdR('seedrandom modifier:dexicon-identity-v1', function (err, r) {   // one-way: the phrase never enters the page
                if (err || !r || !/^0x[0-9A-Fa-f]{64}$/.test(String(r.seedrandom || ''))) { meErr = 'needs WRITE trust'; if (PD.renderAssets) PD.renderAssets(); notice('Grant Dexicon WRITE trust in MiniHub, then reload — the maker service cannot sign without it.', 'error'); }
                else { me = AX.identity.fromSeed(r.seedrandom, 'decks'); if (PD.renderAssets) PD.renderAssets(); }
                client = new AX.relay.Client(AX.relay.xhrTransport(35000));
                loadSettings();
                loadPending(function () { loadRelays(function () { loadMyOrders(); loadFills(); pollLoop(); inboxLoop(); warmWallet(); DexiconMaker.render(); DexiconMaker.loadIds(renderMine); setInterval(sweepTakes, 30000); }); });
            });
          });
        });
    }
    window.DexiconFast = { levels: levels, crossing: crossing, fastMode: function () { return fastMode; }, setMode: setMode, place: place, mineHtml: function () { return pendingRows() + mineHtml(); }, renderMine: renderMine,
        cancelOrder: cancelOrder, editOrder: editOrder, trades: trades, mergeInto: mergeInto,
        free: free, offered: offered, refreshPreview: function () { fastPreview(); }, paintFunds: paintFunds, useMax: useMax, addRelay: addRelay, removeRelay: removeRelay, discover: discover, saveSettings: saveSettings, usdToken: usdToken, copy: copy, refresh: refresh, orders: liveOrders,
        /** ASSETS › YOUR TRADING ID: the full publicId, or why there is none yet. */
        myId: function () { return me ? me.publicId() : ''; }, myIdError: function () { return meErr; } };

    MDS.init(function (msg) {
        var packet;
        if (msg.event === 'inited') { PD.inited(); boot(); DexiconDoors.inited(); }
        else if (msg.event === 'NEWBLOCK' || msg.event === 'NEWBALANCE') { PD.balances(); warmWallet(); if (msg.event === 'NEWBLOCK') { warmMakers(); } if (msg.event === 'NEWBLOCK') { loadFills(); DexiconDoors.onBlock(); DexiconActivity.onBlock(); } }
        else if (msg.event === 'MDS_TIMER_10SECONDS') { loadMyOrders(); DexiconMaker.render(); }
        else if ((msg.event === 'MDSCOMMS' || msg.event === 'MDS_COMMS') && msg.data && !msg.data.public) {
            try { packet = JSON.parse(msg.data.message || '{}'); } catch (e) { return; }
            if (PD.servicePacket(packet)) { DexiconActivity.render(); return; }
            if (packet && packet.type === 'fill') { loadFills(); loadMyOrders(); if (packet.status === 'done') PD.appendActivity('Fill settled on chain: txpow ' + packet.txpowid, Date.now()); }
            else if (packet && packet.type === 'door') DexiconDoors.refresh();
            else if (packet && packet.type === 'ladder') { DexiconMaker.render(); DexiconMaker.loadIds(function () { loadMyOrders(); }); }   // the market maker changed its ladder   // the DOORS engine (service) changed a swap or a forward
        }
    });
})();
