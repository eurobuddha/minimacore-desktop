/**
 * ui/maker.js — ORDERS › MARKET MAKER (window.DexiconMaker), mirror of Dexicon Android 0.1.21 MarketMaker.java: AtomiX's
 * market editor for the FAST book — enable, peg to MEXC (skew, reprice threshold), auto-fill (mid · step % · levels ·
 * ask/bid size), rungs A6..A1 / B1..B6, and a preview of what the ladder commits against what you hold. service.js keeps
 * the ladder live (lib/ladder.js); the page only edits kv 'mm_config' and reads 'mm_status' / 'mm_feed'.
 */
(function () {
    /** Wake the service so the ladder reconciles NOW (owner 2026-10-26: cancel-to-repost was ~18 s of waiting). */
    function wake() { try { MDS.comms.solo(JSON.stringify({ origin: 'dexicon', type: 'LADDER', data: {} }), function () { }); } catch (e) { } }
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var L = AX.ladder, N = L.MAX_LEVELS, feed = { mid: 0, line: 'MEXC: waiting for the service' }, timer = null, filling = false;
    function esc(s) { return PD.esc(s); }

    function render() {
        var box = $('mmCard');
        if (!box) return;
        AX.mds.kvGet('mm_config', '', function (cs) { AX.mds.kvGet('mm_status', '', function (st) { AX.mds.kvGet('mm_feed', '{}', function (fs) { AX.mds.kvGet('mm_pool', '', function (pool) { AX.mds.kvGet('mm_review', '', function (needsReview) {
            var c = L.fromJson(cs), mode = !c.enabled ? 'OFF' : c.peg ? 'PEGGED · MEXC' : 'MANUAL';
            try { feed = JSON.parse(fs || '{}'); } catch (e) { }
            box.innerHTML = '<div class="summary-card mm-card"><div class="mm-top"><label>MARKET MAKER</label><span class="mm-pill' + (c.enabled ? ' on' : '') + '">' + mode + '</span></div>'
                + (c.enabled && c.peg && feed.line ? '<span class="mm-feed">' + esc(feed.line) + '</span>' : '')
                + '<span class="mm-status">' + esc(st || (c.enabled ? 'starting — the service picks it up within seconds' : 'A ladder of FAST asks and bids, pegged to MEXC or set by hand. Your node keeps it live and co-signs every fill.')) + '</span>'
                + (c.enabled && pool ? '<span class="mm-feed">PandaPools: ' + esc(pool) + '</span>' : '')
                + '<div class="maker-actions"><button class="cta" onclick="DexiconMaker.open()">' + (c.enabled ? 'EDIT LADDER' : 'SET UP') + ' <span>→</span></button>'
                + (c.enabled ? '<button class="secondary mm-stop" onclick="DexiconMaker.stop()">STOP</button>' : '')
                + (needsReview === '1' ? '<button class="secondary" onclick="DexiconMaker.review()">REVIEW</button>' : '') + '</div></div>';
        }); }); }); }); });
    }

    function buildRows() {
        var a = $('mmAsks'), b = $('mmBids'), i, h = [];
        if (a.childElementCount) return;
        for (i = N; i >= 1; i--) h.push(rowHtml('A', i));   // A6 on top, A1 by the spread
        a.innerHTML = h.join(''); h = [];
        for (i = 1; i <= N; i++) h.push(rowHtml('B', i));
        b.innerHTML = h.join('');
    }
    function rowHtml(s, i) {
        return '<div class="mm-row"><b class="' + (s === 'A' ? 'ask' : 'bid') + '">' + s + i + '</b><input id="mm' + s + i + 'p" inputmode="decimal" placeholder="price" oninput="DexiconMaker.preview()">'
            + '<input id="mm' + s + i + 'a" inputmode="decimal" placeholder="MINIMA" oninput="DexiconMaker.preview()"></div>';
    }
    var FIELDS = { skew: 'mmSkew', reprice: 'mmReprice', mid: 'mmMid', step: 'mmStep', levels: 'mmLevels', askSize: 'mmAsk', bidSize: 'mmBid' };
    function read() {
        var c = L.blankConfig(), k, i;
        c.enabled = $('mmEnabled').checked; c.peg = $('mmPeg').checked; c.autoCross = $('mmCross').checked; c.crossPerHour = $('mmCrossHour').value.trim() || '3';
        for (k in FIELDS) c[k] = $(FIELDS[k]).value.trim();
        for (i = 0; i < N; i++) { c.asks[i] = [$('mmA' + (i + 1) + 'p').value.trim(), $('mmA' + (i + 1) + 'a').value.trim()]; c.bids[i] = [$('mmB' + (i + 1) + 'p').value.trim(), $('mmB' + (i + 1) + 'a').value.trim()]; }
        return c;
    }
    function write(c) {
        var k, i;
        $('mmEnabled').checked = !!c.enabled; $('mmPeg').checked = !!c.peg; $('mmCross').checked = !!c.autoCross; $('mmCrossHour').value = c.crossPerHour || '3';
        for (k in FIELDS) $(FIELDS[k]).value = c[k] || '';
        for (i = 0; i < N; i++) { $('mmA' + (i + 1) + 'p').value = c.asks[i][0]; $('mmA' + (i + 1) + 'a').value = c.asks[i][1]; $('mmB' + (i + 1) + 'p').value = c.bids[i][0]; $('mmB' + (i + 1) + 'a').value = c.bids[i][1]; }
    }

    /** AtomiX behaviour: rungs regenerate from mid · step · levels · sizes as you type (manual) or from the live MEXC mid
     *  (pegged); a rung edited by hand stays until those inputs change again. */
    function fill() {
        if (filling) return;
        var c = read(), m, sk, st = L.parse(c.step), a = L.parse(c.askSize), b = L.parse(c.bidSize), rs, i;
        if (c.peg) {
            if (!(feed.mid > 0)) return preview();
            sk = L.parse(c.skew, true) || AX.fill.d(0);
            if (sk.lt(-20)) sk = AX.fill.d(-20); if (sk.gt(20)) sk = AX.fill.d(20);
            m = AX.fill.d(String(feed.mid)).times(AX.fill.d(1).plus(sk.div(100)));
        } else m = L.parse(c.mid);
        if (!m || !st || !a || !b || m.lte(0) || st.lte(0) || (a.lte(0) && b.lte(0))) return preview();
        filling = true;
        if (c.peg) $('mmMid').value = m.toDecimalPlaces(8).toFixed();
        for (i = 1; i <= N; i++) ['A', 'B'].forEach(function (s) { $('mm' + s + i + 'p').value = ''; $('mm' + s + i + 'a').value = ''; });
        rs = L.generate(m, st, L.levelCount(c), a, b);
        rs.forEach(function (r) { $('mm' + r.key + 'p').value = AX.fill.plain(r.price); $('mm' + r.key + 'a').value = AX.fill.plain(r.amount); });
        filling = false;
        preview();
    }
    function preview() {
        if (filling) return;
        var c = read(), err = L.validate(c), on = JSON.parse(JSON.stringify(c)), rs, k, m = PD.bal('minima'), u = PD.bal('usdt'), short, t;
        on.enabled = true;
        rs = c.peg ? L.desired(on, feed.mid, 1) : L.desired(on, 0, 1);
        k = L.commits(rs);
        short = m && u && (k.minima.gt(m.sendable) || k.mxusd.gt(u.sendable));
        t = rs.length + (rs.length === 1 ? ' rung' : ' rungs') + ' · asks commit ' + AX.fill.plain(k.minima) + ' MINIMA · bids commit ' + AX.fill.plain(k.mxusd) + ' MxUSD';
        if (m && u) t += '\nyou hold ' + PD.fmtBal(m.sendable) + ' MINIMA · ' + PD.fmtBal(u.sendable) + ' MxUSD';
        if (short) t += '\n⚠ the ladder commits more than you hold — rungs that cannot be backed stay off';
        if (rs.length > 1) t += '\none coin per rung: if your wallet is one big coin, the maker splits it once (one block)';
        if (err) t += '\n✗ ' + err;
        $('mmPreview').textContent = t;
        $('mmPreview').className = 'door-quote' + (err ? ' bad' : '');
        $('mmFeed').textContent = feed.line || '';
        $('mmMid').disabled = c.peg;
    }
    function open() {
        buildRows();
        AX.mds.kvGet('mm_config', '', function (cs) {
            write(L.fromJson(cs));
            $('mmDialog').showModal();
            pollFeed(); preview();
            timer = setInterval(pollFeed, 2000);
        });
    }
    function pollFeed() {
        AX.mds.kvGet('mm_feed', '{}', function (fs) {
            var was = feed.mid;
            try { feed = JSON.parse(fs || '{}'); } catch (e) { }
            if ($('mmPeg').checked && feed.mid !== was) fill(); else preview();
        });
    }
    function close() { if (timer) clearInterval(timer); timer = null; $('mmDialog').close(); }
    function save() {
        var c = read(), err = L.validate(c);
        if (err) { preview(); return PD.notice(err, 'error'); }
        if (!c.autoCross) AX.mds.kvSet('mm_cross_ack', '', function () { });   // saved off: whoever turns it on next sees the warning again
        AX.mds.kvSet('mm_config', JSON.stringify(c), function () { AX.mds.kvSet('mm_dirty', '1', function () { wake();
            close(); render();
            PD.notice(c.enabled ? 'Saved — the maker service puts the ladder live within seconds' : 'Saved — market maker off', 'posted');
        }); });
    }
    function stop() {
        if (!confirm('Stop the market maker? Every ladder order is cancelled on the relays within seconds. Your settings are kept.')) return;
        AX.mds.kvGet('mm_config', '', function (cs) {
            var c = L.fromJson(cs); c.enabled = false;
            AX.mds.kvSet('mm_config', JSON.stringify(c), function () { AX.mds.kvSet('mm_dirty', '1', function () { wake(); render(); PD.notice('Stopping — ladder orders are being cancelled', 'posted'); }); });
        });
    }
    /** Ticking auto-cross asks first: what it does and what would cross right now (owner 29 Oct). */
    var crossYes = false;
    function cross() {
        if (!$('mmCross').checked) return;
        AX.mds.kvGet('mm_cross_ack', '', function (ack) {
            if (ack === '1') return;   // the owner ticked "Don't show again"
            AX.mds.kvGet('mm_pool', '', function (pool) {
                var d = $('axWarn');
                $('axWarnBody').textContent = AX.autocross.warning(pool, $('mmCrossHour').value);
                $('axWarnAgain').checked = false; crossYes = false;
                d.onclose = function () { if (!crossYes) $('mmCross').checked = false; };   // KEEP OFF, Esc → stays off
                d.showModal();
            });
        });
    }
    function crossAnswer(yes) {
        crossYes = yes;
        if (yes && $('axWarnAgain').checked) AX.mds.kvSet('mm_cross_ack', '1', function () { });
        $('axWarn').close();
    }
    /** Rung label for an order in OPEN (orderId → 'A1'…), read from kv 'mm_ids'. */
    var rungOf = {};
    function loadIds(cb) { AX.mds.kvGet('mm_ids', '{}', function (v) { var ids = {}, k; try { ids = JSON.parse(v || '{}'); } catch (e) { } rungOf = {}; for (k in ids) rungOf[ids[k]] = k; if (cb) cb(); }); }

    /* ---- REVIEW a stuck cross / PandaDEX fill: the service checks every coin on the node; the owner decides. */
    function ask(data, cb) {
        var nonce = Date.now().toString(36) + '.' + Math.floor(Math.random() * 1e9).toString(36), tries = 0;
        data.nonce = nonce;
        try { MDS.comms.solo(JSON.stringify({ origin: 'dexicon', type: 'CROSS_REVIEW', data: data }), function () { }); } catch (e) { return cb(null); }
        (function poll() {
            AX.mds.kvGet('mm_review_result', '', function (v) {
                var o = null; try { o = JSON.parse(v || 'null'); } catch (e) { }
                if (o && o.nonce === nonce) return cb(o);
                if (++tries > 60) return cb(null);
                setTimeout(poll, 500);
            });
        })();
    }
    var WORD = { unspent: 'unspent, not pending', mempool: 'in the mempool', spent: 'spent', unknown: 'no answer' };
    function partHtml(which, title, p) {
        if (!p) return '';
        var h = '<p><b>' + esc(title) + '</b></p><p>' + esc(p.verdict.text) + '</p>';
        if (p.txpowid) h += '<p>Transaction:</p><pre class="door-quote">' + esc(p.txpowid) + '</pre>';
        if (p.coins.length) h += '<p>Its coins:</p><pre class="door-quote">' + p.coins.map(function (c) { return esc(c.coinid) + '\n  ' + esc(WORD[c.state] || c.state); }).join('\n') + '</pre>';
        return h;
    }
    function review() {
        var d = $('mmReview'), body = $('mmReviewBody'), acts = $('mmReviewActs');
        body.textContent = 'Checking every coin with your node…'; acts.innerHTML = '<button class="secondary" type="button" onclick="document.getElementById(\'mmReview\').close()">CLOSE</button>';
        if (!d.open) d.showModal();
        ask({}, function (o) {
            if (!o || o.error) { body.textContent = o && o.error ? o.error : 'No answer from the Dexicon service. Try again.'; return; }
            var st = o.review || {};
            if (!st.cross && !st.fill) { body.textContent = 'Nothing is waiting any more. It settled by itself.'; render(); return; }
            body.innerHTML = partHtml('cross', 'Auto-cross into PandaPools', st.cross) + partHtml('fill', 'PandaDEX trade', st.fill);
            ['cross', 'fill'].forEach(function (w) {
                if (st[w] && st[w].verdict.safe) acts.innerHTML += '<button class="cta" type="button" onclick="DexiconMaker.release(\'' + w + '\')">RELEASE ' + (w === 'cross' ? 'AUTO-CROSS' : 'TRADE') + ' <span>→</span></button>';
            });
        });
    }
    function release(which) {
        var body = $('mmReviewBody');
        body.textContent = 'Checking again, then releasing…';
        ask({ release: which }, function (o) {
            if (!o) { body.textContent = 'No answer from the Dexicon service. Nothing changed.'; return; }
            body.textContent = o.error ? 'Not released: ' + o.error : 'Released. Auto-cross carries on from the next pass.';
            $('mmReviewActs').innerHTML = '<button class="secondary" type="button" onclick="document.getElementById(\'mmReview\').close()">CLOSE</button>';
            render();
        });
    }
    window.DexiconMaker = { review: review, release: release, render: render, open: open, close: close, save: save, stop: stop, cross: cross, crossAnswer: crossAnswer, fill: fill, preview: preview, loadIds: loadIds, rung: function (id) { return rungOf[id] || ''; } };
})();
