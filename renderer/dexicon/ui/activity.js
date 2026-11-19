/**
 * ui/activity.js — the ACTIVITY tab (window.DexiconActivity): a rolling log — live items show their steps, finished items
 * fold to one headline (AX.calm), every id in full in the proof fold.
 * Mirrors the Android ActivityTab (apks/dexicon 0.1.9); the stage machine is lib/activity.js (AX.activity).
 * Rows live in ax_kv 'activity' (this page is their only writer). Sources:
 *   FAST taker   ui/app.js sendTake / inboxLoop call record()/update()
 *   FAST maker   the service's fill_<txpowid> rows (merged in, AX.activity.merge)
 *   BOOK/POOL    the vendored PDService's own in-flight fill_state (txpowid, size, proceeds, source coins) and busy/stage
 * Tracking runs while this page is open (NEWBLOCK + every 10 s): inputs first, then the output — FAST rows by
 * `coins coinid:<output>`, BOOK/POOL rows by the exact proceeds coin PDService itself verifies. Never by time.
 */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var A = AX.activity, C = AX.calm, rows = [], fills = [], loaded = false, tracking = false, liveId = null, tip = 0;
    var USD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';

    function esc(s) { return PD.esc(s); }
    function save() { AX.mds.kvSet('activity', JSON.stringify(rows), function () { }); }
    function load(cb) {
        AX.mds.kvGet('activity', '[]', function (v) { try { rows = JSON.parse(v || '[]'); } catch (e) { rows = []; } loaded = true; if (cb) cb(); });
    }
    function chainTip() { return Math.max(tip, Number((PD.state() || {}).block || 0)); }

    /** New row (FAST taker from app.js); it becomes the one the TRADE status line follows. */
    function record(row) { row.ts = row.ts || Date.now(); rows = A.upsert(rows, row); liveId = row.id; save(); render(); }
    function update(id, fn) { var r = A.find(rows, function (x) { return x.id === id; }); if (!r) return; fn(r); save(); render(); }
    function setFills(list) { fills = list || []; render(); }

    /** Adopt PDService's in-flight BOOK/POOL fill (fill_state) as a slow row, once per txpowid. */
    function adoptSlow(cb) {
        MDS.sql("SELECT `json` FROM `fill_state` WHERE `id`=1", function (res) {
            var raw = null, r = (res && res.rows) || [];
            try { if (r.length) raw = JSON.parse(r[0].json || r[0].JSON || 'null'); } catch (e) { raw = null; }
            var m = raw && raw.meta;
            if (m && m.txpowid && !A.find(rows, function (x) { return x.txpowid === m.txpowid; })) {
                var row = A.fromSlow(m, Date.now()); row.payTok = m.buy ? '0x00' : USD;
                rows = A.upsert(rows, row); liveId = row.id; save();
            }
            if (cb) cb();
        });
    }

    function cmd(c, cb) { AX.mds.cmdR(c, function (err, r) { cb(err ? null : r); }); }
    function first(r) { return Object.prototype.toString.call(r) === '[object Array]' ? r[0] : r; }
    function inputsGone(ins, i, cb) {
        if (!ins || i >= ins.length) return cb(false);
        cmd('coins coinid:' + ins[i], function (r) {
            if (r === null) return inputsGone(ins, i + 1, cb);            // unreadable is not "gone"
            var c = first(r);
            if (!c || !c.coinid || c.spent === true) return cb(true);
            inputsGone(ins, i + 1, cb);
        });
    }
    /** The output evidence: FAST → the first output coin's created block; BOOK/POOL → the exact proceeds coin. */
    function outCreated(a, cb) {
        if (a.outs && a.outs.length && /^0x[0-9A-Fa-f]{64}$/.test(String(a.outs[0]))) return cmd('coins coinid:' + a.outs[0], function (r) { var c = r && first(r); cb(c && c.coinid ? Number(c.created || 0) : 0); });
        var st = PD.state() || {}, addr = st.identity && st.identity.address;
        if (!a.proceeds || !addr) return cb(0);
        cmd('coins simplestate:true address:' + addr + ' tokenid:' + (a.payTok || '0x00') + ' coinage:0 depth:' + Math.max(12, chainTip() - Number(a.postBlock || 0) + 6), function (r) {
            var c = A.proceedsCoin(r, a.payTok || '0x00', a.proceeds, a.postBlock);
            if (c) a.outs = [c.coinid];
            cb(c ? Number(c.created || 0) : 0);
        });
    }
    function track() {
        if (tracking || !loaded) return;
        adoptSlow(function () {
            var now = Date.now(), todo = rows.filter(function (a) { return A.watch(a, chainTip(), now); });
            if (!todo.length) return render();
            tracking = true;
            cmd('block', function (b) {
                tip = Math.max(tip, Number((b && b.block) || 0));
                var i = 0, changed = false;
                (function step() {
                    if (i >= todo.length) { tracking = false; if (changed) save(); return render(); }
                    var a = todo[i++], probe = !Number(a.block) && (a.stage === A.POSTED || a.stage === A.COSIGNED || a.stage === A.DROPPED);
                    if (!probe) { changed = A.observe(a, tip, false, 0, Date.now()) || changed; return step(); }
                    inputsGone(a.ins, 0, function (gone) {
                        outCreated(a, function (created) { changed = A.observe(a, tip, gone, created, Date.now()) || changed; step(); });
                    });
                })();
            });
        });
    }

    function all() { return A.merge(rows, fills); }
    /** One trade as a calm item: headline (side, amount @ price, chip, when · route · MxUSD), steps, proof (each id once). */
    function card(a, cb, now) {
        var buy = a.side === 'buy', maker = a.role === 'maker', live = !A.settled(a, cb), tone = A.failedTerminal(a) ? 'bad' : A.confirmed(a, cb) ? 'ok' : 'live', money = '', proof = [], i;
        if (a.mxusd) money = (A.confirmed(a,cb) ? (buy ? 'paid ' : 'received ') : (buy ? 'quoted cost ' : 'quoted proceeds ')) + a.mxusd + ' MxUSD';
        else if (a.proceeds) money = 'proceeds ' + a.proceeds + ' ' + (a.payTok === '0x00' ? 'MINIMA' : 'MxUSD');
        var h = { live: live, tone: tone, icon: live ? '●' : tone === 'bad' ? '!' : buy ? '↑' : '↓', title: (buy ? 'Bought MINIMA' : 'Sold MINIMA') + (maker ? ' · you were the maker' : ''),
            amt: PD.fmt(a.amount) + ' MINIMA @ ' + PD.fmtPrice(a.price), chip: A.chip(a, cb), chipTone: tone,
            sub: [C.when(a.ts), a.route, maker ? 'maker' : 'taker', money].filter(Boolean).join(' · ') };
        proof.push(['Transaction (txpow)', a.txpowid]);
        proof.push([maker ? 'Your order' : 'Order', a.orderId]);
        if (a.route === 'FAST') proof.push([maker ? 'Taker ID' : 'Maker', a.counterparty]);
        for (i = 0; a.outs && i < a.outs.length; i++) proof.push(['Coin received ' + (i + 1) + ' of ' + a.outs.length, a.outs[i]]);
        for (i = 0; a.ins && i < a.ins.length; i++) proof.push(['Coin spent ' + (i + 1) + ' of ' + a.ins.length, a.ins[i]]);
        return { key: 'act:' + a.id, ts: Number(a.ts || 0), live: live, html: C.item('act:' + a.id, h, C.actSteps(a, cb, now), proof.filter(function (p) { return !!p[1]; }), '', buy ? 'buy' : 'sell') };
    }
    /** Keyed in-place paint: unchanged items keep their DOM (folds, text selection); only changed ones are rewritten. */
    var painted = {};
    function paint(box, parts) {
        var cur = box.children, same = cur.length === parts.length, i;
        for (i = 0; same && i < parts.length; i++) same = cur[i].getAttribute('data-key') === parts[i].key;
        if (!same) {
            painted = {};
            box.innerHTML = parts.map(function (p) { painted[p.key] = p.html; return '<div data-key="' + esc(p.key) + '">' + p.html + '</div>'; }).join('');
            return;
        }
        for (i = 0; i < parts.length; i++) if (painted[parts[i].key] !== parts[i].html) { cur[i].innerHTML = parts[i].html; painted[parts[i].key] = parts[i].html; }
    }
    var HELP = 'Trades and swaps roll in here step by step while they happen; when one finishes it folds to a single line — tap it for every step and the full on-chain proof. '
        + 'Confirmed / done after ' + A.CONFIRM_BLOCKS + ' blocks. The txpowid is the pre-mining id; inclusion is proven by an output coin. Ids are always shown in full — tap one to copy it.';
    function render() {
        var box = $('activityPage'), live = $('activityLive'), st = PD.state() || {}, cb = chainTip(), now = Date.now(), list = all(), parts = [], items, nowItems, done, followed;
        if (box) {
            // Door swaps (AtomiX, both markets) join the timeline with the same row component (ui/doors.js swapItem).
            items = list.map(function (a) { return card(a, cb, now); });
            if (window.DexiconDoors && DexiconDoors.activityCards) items = items.concat(DexiconDoors.activityCards());
            items.sort(function (x, y) { return y.ts - x.ts; });
            nowItems = items.filter(function (x) { return x.live; }); done = items.filter(function (x) { return !x.live; });
            parts.push({ key: 'hdr', html: C.header('activity', 'ACTIVITY', HELP) });
            if (st.busy && st.stage) nowItems.unshift({ key: 'busy', html: C.item('busy', { live: true, tone: 'live', icon: '●', title: 'BOOK/POOL', amt: 'in progress', chip: 'BUILDING', chipTone: 'live' }, [C.step('wait', '', st.stage)], [], '') });
            if (nowItems.length) parts.push({ key: 'now', html: '<div class="calm-day">Now</div>' });
            parts = parts.concat(nowItems);
            if (done.length) parts.push({ key: 'earlier', html: '<div class="calm-day">Finished</div>' });
            parts = parts.concat(done);
            if (!nowItems.length && !done.length) parts.push({ key: 'empty', html: '<div class="empty-card"><strong>Nothing yet</strong><span>Every BUY/SELL you make, every fill your node co-signs and every AtomiX swap shows its live progress here.</span></div>' });
            paint(box, parts);
        }
        if (!live) return;
        followed = liveId && A.find(rows, function (x) { return x.id === liveId; });
        if (followed && A.settled(followed, cb)) { followed.settledMs = followed.settledMs || now; if (now - followed.settledMs > 120000) { liveId = null; followed = null; } }
        if (st.busy && st.stage && !followed) { live.hidden = false; live.textContent = 'BOOK/POOL · ' + st.stage + '   ▸ ACTIVITY'; return; }
        live.hidden = !followed;
        if (followed) live.textContent = (followed.side === 'buy' ? 'BUY ' : 'SELL ') + followed.amount + ' MINIMA · ' + followed.route + ' · ' + A.status(followed, cb, now) + '   ▸ ACTIVITY';
    }
    function onBlock() { track(); }
    function boot() { load(function () { track(); }); }
    setInterval(function () { if (loaded) { track(); } }, 10000);
    setInterval(function () { var v = $('activityView'); if (liveId || (v && v.className.indexOf('active') >= 0)) render(); }, 1000);

    /** The recorded activity row for a txpowid (TRADES › MY TRADES joins it for coins received / spent). */
    function byTxpow(t) { t = String(t || '').toLowerCase(); return t ? A.find(all(), function (x) { return String(x.txpowid || '').toLowerCase() === t; }) : null; }
    function statusOf(id) { var r = A.find(rows, function (x) { return x.id === id; }); return r ? A.status(r, chainTip(), Date.now()) : null; }
    window.DexiconActivity = { statusOf: statusOf, boot: boot, record: record, update: update, setFills: setFills, onBlock: onBlock, render: render, track: track, byTxpow: byTxpow };
})();
