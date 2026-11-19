/**
 * calm — the shared pieces of the calm ledger UI (AX.calm), mirroring the Android dexicon `ui/` package:
 *   pure derivations (unit-tested): activity row → steps, AtomiX swap → steps / proof / headline, ledger lines,
 *   publicId split; and HTML-string builders: fold (<details>, open state per key in localStorage), ledger row,
 *   evidence line (label + FULL wrapped id, tap copies the complete value from data-v), steps (✓ / … / ! with a
 *   time column — blank when unknown, never invented), ⓘ info toggle.
 * Identifiers are never shortened here (RULE 1). Amount strings are passed through exactly as given.
 * Page-only (not loaded by service.js). Requires AX.activity and AX.door at call time.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var C = {}, MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var HEX64 = /^0x[0-9a-fA-F]{64}$/;

    function n(v) { var x = Number(v || 0); return isFinite(x) ? x : 0; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function p2(x) { return (x < 10 ? '0' : '') + x; }
    function L(t) { return AX.door.label(t); }
    C.esc = esc;

    // ---------- time ----------
    C.hhmm = function (ms) { ms = n(ms); if (!ms) return ''; var d = new Date(ms); return p2(d.getHours()) + ':' + p2(d.getMinutes()); };
    C.when = function (ms) { ms = n(ms); if (!ms) return ''; var d = new Date(ms); return p2(d.getDate()) + ' ' + MO[d.getMonth()] + ' ' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };
    C.dayLabel = function (ms, now) {
        var d = new Date(n(ms)), t = new Date(n(now)), y = new Date(n(now) - 86400000), same = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
        var base = p2(d.getDate()) + ' ' + MO[d.getMonth()] + (d.getFullYear() !== t.getFullYear() ? ' ' + d.getFullYear() : '');
        return same(d, t) ? 'Today · ' + base : same(d, y) ? 'Yesterday · ' + base : base;
    };

    function step(tone, t, x) { return { m: tone === 'ok' ? '✓' : tone === 'wait' ? '…' : '!', tone: tone, t: t || '', x: x }; }
    C.step = step;

    // ---------- ACTIVITY row (lib/activity.js stage machine) → steps ----------
    /** Stages as plain-English lines. Times only where the row recorded them (ts, sentMs, cosignMs); block times are unknown → blank. */
    C.actSteps = function (a, cb, now) {
        var A = AX.activity, out = [], fast = a.route === 'FAST', s = a.stage, b = n(a.block), d = A.depth(a, cb), failed = A.failedTerminal(a), relays = n(a.relays);
        if (fast && a.role === 'maker') {
            out.push(step('ok', C.hhmm(a.ts), 'A taker took your order'));
            if (n(a.cosignMs)) out.push(step('ok', C.hhmm(n(a.ts) + n(a.cosignMs)), 'Your node co-signed in ' + A.secs(a.cosignMs)));
        } else if (fast) {
            if (s === A.BUILDING) out.push(step('wait', C.hhmm(a.ts), a.reason || 'Building and signing…'));
            else if (n(a.sentMs) || a.txpowid) {
                out.push(step('ok', C.hhmm(a.ts), 'Built and signed on this node'));
                if (n(a.sentMs)) out.push(s === A.SENT
                    ? step('wait', C.hhmm(a.sentMs), 'Take sent to ' + relays + ' relay' + (relays === 1 ? '' : 's') + ' · waiting for the maker to co-sign (' + Math.max(0, Math.floor((n(now) - n(a.sentMs)) / 1000)) + 's)')
                    : step('ok', C.hhmm(a.sentMs), 'Take sent to ' + relays + ' relay' + (relays === 1 ? '' : 's')));
                if (a.txpowid && s !== A.REFUSED) out.push(step('ok', n(a.sentMs) && n(a.cosignMs) ? C.hhmm(n(a.sentMs) + n(a.cosignMs)) : '', 'Maker co-signed in ' + A.secs(a.cosignMs)));
            }
        } else out.push(step('ok', C.hhmm(a.ts), 'Posted to the network' + (n(a.postBlock) ? ' at block ' + n(a.postBlock) : '')));
        if (failed) { out.push(step('bad', '', A.status(a, cb, now))); return out; }
        if (!a.txpowid) return out;
        if (b > 0) {
            out.push(step('ok', '', 'In block ' + b));
            out.push(d >= A.CONFIRM_BLOCKS ? step('ok', '', (fast ? 'Done' : 'Confirmed') + ' — ' + A.confirmationText(d)) : step('wait', '', A.confirmationText(d) + ' of ' + A.CONFIRM_BLOCKS));
        } else {
            var post = n(a.postBlock), t = A.tip(a, cb), gone = post > 0 && t > post ? t - post : 0;
            out.push(step('wait', '', "In the node's mempool, waiting for a block" + (gone > 0 ? ' (' + gone + (gone === 1 ? ' block' : ' blocks') + ' since posting)' : '')));
        }
        return out;
    };

    // ---------- AtomiX swap (doors/swapdb rows + events + Dexicon forward record) ----------
    var TERMINAL = { COMPLETE: 1, REFUNDED: 1, ERROR: 1 };
    function isEthEv(e) { return String(e.token == null ? '' : e.token).slice(0, 3).toUpperCase() === 'ETH'; }
    /** Still needs watching: not finished, or finished with a forward still pending / failed (RETRY FORWARD). */
    C.swapLive = function (s, f) { return !TERMINAL[s.status] || (s.status === 'COMPLETE' && !!f && (f.status === 'pending' || f.status === 'failed')); };
    C.swapChip = function (s, f) { return s.status === 'COMPLETE' ? (f && f.status === 'pending' ? 'FORWARDING' : f && f.status === 'failed' ? 'FORWARD FAILED' : 'DONE') : String(s.status || ''); };
    C.swapHead = function (s, f) {
        var live = C.swapLive(s, f), st = s.status, bad = st === 'ERROR' || (f && f.status === 'failed');
        return { live: live, tone: bad ? 'bad' : live ? 'live' : st === 'REFUNDED' ? 'void' : 'ok', icon: live ? '●' : st === 'COMPLETE' ? '✓' : st === 'REFUNDED' ? '↺' : '!',
            title: s.direction === 'ERC20_TO_MINIMA' ? 'AtomiX entry' : 'AtomiX exit', amt: s.sellAmount + ' ' + L(s.sellToken) + ' → ' + s.buyAmount + ' ' + L(s.buyToken),
            chip: C.swapChip(s, f), chipTone: bad ? 'bad' : live ? 'live' : st === 'REFUNDED' ? 'void' : 'ok',
            usd: L(s.buyToken) === 'MxUSD' || L(s.sellToken) === 'MxUSD' };
    };
    function evStep(e, s) {
        var note = String(e.note == null ? '' : e.note), eth = isEthEv(e), t = C.hhmm(e.date), sell = L(s.sellToken), buy = L(s.buyToken);
        switch (e.event) {
            case 'HTLC_STARTED': return step('ok', t, 'Your ' + s.sellAmount + ' ' + sell + ' is locked on ' + (eth ? 'Ethereum' : 'Minima'));
            case 'CPTXN_SENT': return step('ok', t, 'The maker has been told');
            case 'CPTXN_MISMATCH': return step('bad', t, "The maker's lock didn't match" + (note ? ' — ' + note : ''));
            case 'MINIMA_CLAIM_SUBMITTED': return step('ok', t, 'Claim sent on Minima');
            case 'MINIMA_CLAIM_FAILED': return step('bad', t, 'Claim refused by the node' + (note ? ' — ' + note : ''));
            case 'MINIMA_REFUND_SUBMITTED': return step('ok', t, 'Refund sent on Minima');
            case 'MINIMA_REFUND_FAILED': return step('bad', t, 'Refund refused by the node' + (note ? ' — ' + note : ''));
            case 'CPTXN_COLLECT': return step('ok', t, 'Claimed ' + s.buyAmount + ' ' + buy + (eth ? ' on Ethereum' : ' on Minima'));
            case 'CPTXN_EXPIRED': return step('ok', t, 'Refund confirmed' + (eth ? ' on Ethereum' : ' on Minima'));
            case 'SWAP_LOST': return step('bad', t, note && !HEX64.test(note) ? note : 'The counterparty took the leg you paid');
            default: return step('ok', t, String(e.event || '') + (note && !HEX64.test(note) ? ' — ' + note : ''));
        }
    }
    /** When a refund becomes possible: Minima leg → block height; ETH leg → unix seconds (doors/trading.js). '' when unknown. */
    C.refundNote = function (s) {
        var tl = n(s.myTimelock); if (!(tl > 0)) return '';
        var what = 'your ' + s.sellAmount + ' ' + L(s.sellToken);
        return s.myLegIsMinima ? 'If the maker doesn’t complete, ' + what + ' can be refunded after block ' + tl + ' — the service does it automatically.'
            : 'If the maker doesn’t complete, ' + what + ' can be refunded from ' + C.when(tl * 1000) + ' — the service does it automatically.';
    };
    C.swapSteps = function (s, events, f) {
        var evs = (events || []).slice().sort(function (x, y) { return n(x.date) - n(y.date); }), out = [], i, st = s.status, buy = L(s.buyToken), seenLock = false;
        var makerLocked = st === 'LOCKED' || st === 'CLAIMING' || st === 'COMPLETE';
        for (i = 0; i < evs.length; i++) {
            var e = evs[i];
            if (makerLocked && !seenLock && (e.event === 'MINIMA_CLAIM_SUBMITTED' || e.event === 'MINIMA_CLAIM_FAILED' || e.event === 'CPTXN_COLLECT')) { out.push(step('ok', '', 'The maker locked ' + s.buyAmount + ' ' + buy)); seenLock = true; }
            out.push(evStep(e, s));
        }
        if (makerLocked && !seenLock) out.push(step('ok', '', 'The maker locked ' + s.buyAmount + ' ' + buy));
        if (st === 'STARTED') out.push(step('wait', '', 'Waiting for the maker to lock your ' + buy));
        else if (st === 'LOCKED' || st === 'CLAIMING') out.push(step('wait', '', 'Claiming your ' + s.buyAmount + ' ' + buy + ' now'));
        else if (st === 'COMPLETE') {
            if (!f) out.push(step('ok', '', AX.door.statusText(s, null)));
            else if (f.status === 'sent') out.push(step('ok', '', 'Done — forwarded ' + f.amount + ' ' + buy + ' to the address in Proof'));
            else if (f.status === 'failed') out.push(step('bad', '', 'Swap done, forward FAILED: ' + (f.err || 'unknown') + ' — tap RETRY FORWARD'));
            else if (f.status === 'void') out.push(step('ok', '', AX.door.statusText(s, null)));
            else out.push(step('wait', '', 'Done — forwarding ' + buy + ' to the address in Proof' + (f.err ? ' (retrying: ' + f.err + ')' : '…')));
        } else if (st === 'REFUNDED') out.push(step('ok', '', AX.door.statusText(s, f)));
        else if (st === 'ERROR') out.push(step('bad', '', AX.door.statusText(s, f)));
        return out;
    };
    var EV_PROOF = { HTLC_STARTED: 'Your lock', MINIMA_CLAIM_SUBMITTED: 'Your claim', MINIMA_REFUND_SUBMITTED: 'Your refund', CPTXN_COLLECT: 'Claim', CPTXN_EXPIRED: 'Refund', SWAP_LOST: 'Lost' };
    /** Every id of a swap, each ONCE: [label, fullId]. Covers every id AX.door.txIds finds (same 0x+64-hex rule). */
    C.swapProof = function (s, events, f) {
        var out = [], seen = {}, i, e, note;
        function add(k, v) { v = String(v == null ? '' : v); if (!v || seen[v.toLowerCase()]) return; seen[v.toLowerCase()] = 1; out.push([k, v]); }
        add('Swap', s.hash);
        for (i = 0; i < (events || []).length; i++) {
            e = events[i] || {}; note = String(e.note == null ? '' : e.note);
            if (HEX64.test(note)) add((EV_PROOF[e.event] || e.event) + (isEthEv(e) ? ' (Ethereum tx)' : ' (Minima txpow)'), note);
        }
        if (s.contractId) add('Ethereum contract', s.contractId);
        add('Maker key', s.counterparty);
        if (f) { add('Forwarded to', f.to); add('Forward tx', f.tx); }
        return out;
    };

    // ---------- ledger lines (TRADES › MY TRADES) ----------
    /** One trade row (state.myTrades, FAST rows carry `fill`). o = { fmt, fmtPrice, value (MxUSD paid/got, exact string), act (activity row or null) }. */
    C.ledgerTrade = function (r, o) {
        var f = r.fill || null, act = o.act || null, buy = !!r.buy, maker = !!r.maker, ms = n(r.timems), facts = [], proof = [], groups = [], recv, spent;
        var fastPending = !!(r.fast && (!f || f.status !== 'done'));
        var route = r.fast ? 'Fast book' : (String(r.source_kind || 'BOOK').charAt(0) + String(r.source_kind || 'BOOK').slice(1).toLowerCase());
        facts.push([buy ? 'You paid' : 'You got', o.value + ' MxUSD']);
        facts.push(['When', C.when(ms)]);
        facts.push(['Route', (r.source_kind || route) + ' · ' + (maker ? 'maker' : 'taker')]);
        facts.push(['Status', (r.verification_status || '') + (r.verification_note ? ' — ' + r.verification_note : '')]);
        if (n(r.block)) facts.push(['Settled', 'block ' + n(r.block)]);
        if (f && n(f.cosignMs)) facts.push(['Co-signed', 'in ' + AX.activity.secs(f.cosignMs)]);
        if (r.txpowid) proof.push(['Transaction (txpow)', r.txpowid]);
        recv = (f && f.coins && f.coins.length ? f.coins : (act && act.outs) || []).slice();
        if (r.spentcoin && r.spentcoin !== r.txpowid && recv.indexOf(r.spentcoin) < 0) proof.push([r.fast ? 'Trade coin' : 'Order coin (spent)', r.spentcoin]);
        if (r.orderid) proof.push(['Order', r.orderid]);
        if (f) { if (maker && f.taker) proof.push(['Taker ID', f.taker]); if (!maker && f.maker) proof.push(['Maker address', f.maker]); }
        spent = (act && act.ins) || [];
        if (recv.length) groups.push({ key: 'in', label: 'Coins you received', ids: recv });
        if (spent.length) groups.push({ key: 'out', label: 'Coins you spent', ids: spent });
        return { key: 'ledger:' + (r.txpowid || r.spentcoin || ms), ms: ms, kind: fastPending ? 'void' : buy ? 'buy' : 'sell', icon: buy ? '↑' : '↓', verb: buy ? 'Bought' : 'Sold',
            amt: o.fmt(r.size) + ' MINIMA', l2: '@ ' + o.fmtPrice(r.price) + ' · ' + route + ' · ' + (maker ? 'as maker' : 'as taker') + (fastPending ? ' · ' + (r.verification_status || '') : ''),
            time: C.hhmm(ms), facts: facts, proof: proof, groups: groups };
    };
    /** A FINISHED AtomiX swap as a ledger line: Swapped / Refunded (muted) / Failed. */
    C.ledgerSwap = function (s, f) {
        var st = s.status, ms = n(s.created), sell = L(s.sellToken), buy = L(s.buyToken), kind = s.direction === 'ERC20_TO_MINIMA' ? 'AtomiX entry' : 'AtomiX exit', facts = [['You paid', s.sellAmount + ' ' + sell]];
        if (st === 'COMPLETE') facts.push(['You got', s.buyAmount + ' ' + buy + (buy !== 'USDT' ? ', less the 0.0001 ' + buy + ' notify output' : '')]);
        facts.push(['Started', C.when(ms)]);
        if (n(s.updated)) facts.push(['Last update', C.when(s.updated)]);
        return { key: 'ledger:swap:' + s.hash, ms: ms, kind: st === 'COMPLETE' ? 'swap' : st === 'REFUNDED' ? 'void' : 'bad', icon: st === 'COMPLETE' ? '⇄' : st === 'REFUNDED' ? '↺' : '!',
            verb: st === 'COMPLETE' ? 'Swapped' : st === 'REFUNDED' ? 'Refunded' : 'Failed', amt: st === 'REFUNDED' ? s.sellAmount + ' ' + sell : s.sellAmount + ' ' + sell + ' → ' + s.buyAmount + ' ' + buy,
            l2: kind + ' · ' + (st === 'COMPLETE' ? (f && f.status === 'sent' ? 'forwarded' : 'delivered') : st === 'REFUNDED' ? 'nothing traded, refunded' : 'see what happened'),
            time: C.hhmm(ms), facts: facts };
    };

    /** publicId = "0x" + boxPk(32 bytes) + signPk(32 bytes) (lib/identity.js). Null if it is not that shape. */
    C.splitId = function (pid) {
        var h = String(pid == null ? '' : pid).replace(/^0x/i, '');
        return /^[0-9a-fA-F]{128}$/.test(h) ? { box: '0x' + h.slice(0, 64), sign: '0x' + h.slice(64) } : null;
    };

    // ---------- HTML builders ----------
    var KEY = 'dexicon_fold_';
    C.isOpen = function (key, dflt) { try { var v = g.localStorage.getItem(KEY + key); return v === null || v === undefined ? !!dflt : v === '1'; } catch (e) { return !!dflt; } };
    C.setOpen = function (key, open) { try { g.localStorage.setItem(KEY + key, open ? '1' : '0'); } catch (e) { } };
    /** Copy the COMPLETE value (data-v) — never the displayed text. */
    C.copy = function (v) {
        if (!v) return;
        if (g.DexiconFast && g.DexiconFast.copy) return g.DexiconFast.copy(v);
        try { g.navigator.clipboard.writeText(String(v)); } catch (e) { }
    };
    C.fold = function (key, summaryHtml, bodyHtml, cls, dflt) {
        return '<details class="calm-fold ' + (cls || '') + '" data-fold="' + esc(key) + '"' + (C.isOpen(key, dflt) ? ' open' : '') + '><summary>' + summaryHtml + '<span class="calm-chev"></span></summary>' + bodyHtml + '</details>';
    };
    C.info = function (key, text) { return '<details class="calm-info" data-fold="info:' + esc(key) + '"' + (C.isOpen('info:' + key) ? ' open' : '') + '><summary aria-label="What is this?">ⓘ</summary><p>' + esc(text) + '</p></details>'; };
    C.ev = function (label, v) {
        return v ? '<div class="calm-ev" role="button" tabindex="0" data-v="' + esc(v) + '" onclick="AX.calm.copy(this.getAttribute(\'data-v\'))" onkeydown="if(event.key===\'Enter\')this.click()"><span class="calm-k">' + esc(label) + '</span><span class="calm-v">' + esc(v) + '</span></div>' : '';
    };
    C.proof = function (list) { var h = list.map(function (p) { return C.ev(p[0], p[1]); }).join(''); return h ? '<div class="calm-proof"><span class="calm-lbl">Proof · tap to copy</span>' + h + '</div>' : ''; };
    C.steps = function (list) {
        return list.length ? '<ul class="calm-steps">' + list.map(function (s) { return '<li class="' + s.tone + '"><span class="m">' + s.m + '</span><span class="tm">' + esc(s.t) + '</span><span>' + esc(s.x) + '</span></li>'; }).join('') + '</ul>' : '';
    };
    C.facts = function (list) { return list.length ? '<dl class="calm-facts">' + list.map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl>' : ''; };
    C.head = function (h) {
        return '<span class="calm-row"><span class="calm-ico ' + esc(h.tone) + '">' + esc(h.icon) + '</span><span class="calm-mid"><span class="calm-t1"><span class="calm-what">' + esc(h.title) + '</span>'
            + (h.chip ? '<span class="act-chip ' + esc(h.chipTone) + '">' + esc(h.chip) + '</span>' : '') + '</span><span class="calm-amt">' + esc(h.amt) + '</span>'
            + (h.sub ? '<span class="calm-sub">' + esc(h.sub) + '</span>' : '') + '</span></span>';
    };
    /** One ACTIVITY item. Live: headline + steps always, proof one fold away. Finished: one headline row folding 'What happened' + proof. */
    C.item = function (key, h, steps, proofList, extra, cls) {
        cls = 'calm-card ' + (h.live ? 'live ' : '') + (cls || '');
        if (h.live) return '<section class="' + cls + '"><div class="calm-head">' + C.head(h) + '</div><div class="calm-body">' + C.steps(steps) + (extra || '')
            + (proofList.length ? C.fold('proof:' + key, '<span class="calm-lbl">Proof · tap to copy</span>', '<div class="calm-proof">' + proofList.map(function (p) { return C.ev(p[0], p[1]); }).join('') + '</div>', 'calm-subfold') : '') + '</div></section>';
        return '<section class="' + cls + '">' + C.fold(key, C.head(h), '<div class="calm-body"><span class="calm-lbl">What happened</span>' + C.steps(steps) + (extra || '') + C.proof(proofList) + '</div>') + '</section>';
    };
    /** One ledger line: icon · verb amount / l2 · time, folding facts + optional steps + proof + coin groups. */
    C.ledgerItem = function (x, steps, extra) {
        var sum = '<span class="calm-row"><span class="calm-ico ' + x.kind + '">' + esc(x.icon) + '</span><span class="calm-mid"><span class="calm-l1"><span class="calm-verb">' + esc(x.verb) + '</span> <span class="calm-amt">' + esc(x.amt) + '</span></span><span class="calm-sub">' + esc(x.l2) + '</span></span><span class="calm-tm">' + esc(x.time) + '</span></span>';
        var body = C.facts(x.facts) + C.steps(steps || []) + (extra || '') + C.proof(x.proof || [])
            + (x.groups || []).map(function (gr) { return C.fold(x.key + ':' + gr.key, '<span class="calm-k">' + esc(gr.label) + ' (' + gr.ids.length + ')</span>', gr.ids.map(function (id, i) { return C.ev((gr.key === 'in' ? 'Received ' : 'Spent ') + (i + 1) + ' of ' + gr.ids.length, id); }).join(''), 'calm-subfold'); }).join('');
        return '<div class="calm-item ' + x.kind + '">' + C.fold(x.key, sum, '<div class="calm-body">' + body + '</div>') + '</div>';
    };
    /** Section header with an ⓘ that folds a short explanation. */
    C.header = function (key, title, text, right) { return '<div class="calm-h"><h2>' + esc(title) + '</h2>' + (right || '') + C.info(key, text) + '</div>'; };

    // Remember a fold's state on the click itself (synchronous), so a 1 s re-render can never close it again.
    if (g.document && g.document.addEventListener) g.document.addEventListener('click', function (e) {
        var s = e.target && e.target.closest ? e.target.closest('summary') : null, d = s && s.parentNode;
        if (d && d.getAttribute && d.getAttribute('data-fold') && !(e.target.closest('.calm-ev'))) C.setOpen(d.getAttribute('data-fold'), !d.open);
    }, true);
    // Static folds in index.html (ATOMIX 'How this works', ⓘ) get their remembered state once at load.
    if (g.document && g.document.querySelectorAll) { var st = g.document.querySelectorAll('details[data-fold]'), i; for (i = 0; i < st.length; i++) st[i].open = C.isOpen(st[i].getAttribute('data-fold')); }

    AX.calm = C;
})(typeof globalThis !== 'undefined' ? globalThis : this);
