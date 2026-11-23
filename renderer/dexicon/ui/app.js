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
    var M = AX.maker, F = AX.fill, E = AX.envelope, T = AX.takeable;
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
    /** Owner 22 Nov: "If an order is not tradable, it shouldn't be displayed anywhere as a real market." An order is
     *  market only when THIS node's rows show it can be taken as displayed (lib/takeable.js), and it is inside the scope
     *  the ladder and a sweep can reach. Not yet checked = not shown. My own orders always show. */
    var VC = new T.Cache(function (c, cb) { AX.mds.cmdR(c, cb); }, { onChange: function () { PD.renderBookOnly(); fastPreview(); bridgeCheck(); },
        log: function (s) { PD.appendActivity(s, Date.now()); }, onMissing: function (o) { return PF.want(o); },
        afterPass: function () { PF.flush(); },   // 0.0.121: one coin proof request per maker per height, sent when a pass ends
        onAttest: function (o) { PF.wantAttest(o); } });   // 0.0.129: a takeable order's maker is asked to attest its addresses
    /** 0.0.112, the coin proof hand-over (lib/proofs.js): a coin this node cannot see (older than its window) is asked of the
     *  order's maker; its proof is checked, imported (`coinimport track:false`) and the order re-checked by the rules above. */
    var PF = new AX.proofs.Taker({ cmd: function (c, cb) { AX.mds.cmdR(c, cb); }, count: function () { VC.spent++; },   // 0.0.115: inside the 128-a-height lookup budget
        lock: function (body, fail) { AX.maker.withLock(AX.mds, 'coinimport', body, fail); },   // 0.0.137: one import at a time across this node's pages
        send: function (o, ids, attest) {
            if (!me || !client) return;
            client.publish(E.msg(me, o.pubId, AX.identity.seal(me, o.pubId, AX.hex.utf8(JSON.stringify({ k: 'proofs?', coins: ids, attest: attest || [] }))), nowS() + 120), function () { });
        },
        // 0.0.129: every attestation verdict reaches the verdict cache; a verified one is kept (kv 'attested') across reloads
        attested: function (address, signPk, ok) { VC.attest(address, signPk, ok); if (ok) saveAttested(signPk + '|' + address); },
        proven: function (ids, by) { PD.appendActivity('Coin proof imported: this node now sees coin' + (ids.length === 1 ? ' ' : 's ') + ids.join(', '), Date.now()); VC.proven(ids, by); warmMakers(); },
        log: function (s) { PD.appendActivity(s, Date.now()); } });
    /** 0.0.129: the verified (signPk|address) pairs, at most 4096, so a reload does not ask every maker again. */
    var attestedKeys = [];
    function saveAttested(k) { if (attestedKeys.indexOf(k) >= 0) return; attestedKeys.push(k); if (attestedKeys.length > 4096) attestedKeys.shift(); AX.mds.kvSet('attested', JSON.stringify(attestedKeys), function () { }); }
    function loadAttested() {
        AX.mds.kvGet('attested', '[]', function (v) {
            try { attestedKeys = JSON.parse(v || '[]') || []; } catch (e) { attestedKeys = []; }
            // review 23 Nov (0.0.151): the Taker knows a verified pair by its FULL key (signPk|address, as it looks it up); it
            // was keyed by the signPk alone, so every reload asked every maker to attest again
            attestedKeys.forEach(function (k) { var p = String(k).split('|'); if (p.length === 2) { PF.attOk[String(k).toLowerCase()] = true; VC.attest(p[1], p[0], true); } });
        });
        // kv require_attest (default OFF while makers update): ON hides every FAST order whose coins' addresses its maker has not attested
        AX.mds.kvGet('require_attest', '', function (v) { VC.requireAttest = /^(1|true|on|yes)$/i.test(String(v || '').replace(/^\s+|\s+$/g, '')); warmMakers(); });
    }
    function shownNow() { return T.visible(liveOrders(), VC.verdicts(), mySignPk()); }
    /** Levels for the ladder: [{price, minima, exact, mine}] on one side, quantised to the grouping tick like PandaDEX. */
    function levels(sell, tick) {
        var out = {}, keys = [], orders = liveOrders(), shown = shownNow(), i, o, price, amount, level, key, t = tick ? D(tick) : null;
        for (i = 0; i < orders.length; i++) {
            o = orders[i];
            if ((o.side === 'sell') !== !!sell) continue;
            price = PD.num(o.price); amount = PD.num(o.amount);
            if (!price || !amount || !amount.gt(0) || !shown[T.okey(o)]) continue;   // unbacked, a coin spent or outside this node's window, or not yet checked: nobody here can take it, so not on the book
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
        var p = PD.num(price), out = [], orders = liveOrders(), shown = shownNow(), i, o, op;
        if (!p) return out;
        for (i = 0; i < orders.length; i++) {
            o = orders[i]; op = PD.num(o.price);
            if (!op || o.signPk.toLowerCase() === mySignPk() || !shown[T.okey(o)]) continue;
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
    /** Why no trade can start now ('' when one can). */
    function cannotTrade() {
        if (run) return 'a trade is already running';
        if (!me) return 'Identity not ready — grant WRITE trust in MiniHub and reload.';
        if (!relays.length) return 'Add a relay first (RELAYS tab).';
        return '';
    }
    /** The page's own button: reads the form, then the ONE shared start (a sweep, or a resting FAST order). */
    function place(isBuy) {
        var price = $('price').value.trim(), amount = $('amount').value.trim(), p = PD.num(price), a = PD.num(amount), why = cannotTrade();
        if (run) return;
        if (why) return notice(why, 'error');
        if (!p || !p.gt(0) || !a || !a.gt(0)) return notice('Enter a valid price and amount.', 'error');
        start(isBuy, p.toFixed(), a.toFixed(), null);
    }
    /** ONE function for the button and the host (0.0.100): when FAST orders cross, the sweep (executeTake); otherwise
     *  the button rests a FAST order, and a host take (`host` = its callback, take-only) reports that nothing crossed
     *  and sends nothing. */
    function start(isBuy, price, amount, host) {
        if (crossing(isBuy, price).length) return executeTake(isBuy, price, amount, host);
        if (host) return host({ ok: true, got: '0', unanswered: '0', tried: [], reason: 'Nothing on the FAST book crosses ' + price + '. Nothing was sent.' });
        createFast({ side: isBuy ? 'buy' : 'sell', price: price, amount: amount }, function (err) { if (!err) { $('amount').value = ''; PD.preview(); fastPreview(); } });
    }
    /** A programmatic FAST take for a host (the desktop apps' native screen), on the SAME run as the button. It never
     *  rests anything: takeOnly must be strictly true, anything else is refused. cb({ok, got, unanswered, tried, reason})
     *  with exact decimal strings: got = MINIMA co-signed and sent; unanswered = MINIMA sent to makers who did not answer
     *  in time (it may still fill within 5 minutes); tried = the order ids the run walked. */
    function take(spec, cb) {
        var done = typeof cb === 'function' ? cb : function () { }, p, a, why;
        function refuse(r) { done({ ok: false, got: '0', unanswered: '0', tried: [], reason: r }); }
        if (!spec || spec.takeOnly !== true) return refuse('take() is take-only: takeOnly must be true (got ' + JSON.stringify(spec ? spec.takeOnly : spec) + '). Nothing was sent.');
        if (spec.isBuy !== true && spec.isBuy !== false) return refuse('isBuy must be true or false. Nothing was sent.');
        p = PD.num(spec.limit); a = PD.num(spec.amount);
        if (!p || !p.gt(0) || !a || !a.gt(0)) return refuse('limit and amount must be positive decimals. Nothing was sent.');
        if ((why = cannotTrade())) return refuse(why + '. Nothing was sent.');
        start(spec.isBuy, p.toFixed(), a.toFixed(), done);
    }
    function createFast(spec, cb) {
        PD.setStage('Publishing fast order…'); PD.paintNotice();
        M.create(AX.mds, client, me, spec, function (err, o, results, wait) {
            PD.setStage('');
            if (err) { notice('Order not placed: ' + err.message, 'error'); return cb && cb(err); }
            var ok = results.filter(function (r) { return r.ok; }).length;
            // 0.0.102: placed on coins being refreshed → it is on the relays now and goes live to takers after the next block
            notice('Fast ' + spec.side + ' ' + spec.amount + ' MINIMA @ ' + spec.price + (wait ? ' ' + wait + ' — on ' : ' live on ') + ok + '/' + results.length + ' relay' + (results.length === 1 ? '' : 's') + ' — order ' + o.orderId, o.relockError ? 'error' : 'posted');
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
                + (coins ? '' : o.relockError ? '<p>⚠ Not fillable yet: refreshing its coins failed (' + esc(o.relockError) + '). Retried automatically, backing off after each failure.</p>'
                    : '<p>⏳ ' + ((o.relocking || []).length ? 'Goes live to takers after the next block (refreshing your coins).' : 'Not fillable until your node re-backs it (backing coins moved or aged out; the service re-locks them).') + '</p>')
                + '<div class="trade-evidence">order ' + esc(o.orderId) + ' · pays to ' + esc(o.address) + '</div></article>');
        }
        return out.join('');
    }
    function renderMine() { var box = $('fastMine'); if (box) box.innerHTML = pendingRows() + mineHtml(); }
    function cancelOrder(orderId) {
        if (!confirm('Cancel this fast order? It disappears from every relay immediately.')) return;
        M.cancel(AX.mds, client, me, orderId, function (err) { notice(err ? 'Cancel failed: ' + err.message : 'Fast order ' + orderId + ' cancelled', err ? 'error' : 'posted'); loadMyOrders(); });
    }
    /** What the user typed into an EDIT that was refused (e.g. an unreadable chain tip): the next EDIT starts from it. */
    var editDraft = {};
    function editOrder(orderId, price) {
        var next = prompt('New price (MxUSD per MINIMA)', editDraft[orderId] || price || ''), d, o;
        if (next === null) return;
        d = PD.num(next); if (!d || !d.gt(0)) return notice('Enter a valid new price.', 'error');
        o = M.find(myOrders, orderId); if (!o) return;
        M.edit(AX.mds, client, me, orderId, { price: d.toFixed(), amount: o.remaining }, function (err, x, wait) {
            if (err) editDraft[orderId] = next; else delete editDraft[orderId];
            notice(err ? 'Edit failed: ' + err.message + ' — your price ' + next + ' is kept for the next EDIT' : 'Fast order ' + orderId + ' repriced to ' + d.toFixed() + (wait ? ' — ' + wait : ''), err ? 'error' : 'posted'); loadMyOrders();
        });
    }

    // ---------- taking: ONE click, the MinimaXT way ----------
    // MinimaXT's book carries every maker's coins, so pressing BUY/SELL IS the trade: nothing is looked up after the
    // click, every valid order is tried in turn without asking again, and a log under the button prints each step.
    // Here the order carries coin ids only, so the coins are fetched AHEAD (book change, new block, balance change) and
    // the click uses what is already in memory.
    var prep = { wallet: {}, addr: null };   // makers' coins: the verdict cache VC (fetched with each verdict)
    function warmWallet() {
        [F.MINIMA, F.MXUSD].forEach(function (tok) { M.walletCoins(AX.mds, tok, function (e, coins) { if (!e) prep.wallet[tok] = coins; }); });
        AX.mds.cmdR('getaddress', function (e, r) { if (!e && r && r.address) prep.addr = r.address; });
    }
    /** Look up (in the background) the backing coins of the orders the ladder or a sweep can reach (lib/takeable.js
     *  warm: one queue per call — shown orders first, then orders with no evidence against them, new orders best price
     *  first, then due 'no' orders — within 128 lookups per block height). Book change and every block. */
    function warmMakers() { VC.warm(liveOrders(), mySignPk(), function () { if (!booted && polledOnce) { booted = true; bridgeCheck(); } }); }
    function blockOf(msg) { var h = msg && msg.data && msg.data.txpow && msg.data.txpow.header; return parseInt(h && h.block, 10) || 0; }
    /** The maker's coin rows for a take: a row confirmed in THIS block is used as is; any other coin is looked up again
     *  now, so a take never rests on a lookup from an older block. cb(err, rows, allFromThisBlock). */
    function makerCoins(o, cb) {
        var have = [], i = 0, fetched = false;
        (function step() {
            if (i >= o.coins.length) return cb(null, have, !fetched);
            var id = o.coins[i++], c = VC.coin(id);
            if (c) { have.push(c); return step(); }
            fetched = true;
            VC.ask(id, function (err, row) {
                if (err) return cb(err);
                if (!row) return cb(new Error('coin ' + id + ' not visible to this node unspent (spent, being spent, or outside its chain window)'));
                have.push(row); step();
            });
        })();
    }
    /** 0.0.98: a failed build is MY fault (the run ends: the next order would fail the same way) only when it names one
     *  of my own input coins, is my own guard about my own wallet, or is a step that never touches the order (create,
     *  sign, export). Anything else — a maker coin not found, a script the node lacks, an output it refuses — is the
     *  ORDER's fault: the order is hidden with the node's reason and the sweep goes on. */
    function myBuildFault(err, o, p) {
        var m = String((err && err.message) || err || '').toLowerCase(), theirs = {}, i;
        if (/cannot read your wallet scripts|no signing key for your coin address|none of your coins to sign/.test(m) || /^(txncreate|txnsign|txnexport)\b/.test(m)) return true;
        for (i = 0; i < (o.coins || []).length; i++) theirs[String(o.coins[i]).toLowerCase()] = 1;
        for (i = 0; i < ((p && p.inputs) || []).length; i++) { var id = String(p.inputs[i]).toLowerCase(); if (!theirs[id] && m.indexOf(id) >= 0) return true; }
        return false;
    }
    /** The line under the book: how many FAST orders are hidden and why; tap it for each one with its whole ids (the
     *  first T.LIST_MAX, then how many more). The list is rebuilt only when a verdict or the hidden set changed. */
    var hiddenOpen = false, hiddenKey = '';
    function paintHidden() {
        var line = $('fastHidden'), list = $('fastHiddenList'), h, text, key, rep;
        if (!line || !list) return;
        h = T.hidden(liveOrders(), VC.verdicts(), mySignPk()); text = T.summary(h);
        if (!text) hiddenOpen = false;
        line.textContent = text ? text + (hiddenOpen ? '  ▴' : '  ▾') : ''; line.hidden = !text;
        list.hidden = !hiddenOpen;
        key = hiddenOpen ? VC.rev + '|' + h.no + '|' + h.unknown + '|' + h.list.map(function (e) { return e.order.orderId + ':' + e.order.seq; }).join(',') : '';
        if (key === hiddenKey) return;
        hiddenKey = key;
        if (!hiddenOpen) { list.innerHTML = ''; return; }
        rep = T.report(h);
        list.innerHTML = rep.entries.map(function (lines) { return '<div class="trade-evidence">' + lines.map(esc).join('<br>') + '</div>'; }).join('')
            + (rep.more ? '<div class="trade-evidence">and ' + rep.more + ' more</div>' : '');
    }
    function toggleHidden() { hiddenOpen = !hiddenOpen; paintHidden(); }

    // the trade log under the order button, and the locked button
    // the take in progress: {t0, isBuy, price, amount, left, got, unanswered, taking, tried[], act, timer}. Owner 7 Nov, the
    // sweep (mirror of APK 0.2.76): `left` drops by each take SENT, answered or not — an unanswered take may still be
    // co-signed inside its 5-minute void window, so it counts as possibly filled and a run never buys more than asked.
    var run = null, SWEEP_MAX_ORDERS = T.SWEEP_MAX_ORDERS, SWEEP_WAIT_MS = 30000;
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
    function executeTake(isBuy, price, amount, host) {
        var box = $('tradeLog');
        if (run) return host && host({ ok: false, got: '0', unanswered: '0', tried: [], reason: 'a trade is already running. Nothing was sent.' });
        if (!voids) return loadVoids(function () { if (voids) executeTake(isBuy, price, amount, host); });   // void records first (coins + orders to skip)
        if (box) box.innerHTML = '';
        run = { t0: Date.now(), isBuy: isBuy, price: price, amount: amount, left: D(amount), got: D(0), unanswered: D(0), taking: D(0), tried: [], host: host || null, fault: '' };
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
            if (!r.tried.length && r.host) { log('Nothing crosses any more — nothing was sent (take-only).'); return finishSweep(); }
            if (!r.tried.length) { log('Nothing crosses any more — placing it as a FAST order instead.'); createFast({ side: r.isBuy ? 'buy' : 'sell', price: r.price, amount: r.amount }); return unlock(); }
            log('No other FAST order crosses ' + r.price + '.');
            return finishSweep();
        }
        if (!r.tried.length) log('Found ' + hits.length + ' FAST order' + (hits.length === 1 ? '' : 's') + ' at or better than your price');
        tryOrder(hits[0]);
    }
    function tryOrder(o) {
        var r = run, a = r.left, plan = plannedTake(o, a), now = plan.take, myTok = o.side === 'sell' ? F.MXUSD : F.MINIMA;
        r.tried.push(o.orderId);
        if (plan.skip) { log('Order ' + o.orderId + ': ' + plan.skip + ' — next order'); return nextOrder(); }
        if (now.lt(Decimal.min(a, D(o.amount)))) log('  taking ' + now.toFixed() + ' so ' + AX.fill.MIN_REM + ' MINIMA stays on the maker\'s order (minimum remainder)');
        log('Order ' + o.orderId + ' @ ' + o.price + ' · ' + o.amount + ' MINIMA · maker ' + o.address);
        makerCoins(o, function (err, mc, cached) {
            if (err) { log('  maker coins: ' + err.message + ' — next order'); return nextOrder(); }
            log('  maker coins ' + (cached ? 'ready' : 'fetched') + ' (' + mc.length + ')');
            // 0.0.98: the rows just fetched must still show the order takeable as displayed (lib/takeable.js check)
            var chk = VC.refresh(o, mySignPk());
            if (chk.state !== 'ok') { log('  order ' + o.orderId + ' skipped: ' + chk.reason + ' — next order'); return nextOrder(); }
            var go = function (myCoins, addr) {
                var p;
                try { p = F.plan(o, now.toFixed(), mc, myCoins, addr); } catch (e) {
                    // my wallet cannot pay: every order would fail the same way, so the run ends; a take too small for the
                    // grain is about my amount, not the order; anything else is this order's fault — it is hidden, next order
                    if (/your wallet does not cover/.test(e.message)) return endRun(e.message);
                    if (!/below grain/.test(e.message)) { VC.flag(o, e.message); warmMakers(); log('  order ' + o.orderId + ' hidden: ' + e.message + ' — next order'); }
                    else log('  ' + e.message + ' — next order');
                    return nextOrder();
                }
                log('  you give ' + p.takerGives + (o.side === 'sell' ? ' MxUSD' : ' MINIMA') + ', you get ' + p.makerGives + (o.side === 'sell' ? ' MINIMA' : ' MxUSD'));
                sendTake(o, p, null);   // the sweep never rests a remainder
            };
            if (prep.wallet[myTok] && prep.addr) return go(notPending(prep.wallet[myTok]), prep.addr);
            M.walletCoins(AX.mds, myTok, function (e2, coins) {
                if (e2) return endRun('cannot read your coins: ' + e2.message);
                prep.wallet[myTok] = coins;
                AX.mds.cmdR('getaddress', function (e3, ad) { if (e3 || !ad) return endRun('getaddress failed'); prep.addr = ad.address; go(notPending(coins), ad.address); });
            });
        });
    }
    /** What the run does with order `o` while `left` MINIMA are still wanted: {take (Decimal, 0 when skipped), skip
     *  (the reason, '' when taken)}. tryOrder and crossingView both use it, so the host sees the walk the click makes. */
    function plannedTake(o, left) {
        // PandaDEX's min-remainder floor: a partial take never leaves under 1 MINIMA on the maker's order — it is shrunk
        // to leave exactly 1 (the sweep moves on for the rest); an order it can't touch is skipped
        var now = AX.fill.floorTake(Decimal.min(left, D(o.amount)), o.amount);
        if (!now.gt(0)) return { take: D(0), skip: 'a partial take would leave under ' + AX.fill.MIN_REM + ' MINIMA' };
        // security review 7 Nov (mirror of APK 0.2.42): pending takes are keyed by order id — a second take would overwrite
        // the first record and that signed half would never be voided
        if (pendingTakes[o.orderId]) return { take: D(0), skip: 'your earlier take of it is still settling' };
        // review 7 Nov (L): voids are keyed by order id — a new take of an order whose earlier take is still being voided
        // would overwrite that void record
        if (voids && voids[o.orderId]) return { take: D(0), skip: 'your earlier take of it is still being voided' };
        return { take: now, skip: '' };
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
    /** A fault of MINE ends the run (the next order would fail the same way): said in the log, and to a host. */
    function endRun(why) { log('  ' + why); if (run) run.fault = why; finishSweep(); }
    /** The sweep's last lines: what was co-signed, what may still be, and that nothing rests. */
    function finishSweep() {
        var r = run; if (!r) return;
        var open = D(r.amount).sub(r.got).sub(r.unanswered);
        if (r.host) {   // a host take: the result goes to its callback; the page's amount field is the user's, untouched
            var res = { ok: !r.fault, got: r.got.toFixed(), unanswered: r.unanswered.toFixed(), tried: r.tried.slice(),
                reason: r.fault || (r.got.gt(0) || r.unanswered.gt(0) ? open.toFixed() + ' MINIMA not traded; nothing was placed as an order.' : 'Nothing was traded and nothing was placed.') };
            log(r.got.toFixed() + ' of ' + r.amount + ' MINIMA co-signed, ' + r.unanswered.toFixed() + ' waiting on makers (host take, nothing rests).');
            unlock(); try { r.host(res); } catch (e) { }
            return;
        }
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
            if (err) {
                DexiconActivity.update(actId, function (a) { a.stage = AX.activity.FAILED; a.reason = 'build failed: ' + err.message; }); log('  build failed: ' + err.message);
                if (myBuildFault(err, o, p)) return endRun('your side could not be built: ' + err.message);
                // the order's fault: it is 'no' with the node's reason (re-checked), the run takes the next order
                VC.flag(o, 'the take failed: ' + err.message); warmMakers();
                log('  order ' + o.orderId + ' hidden: the node refused its take — next order');
                return nextOrder();
            }
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
                    r.unanswered = r.unanswered.add(r.taking); return endRun('no relay accepted the take: ' + (results[0] && results[0].error));
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
                if (inner && inner.k === 'proofs') return PF.reply(opened.fromPublicId, inner.proofs, inner.attest);   // 0.0.112: a maker's coin proofs (0.0.129: and attestations)
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
                    VC.recheck(pt.order.coins || []);   // fetch them again before another take; the next block re-checks
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
        booted = false; polledOnce = false;   // a new relay set is a new book: ready() again only after its first warm
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
            if (!err) polledOnce = true;
            if (err) PD.appendActivity('Relay ' + url + ': ' + err.message, Date.now()); else if (changed) { PD.renderBookOnly(); fastPreview(); warmMakers(); bridgeCheck(); }
            setTimeout(pollLoop, err ? 2000 : 0);
        });
    }

    // ---------- settings ----------
    function loadSettings() {
        AX.mds.kvGet('coin_max_age', '', function (v) {
            // 0.0.95: the age is clamped to 1..COIN_MAX_AGE (900 since 0.0.101; AX.maker.maxAgeOf); a larger saved value is shown as what is used, and why
            var used = M.maxAgeOf(v), over = parseInt(v, 10) > M.COIN_MAX_AGE;
            if ($('coinMaxAge')) $('coinMaxAge').value = over ? String(used) : (v || '');
            if ($('coinMaxAgeNote') && over) $('coinMaxAgeNote').textContent = 'The saved ' + v + ' is read as ' + used + ' blocks: ' + M.WHY_MAX_AGE + '.';
        });
        AX.mds.kvGet('mxusd_tokenid', '', function (t) { if ($('devToken')) $('devToken').value = t || ''; if (t) F.overrideOnTestChain(AX.mds, t, function (ok) { if (ok) { PD.appendActivity('DEV CHAIN: dollar leg is token ' + t, Date.now()); PD.balances(); } }); });
    }
    function saveSettings() {
        var age = $('coinMaxAge').value.trim(), tok = $('devToken').value.trim();
        if (age && !/^\d+$/.test(age)) return notice('Coin max age must be a whole number of blocks.', 'error');
        if (age && (parseInt(age, 10) < 1 || parseInt(age, 10) > M.COIN_MAX_AGE)) return notice('Coin max age must be 1 to ' + M.COIN_MAX_AGE + ' blocks: ' + M.WHY_MAX_AGE + '.', 'error');
        if (tok && !/^0x[0-9A-Fa-f]{64}$/.test(tok)) return notice('Token id must be 0x + 64 hex characters.', 'error');
        AX.mds.kvSet('coin_max_age', age, function () { F.overrideOnTestChain(AX.mds, tok, function (ok) {
            if (tok && !ok) return notice('Refused: this node is not on a test chain. The dollar-token override is for test chains only.', 'error');
            AX.mds.kvSet('mxusd_tokenid', tok, function () { notice('Settings saved' + (tok ? ' — dollar leg is now TEST token ' + tok : ''), 'posted'); PD.balances(); }); }); });
    }
    function usdToken() { return F.MXUSD !== '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90' ? F.MXUSD : null; }
    function copy(text) { if (!text || text === '—' || !navigator.clipboard) return; navigator.clipboard.writeText(String(text)); notice('Copied ' + text, 'posted'); }
    function refresh() { loadMyOrders(); loadFills(); renderRelays(); }

    // ---------- read-only views for a desktop/host bridge (0.0.96): no side effects, plain strings, whole ids ----------
    // The native desktop screen draws THESE (the page performs the takes), so it never shows what a take refuses.
    /** The FAST ladder for one side as drawn: best price first, at most T.LADDER_LEVELS levels, grouped by the page's
     *  current tick unless `tick` is given ('' = exact). [{price, exact, size, cumulative, own}]. */
    function bookView(sell, tick) {
        var t = arguments.length > 1 ? tick : (PD.group ? PD.group() : ''), cum = D(0);
        return levels(!!sell, t || null).sort(function (a, b) { return sell ? a.price.cmp(b.price) : b.price.cmp(a.price); }).slice(0, T.LADDER_LEVELS)
            .map(function (r) { cum = cum.add(r.minima); return { price: r.price.toFixed(), exact: r.exact.toFixed(), size: r.minima.toFixed(), cumulative: cum.toFixed(), own: !!r.mine }; });
    }
    /** What a click at `limit` would walk: the takeable FAST orders on the opposite side, best price first (crossing),
     *  never mine, each with `take` (the exact MINIMA the run would take from it: the min-remainder floor applied) and
     *  `skip` ('' or why the run passes it: still settling, being voided, a take that would leave under 1 MINIMA). With
     *  `amount`, the walk stops where the run stops: the amount covered, or T.SWEEP_MAX_ORDERS orders (skipped ones count,
     *  as in the run). Assumes every take is co-signed in full. Copies. */
    function crossingView(isBuy, limit, amount) {
        var hits = crossing(!!isBuy, limit), out = [], left = amount !== undefined && amount !== null && amount !== '' ? PD.num(amount) : null, i, o, pt;
        for (i = 0; i < hits.length; i++) {
            if (left && (!left.gt(0) || out.length >= T.SWEEP_MAX_ORDERS)) break;
            o = hits[i]; pt = plannedTake(o, left || D(o.amount));
            out.push({ orderId: String(o.orderId), side: o.side, price: String(o.price), amount: String(o.amount), signPk: String(o.signPk), pubId: String(o.pubId || ''),
                       address: String(o.address || ''), coins: (o.coins || []).map(String), take: pt.take.toFixed(), skip: pt.skip });
            if (left) left = left.sub(pt.take);
        }
        return out;
    }
    /** The line under the book and its list: {no, unknown, summary, entries: [[lines]] (first T.LIST_MAX), more}. */
    function hiddenView() { return T.report(T.hidden(liveOrders(), VC.verdicts(), mySignPk())); }
    /** 0.0.100 change signal for a host: rev() counts changes of what the views return (the takeable book — every shown
     *  order's id, seq, price and amount — and the hidden summary), onChange(fn) calls fn(rev) on each; ready() is true
     *  once the first warm of the current book has completed (before it, bookView holds only my own orders). */
    var bridgeRev = 0, bridgeSig = '', bridgeSubs = [], booted = false, polledOnce = false;
    function bridgeCheck() {
        var shown = shownNow(), h = T.hidden(liveOrders(), VC.verdicts(), mySignPk()), sig;
        sig = JSON.stringify([booted, liveOrders().filter(function (o) { return shown[T.okey(o)]; }).map(function (o) { return [T.okey(o), o.seq, o.price, o.amount]; }).sort(), h.no, h.unknown, T.summary(h)]);
        if (sig === bridgeSig) return;
        bridgeSig = sig; bridgeRev++;
        bridgeSubs.forEach(function (fn) { try { fn(bridgeRev); } catch (e) { } });
    }
    function onBridgeChange(fn) { if (typeof fn === 'function') bridgeSubs.push(fn); return bridgeRev; }

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
                loadSettings(); loadAttested();
                // 0.0.114: a MegaMMR node finds every unspent coin with `coins megammr:true coinid:` (no proof needed)
                AX.mds.cmdR('status', function (es, st) { if (!es && st && st.megammr === true) { VC.megammr = true; warmMakers(); } });
                loadPending(function () { loadRelays(function () { loadMyOrders(); loadFills(); pollLoop(); inboxLoop(); warmWallet(); DexiconMaker.render(); DexiconMaker.loadIds(renderMine); setInterval(sweepTakes, 30000); }); });
            });
          });
        });
    }
    window.DexiconFast = { levels: levels, crossing: crossing, fastMode: function () { return fastMode; }, setMode: setMode, place: place, mineHtml: function () { return pendingRows() + mineHtml(); }, renderMine: renderMine,
        cancelOrder: cancelOrder, editOrder: editOrder, trades: trades, mergeInto: mergeInto,
        free: free, offered: offered, refreshPreview: function () { fastPreview(); }, paintFunds: paintFunds, useMax: useMax, addRelay: addRelay, removeRelay: removeRelay, discover: discover, saveSettings: saveSettings, usdToken: usdToken, copy: copy, refresh: refresh,
        /** ASSETS › YOUR TRADING ID: the full publicId, or why there is none yet. */
        myId: function () { return me ? me.publicId() : ''; }, myIdError: function () { return meErr; },
        paintHidden: paintHidden, toggleHidden: toggleHidden,
        bookView: bookView, crossingView: crossingView, hiddenView: hiddenView,
        rev: function () { return bridgeRev; }, onChange: onBridgeChange, ready: function () { return booted; }, take: take };

    MDS.init(function (msg) {
        var packet;
        if (msg.event === 'inited') { PD.inited(); boot(); DexiconDoors.inited(); }
        else if (msg.event === 'NEWBLOCK' || msg.event === 'NEWBALANCE') { PD.balances(); warmWallet(); if (msg.event === 'NEWBLOCK') { VC.onBlock(blockOf(msg), Date.now()); PF.onBlock(blockOf(msg)); warmMakers(); bridgeCheck(); } if (msg.event === 'NEWBLOCK') { loadFills(); DexiconDoors.onBlock(); DexiconActivity.onBlock(); } }
        else if (msg.event === 'MDS_TIMER_10SECONDS') { loadMyOrders(); DexiconMaker.render(); if (VC.settle(Date.now())) warmMakers(); }   // a catch-up burst settled
        else if ((msg.event === 'MDSCOMMS' || msg.event === 'MDS_COMMS') && msg.data && !msg.data.public) {
            try { packet = JSON.parse(msg.data.message || '{}'); } catch (e) { return; }
            if (PD.servicePacket(packet)) { DexiconActivity.render(); return; }
            if (packet && packet.type === 'fill') { loadFills(); loadMyOrders(); if (packet.status === 'done') PD.appendActivity('Fill settled on chain: txpow ' + packet.txpowid, Date.now()); }
            else if (packet && packet.type === 'door') DexiconDoors.refresh();
            else if (packet && packet.type === 'ladder') { DexiconMaker.render(); DexiconMaker.loadIds(function () { loadMyOrders(); }); }   // the market maker changed its ladder   // the DOORS engine (service) changed a swap or a forward
        }
    });
})();
