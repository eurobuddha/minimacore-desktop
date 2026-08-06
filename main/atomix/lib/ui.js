/**
 * ui — the AtomiX MiniDapp UI (browser), a pixel-parity port of native MainActivity's programmatic UI to HTML/CSS.
 * Renders the shell + all 5 tabs and wires every control to a real handler — there is NO stub helper, and the
 * browser-chain gate asserts none can return (a "coming later" button once shipped to a real node; never again).
 * PARITY.md is the ledger of native↔MDS feature status, including the one deliberate MDS-only extra (wallet Send).
 * Requires AX.trading, AX.order, AX.book, AX.fmt, AX.wallet + the vendored `qrcode` global. Attaches to AX.ui.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var TR = AX.trading, O = AX.order, B = AX.book;

    // ---- tiny DOM builder ----
    function el(tag, attrs, kids) {
        var e = document.createElement(tag);
        if (attrs) for (var k in attrs) {
            if (k === 'class') e.className = attrs[k];
            else if (k === 'text') e.textContent = attrs[k];
            else if (k === 'html') e.innerHTML = attrs[k];
            else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
            else e.setAttribute(k, attrs[k]);
        }
        if (kids) for (var i = 0; i < kids.length; i++) if (kids[i] != null) e.appendChild(typeof kids[i] === 'string' ? document.createTextNode(kids[i]) : kids[i]);
        return e;
    }

    // ---- app state ----
    var S = {
        ctx: null, tab: 'swap', sell: true, amount: '', book: {}, quote: null,
        bals: { minima: '0', usdt: '0', eth: '0' }, swaps: [], oracle: '', status: '', paired: false, modal: null,
        balsMeta: null,    // { confirmed, unconfirmed, sendable, coins, at } — Minima card breakdown (app.js)
        market: { chart: [], recent: [] },   // executed prints + recent trades (service-collected, app.js reads SQL)
        pulse: null,       // one-shot { minima, eth, usdt } — balance-change pulse (consumed by walletTab)
        balsRaw: { ethWei: '0', usdtRaw: '0' },   // RAW balances for send validation (display strings are rounded)
        sendForm: null,    // typing state of the Send form (survives poll re-renders)
        ethErr: null,      // last ETH-RPC balance failure, native MainActivity.ethErr (m:2589) — app.js SETS AND
                           // CLEARS it every refresh, so a transient RPC/DNS blip cannot pin the banner (native 0.1.13)
        bootError: null,   // { permission, locked, message } — set by app.js when AX.boot.init fails
        editing: false, makerCfg: null, makerManual: null, otcBoard: [], otcDeals: [], otcProposing: null, otcCountering: null
    };
    var TABS = [
        { id: 'swap', label: 'Swap', ico: 'M7 7l4-4 4 4M11 3v12M17 17l-4 4-4-4M13 21V9' },
        { id: 'wallet', label: 'Wallet', ico: 'M3 7h15a2 2 0 012 2v7a2 2 0 01-2 2H4a1 1 0 01-1-1V7zM17 12h2' },
        { id: 'activity', label: 'Activity', ico: 'M3 12h4l3 8 4-16 3 8h4' },
        { id: 'market', label: 'Market', ico: 'M5 20V10M12 20V4M19 20v-7' },
        { id: 'otc', label: 'OTC', ico: 'M7 8h13l-3-3M17 16H4l3 3' }
    ];

    function ccy() { return TR.active().coinLabel; }
    function myId() { return S.ctx && S.ctx.identities[TR.active().key].publicId(); }

    // ---- top-level render ----
    function render() {
        document.documentElement.setAttribute('data-ccy', TR.active().key === 'minima' ? 'minima' : 'mxusdt');
        var app = el('div', { id: 'app' }, [
            banner(), el('div', { id: 'scroll' }, [header(), tab()]), tabbar()
        ]);
        var root = document.getElementById('root');
        root.innerHTML = ''; root.appendChild(app);
        // A key mismatch outranks everything: every tab below either commits money or reports balances for a
        // wallet this node cannot derive. Same halt semantics as native 0.1.19.
        if (AX.identitywatch && AX.identitywatch.halted()) root.appendChild(mismatchCard());
        else if (!S.paired && S.bootError) root.appendChild(bootErrorCard());   // boot failed → instructions overlay
        else if (S.modal) root.appendChild(modalEl(S.modal));   // survive poll-driven re-renders while a dialog is open
    }

    /** HALT overlay: this install's keys no longer belong to the node (reseed / restored wallet). Trading is
     *  stopped; in-flight swaps keep settling. Reinstalling the MiniDapp is the clean reset — but it drops the
     *  swap DB (claim secrets), so the rescue lines come first. Mirrors the native blocker. */
    function mismatchCard() {
        var v = AX.identitywatch.verdict(), lines = [];
        lines.push(el('div', { class: 'dlgline', text: AX.identitywatch.summary()
            + ' Trading, publishing and new swaps are stopped. Swaps already in flight keep settling.' }));
        if (v.minimaMismatch)
            lines.push(el('div', { class: 'dlgline mono', style: 'word-break:break-all',
                text: 'Minima key not owned by this node:\n' + v.orphanedPk }));
        if (v.ethMismatch)
            lines.push(el('div', { class: 'dlgline mono', style: 'word-break:break-all',
                text: 'ETH wallet in use:\n' + v.staleEth + '\nthis node now derives:\n' + v.nodeEth }));
        lines.push(el('div', { class: 'dlgline', text: '⚠ Rescue first: open Wallet → Export key / Send to move '
            + 'anything off the old ETH wallet. Reinstalling AtomiX drops this dapp\'s database, including the '
            + 'claim secrets for unsettled swaps, and the stale ETH key is never stored — only your OLD node seed '
            + 'could rebuild it.' }));
        lines.push(el('div', { class: 'dlgline dim', text: 'Then reinstall AtomiX from MiniHub to pick up this '
            + 'node\'s current keys cleanly.' }));
        return el('div', { class: 'modal-ov' }, [
            el('div', { class: 'modal-card' },
                [el('div', { class: 'modal-title', text: '⛔ Wallet mismatch — AtomiX halted' })].concat(lines))
        ]);
    }

    /** Boot-failure overlay. A MiniDapp is a web page talking to the node THROUGH MDS — there is nothing to
     *  "connect"; the real first-run failure on a fresh install is the READ-default permission model. */
    function bootErrorCard() {
        var e = S.bootError, lines = [], title;
        if (e.permission) {
            var uid = (typeof MDS !== 'undefined' && MDS.minidappuid) ? MDS.minidappuid : '<your AtomiX uid>';
            title = 'AtomiX needs Write permission';
            lines = [
                el('div', { class: 'dlgline', text: 'AtomiX derives your swap identity from the node seed and signs swap transactions via MDS — that needs WRITE trust. MiniDapps install with READ by default.' }),
                el('div', { class: 'dlgline', text: 'Grant it either way:' }),
                el('div', { class: 'dlgline dim', text: '1 ·  MiniHub → AtomiX → app settings → set Write.' }),
                el('div', { class: 'dlgline dim', text: '2 ·  In the Terminal MiniDapp run:' }),
                el('div', { class: 'dlgline mono', style: 'user-select:all;word-break:break-all', text: 'mds action:permission uid:' + uid + ' trust:write' }),
                el('div', { class: 'dlgline dim', text: 'AtomiX re-checks automatically — this screen clears on its own once granted.' })
            ];
        } else if (e.locked) {
            title = 'Node is password-locked';
            lines = [
                el('div', { class: 'dlgline', text: 'Your node’s private keys are locked, so AtomiX cannot derive its swap identity.' }),
                el('div', { class: 'dlgline mono', style: 'user-select:all', text: 'vault action:passwordunlock password:<your password>' }),
                el('div', { class: 'dlgline dim', text: 'AtomiX re-checks automatically once unlocked.' })
            ];
        } else {
            title = 'AtomiX couldn’t start';
            lines = [el('div', { class: 'dlgline', text: e.message || 'Unknown error' })];
        }
        var btns = [el('button', { class: 'cta', style: 'margin-top:0;flex:1', text: 'Retry now',
            onclick: function () { if (AX.ui.onRetryBoot) AX.ui.onRetryBoot(); } })];
        return el('div', { class: 'modal-ov' }, [
            el('div', { class: 'modal-card' }, [el('div', { class: 'modal-title', text: title })].concat(lines).concat([el('div', { class: 'modal-btns' }, btns)]))
        ]);
    }

    // ---- modal dialog (review/confirm) — an overlay re-appended on every render so a background poll can't wipe it.
    // A line may carry a prebuilt `node` (QR image, selectable address) instead of `text`. A modal with
    // `form: true` caches its DOM and re-appends the SAME element across poll-driven re-renders — a rebuilt
    // form would wipe what the user is typing (the hard never-re-render-a-live-form rule). ----
    var formModalDom = null;
    function modalEl(opts) {
        if (opts.form && formModalDom) return formModalDom;
        var lines = (opts.lines || []).map(function (l) {
            return l.node ? l.node : el('div', { class: 'dlgline ' + (l.cls || ''), text: l.text });
        });
        var btns = [el('button', { class: 'pill', text: opts.cancelText || 'Cancel', onclick: opts.onCancel || closeDialog })];
        if (opts.onConfirm) btns.push(el('button', { class: 'cta', style: 'margin-top:0;flex:1', text: opts.confirmText || 'Confirm',
            onclick: function () { var f = opts.onConfirm; if (!opts.stayOpen) closeDialog(); f(); } }));
        var built = el('div', { class: 'modal-ov', onclick: function (e) { if (e.target && e.target.className === 'modal-ov' && !opts.form) closeDialog(); } }, [
            el('div', { class: 'modal-card' }, [el('div', { class: 'modal-title', text: opts.title })].concat(lines).concat([el('div', { class: 'modal-btns' }, btns)]))
        ]);
        if (opts.form) formModalDom = built;
        return built;
    }
    function dialog(opts) { S.modal = opts; render(); }
    function closeDialog() { S.modal = null; formModalDom = null; render(); }
    function setStatus(msg) { S.status = msg; render(); }

    function banner() {
        // Shown only while boot is still in flight (no error yet). A MiniDapp is served BY the node over MDS —
        // there is no "connect" step; boot failures get the full instruction card (bootErrorCard) instead.
        var b = el('div', { id: 'pairbanner', text: 'Starting AtomiX…' });
        if (!S.paired && !S.bootError) b.className = 'show';
        return b;
    }

    function header() {
        return el('div', {}, [
            el('div', { class: 'hdr' }, [
                el('div', { class: 'brand', text: 'AtomiX' }),
                el('button', { class: 'pill accent', text: ccy(), onclick: switchCurrency }),
                el('button', { class: 'pill', text: AX.ui.dark ? '☾' : '☀', onclick: toggleTheme }),
                el('button', { class: 'pill', text: '?', onclick: welcomeDialog }),
                el('span', { class: 'pill accent' }, [el('span', { class: 'dot' }), document.createTextNode('Mainnet')])
            ]),
            el('div', { class: 'subline', text: 'v' + AX.ui.version + '  ·  ' + (AX.ui.block ? 'block ' + AX.ui.block + '  ·  ' : '') + 'real funds' })
        ]);
    }

    function tabbar() {
        return el('div', { id: 'tabbar' }, TABS.map(function (t) {
            return el('div', { class: 'tab' + (S.tab === t.id ? ' sel' : ''), onclick: function () { setTab(t.id); } }, [
                el('div', { class: 'ico-wrap', html: '<svg viewBox="0 0 24 24"><path d="' + t.ico + '"/></svg>' }),
                el('div', { text: t.label })
            ]);
        }));
    }

    function tab() {
        if (S.tab === 'swap') return swapTab();
        if (S.tab === 'market') return marketTab();
        if (S.tab === 'wallet') return walletTab();
        if (S.tab === 'activity') return activityTab();
        return otcTab();
    }

    // ---- SWAP ----
    function swapTab() {
        var q = S.quote;
        var have = q && (S.sell ? q.bidMaker : q.askMaker);
        var wrap = el('div', {}, [
            el('div', { class: 'hdr' }, [el('div', { class: 'brand', text: 'Swap ' + ccy() + ' ⇄ USDT', style: 'font-size:18px' })]),
            el('div', { class: 'subline', text: "Enter an amount — see exactly what you'll get at the best price." }),
            el('div', { class: 'seg' }, [
                el('button', { class: 'segbtn' + (S.sell ? ' on' : ''), text: 'Sell ' + ccy(), onclick: function () { S.sell = true; recompute(); } }),
                el('button', { class: 'segbtn' + (!S.sell ? ' on' : ''), text: 'Buy ' + ccy(), onclick: function () { S.sell = false; recompute(); } })
            ])
        ]);
        if (!have) {
            wrap.appendChild(el('div', { class: 'card' }, [
                el('div', { style: 'font-weight:700', text: 'No one is quoting a ' + (S.sell ? 'buy' : 'sell') + ' price right now.' }),
                el('div', { class: 'empty', text: 'Check back soon, or open Market to place your own order and wait for a match.' }),
                el('button', { class: 'pill', text: 'Open Market', style: 'margin-top:10px', onclick: function () { setTab('market'); } })
            ]));
            wrap.appendChild(stages());
            return wrap;
        }
        // ---- faithful bidirectional dual-amount card (native parity): the ccy (mxUSDT) field is the canonical
        //      S.amount; typing EITHER field updates the other in place (no re-render → the edited field keeps focus). ----
        var price = S.sell ? q.bestBid : q.bestAsk;
        var cap = S.sell ? q.bidCap : q.askCap;
        var depth = AX.swapplan.sweepDepthMinima(S.book, S.sell, myId(), S.sell ? 0 : (AX.ui.slip / 100));
        var ccyIn = bidiInput(S.amount);                                   // holds the mxUSDT (ccy) amount
        var usdtIn = bidiInput(AX.swapplan.computeUsdt(S.amount, price) || '');   // the USDT estimate (floor)
        ccyIn.addEventListener('input', function () {
            S.amount = clean(ccyIn.value); if (ccyIn.value !== S.amount) ccyIn.value = S.amount;
            usdtIn.value = AX.swapplan.computeUsdt(S.amount, price) || '';   // sibling only — never render mid-edit
        });
        usdtIn.addEventListener('input', function () {
            var u = clean(usdtIn.value); if (usdtIn.value !== u) usdtIn.value = u;
            S.amount = AX.swapplan.computeMinima(u, price) || ''; ccyIn.value = S.amount;
        });
        var blurRender = function () { setTimeout(function () { if (document.activeElement !== ccyIn && document.activeElement !== usdtIn) render(); }, 250); };
        ccyIn.addEventListener('blur', blurRender); usdtIn.addEventListener('blur', blurRender);
        var sendRow = amtField('YOU SEND', S.sell ? coinChip(true) : coinChip(false), S.sell ? ccyIn : usdtIn);
        var recvRow = amtField('YOU RECEIVE (estimate)', S.sell ? coinChip(false) : coinChip(true), S.sell ? usdtIn : ccyIn);
        wrap.appendChild(el('div', { class: 'card' }, [
            sendRow,
            el('div', { class: 'flip' }, [el('div', { class: 'ln' }), el('button', { class: 'btn-flip', text: '⇅', onclick: function () { S.sell = !S.sell; recompute(); } }), el('div', { class: 'ln' })]),
            recvRow,
            el('div', { class: 'bestline', text: 'Best price ' + AX.fmt.px(price) + ' USDT/' + ccy() + '  ·  up to ~' + AX.fmt.abbrev(cap) + ' at best'
                + (depth > cap + 1e-9 ? ', ~' + AX.fmt.abbrev(depth) + ' across the book' : '') + (S.sell ? '' : '  ·  ETH gas per part') }),
            S.sell ? null : slippageRow(),
            el('button', { class: 'cta', text: 'Review swap', onclick: function () { AX.ui.onReview && AX.ui.onReview(S); } })
        ]));
        wrap.appendChild(stages());
        if (S.status) wrap.appendChild(el('div', { class: 'statusline' + (S.status.charAt(0) === '✓' ? ' ok' : ''), text: S.status }));
        return wrap;
    }

    function coinChip(isCcy) {
        var lab = isCcy ? ccy() : 'USDT';
        var disc = el('div', { class: 'disc' + (isCcy ? '' : ' usdt'), text: isCcy ? 'M' : '$' });
        var avail = isCcy ? S.bals.minima : S.bals.usdt;
        return el('div', { class: 'coinchip' }, [disc, el('div', {}, [el('div', { class: 'tick', text: lab }), el('div', { class: 'avail', text: 'avail ' + avail })])]);
    }
    /** A large mono decimal input (native monoBold 26). Wiring is done by the caller (bidirectional conversion). */
    function bidiInput(val) { return el('input', { class: 'amt mono', inputmode: 'decimal', placeholder: '0.00', value: val || '' }); }
    /** A labelled amount row: [label] then [coin chip + amount input]. */
    function amtField(label, chip, input) { return el('div', {}, [el('div', { class: 'label', text: label }), el('div', { class: 'amtrow' }, [chip, input])]); }
    function clean(v) { return String(v).replace(/[^0-9.]/g, ''); }
    function slippageRow() {
        return el('div', { class: 'sliprow' }, [
            el('span', { class: 'label', text: 'Max slippage', style: 'text-transform:none' }),
            el('button', { class: 'pill' + (AX.ui.slip === 2 ? ' on' : ''), text: '2%', onclick: function () { AX.ui.slip = 2; softUpdate(); } }),
            el('button', { class: 'pill' + (AX.ui.slip === 4.2 ? ' on' : ''), text: '4.2%', onclick: function () { AX.ui.slip = 4.2; softUpdate(); } }),
            el('button', { class: 'pill' + (AX.ui.slip !== 2 && AX.ui.slip !== 4.2 ? ' on' : ''),
                text: (AX.ui.slip !== 2 && AX.ui.slip !== 4.2) ? AX.ui.slip + '%' : 'Custom', onclick: customSlippageDialog })
        ]);
    }

    /** Custom max-slippage input (BUY sweeps): plain % number, clamped 0.1–50. A `form` modal (typing-safe). */
    function customSlippageDialog() {
        var inp = el('input', { class: 'amt mono', inputmode: 'decimal', style: 'font-size:18px;width:100%', placeholder: 'e.g. 1.5', value: '' });
        dialog({
            form: true,
            title: 'Custom max slippage',
            lines: [
                { node: el('div', {}, [el('div', { class: 'label', text: 'Percent (0.1 – 50)' }), inp]) },
                { text: 'A BUY sweep will not take levels priced beyond this above the best ask.', cls: 'dim' }
            ],
            confirmText: 'Set', cancelText: 'Cancel',
            onConfirm: function () {
                var v = parseFloat(inp.value);
                if (!isFinite(v) || v < 0.1 || v > 50) { AX.ui.toast && AX.ui.toast('Enter a percent between 0.1 and 50'); return; }
                AX.ui.slip = Math.round(v * 10) / 10;
                softUpdate();
            }
        });
    }

    function stages() {
        var rows = [];
        rows.push(stageRow(S.paired ? 'done' : 'warn', 'Node ready'));
        if (S.sell) rows.push(stageRow(gt(S.bals.minima) ? 'done' : 'pending', ccy() + ' ready to sell'));
        else { rows.push(stageRow(gt(S.bals.usdt) ? 'done' : 'pending', 'USDT ready to spend')); rows.push(stageRow(gt(S.bals.eth) ? 'done' : 'pending', 'ETH for gas')); }
        var sw = activeSwap();
        if (sw) {
            rows.push(el('div', { class: 'mono', style: 'font-size:12px;color:var(--dim2);padding:4px 0', text: sw.sellamount + ' ' + tok(sw.selltoken) + ' → ' + sw.buyamount + ' ' + tok(sw.buytoken) + ' · ' + sw.role.toLowerCase() }));
            rows.push(stageRow(legDone(sw, 1), 'Locked your ' + sw.sellamount + ' ' + tok(sw.selltoken)));
            rows.push(stageRow(legDone(sw, 2), 'Counterparty locks their side'));
            rows.push(stageRow(legDone(sw, 3), 'Claim your ' + sw.buyamount + ' ' + tok(sw.buytoken)));
            rows.push(stageRow(legDone(sw, 4), 'Swap complete'));
        } else rows.push(stageRow('pending', 'Enter an amount and tap Review to begin'));
        return el('div', {}, [el('div', { class: 'label', style: 'margin-top:16px', text: 'YOUR SWAP' }), el('div', { class: 'stages' }, rows)]);
    }
    function stageRow(state, text) { return el('div', { class: 'stage ' + state }, [el('span', { class: 'sdot' }), el('span', { text: text })]); }
    function legDone(sw, n) {
        var st = sw.status;
        if (st === 'COMPLETE') return 'done';
        if (st === 'REFUNDED') return n === 1 ? 'warn' : 'pending';
        if (n === 1) return 'done';
        if (n === 2) return (st === 'LOCKED' || st === 'CLAIMING') ? 'active' : 'pending';
        if (n === 3) return st === 'CLAIMING' ? 'active' : 'pending';
        return 'pending';
    }

    // ---- MARKET (order book) ----
    function marketTab() {
        var wrap = el('div', {}, [
            el('div', { class: 'empty', style: 'margin-top:0', text: 'The live order book. Tap a price to trade, or publish your own offer.' })
        ]);
        if (S.oracle) wrap.appendChild(el('div', { class: 'mono', style: 'font-size:11.5px;color:var(--dim);margin-top:6px', text: S.oracle }));
        var n = Object.keys(S.book).length;
        wrap.appendChild(el('div', { class: 'hdr', style: 'margin-top:12px' }, [
            el('div', { class: 'brand', style: 'font-size:16px', text: 'Order book  ·  ' + n + ' live' }),
            el('button', { class: 'pill', text: 'Refresh', onclick: function () { AX.ui.onRefreshBook && AX.ui.onRefreshBook(); } })
        ]));
        var bids = B.aggSide(S.book, true, null), asks = B.aggSide(S.book, false, null);
        if (!bids.length && !asks.length) { wrap.appendChild(el('div', { class: 'empty', text: 'No live orders yet. Publish one, or wait for a counterparty.' })); }
        else {
            var bestBid = bids.length ? bids[0].level.p : 0, bestAsk = asks.length ? asks[0].level.p : 0;
            if (bestBid && bestAsk) wrap.appendChild(el('div', { class: 'mono', style: 'font-size:11px;color:var(--dim2)', text: 'spread ' + AX.fmt.px(bestAsk - bestBid) + ' USDT  ·  USDT per ' + ccy() + ', size in ' + ccy() }));
            wrap.appendChild(el('div', { class: 'legend' }, [el('span', { class: 'sell', text: 'SELL ' + ccy() + ' (bid)' }), el('span', { class: 'buy', text: 'BUY ' + ccy() + ' (ask)' })]));
            var rows = Math.min(Math.max(bids.length, asks.length), 12);
            for (var i = 0; i < rows; i++) wrap.appendChild(depthRow(bids[i], asks[i], i === 0));
        }
        wrap.appendChild(el('div', { class: 'spacer' }));
        if (S.editing) { wrap.appendChild(orderEditor()); return wrap; }
        wrap.appendChild(el('div', { style: 'display:flex;gap:8px' }, [
            el('button', { class: 'btn', style: 'flex:1', text: 'Edit my order', onclick: function () { S.editing = true; render(); } }),
            el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Publish', onclick: function () { AX.ui.onPublish && AX.ui.onPublish(); } })
        ]));
        wrap.appendChild(marketHistory());
        return wrap;
    }

    // ---- maker order editor (auto-MM peg ladder or a manual single level) ----
    function editInput(id, val, ph) { var i = el('input', { class: 'amt mono', inputmode: 'decimal', placeholder: ph || '0', value: (val == null ? '' : String(val)), style: 'font-size:16px;text-align:right' }); i.id = id; return i; }
    function editRow(label, input) { return el('div', { class: 'amtrow', style: 'justify-content:space-between' }, [el('div', { class: 'label', style: 'text-transform:none', text: label }), input]); }
    function toggle(on, cb) { return el('button', { class: 'pill' + (on ? ' on' : ''), text: on ? 'On' : 'Off', onclick: cb }); }
    function genField(id, val, ph) { var i = el('input', { class: 'amt mono', inputmode: 'decimal', placeholder: ph, value: (val == null || val === '' ? '' : String(val)), style: 'font-size:14px;text-align:right;flex:1;min-width:0' }); i.id = id; return i; }
    function genRow(fields) { return el('div', { style: 'display:flex;gap:6px;margin:4px 0' }, fields); }
    /** One editable ladder rung: A1/B1… tag + price + per-take size. */
    function levelRow(tag, idP, idA, pv, av, color) {
        var p = el('input', { class: 'amt mono', inputmode: 'decimal', placeholder: 'price', value: (pv == null ? '' : String(pv)), style: 'font-size:14px;text-align:right;flex:1;min-width:0;color:' + color }); p.id = idP;
        var a = el('input', { class: 'amt mono', inputmode: 'decimal', placeholder: 'size', value: (av == null ? '' : String(av)), style: 'font-size:14px;text-align:right;flex:1;min-width:0' }); a.id = idA;
        return el('div', { style: 'display:flex;gap:6px;align-items:center;margin-top:3px' }, [el('span', { class: 'mono', style: 'width:26px;font-size:11px;color:var(--dim2)', text: tag }), p, a]);
    }
    function orderEditor() {
        var c = S.makerCfg || (S.makerCfg = {});
        var man = S.makerManual || { bids: [], asks: [] };
        var peg = c.pegEnable !== false;   // default auto-price on
        var pegSrc = TR.active().pricingParity ? 'parity' : 'MEXC';
        var asks = (man.asks || []).slice().sort(function (a, b) { return a.p - b.p; });   // A1 = best/lowest ask
        var bids = (man.bids || []).slice().sort(function (a, b) { return b.p - a.p; });   // B1 = best/highest bid
        var box = el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'YOUR MARKET · ' + ccy() + ' ⇄ USDT' }),
            el('div', { class: 'empty', style: 'margin:0 0 8px', text: 'ASKS = you SELL ' + ccy() + ' (higher). BIDS = you BUY (lower). Each amount is a per-take cap; leave rows blank to skip. Blank a whole side for a one-sided market.' }),
            editRow('Auto-price (peg to ' + pegSrc + ')', toggle(peg, function () { c.pegEnable = !peg; render(); }))
        ]);
        if (peg) box.appendChild(genRow([genField('mk_bias', c.bias != null ? c.bias : '', 'skew ±%'), genField('mk_reprice', c.reprice != null ? c.reprice : '1', 'reprice ≥ %')]));
        box.appendChild(el('div', { class: 'label', style: 'text-transform:none;margin-top:8px', text: 'Auto-fill: mid · step % · levels, then ask/bid size (seeds the rungs)' }));
        box.appendChild(genRow([genField('mk_mid', '', 'mid'), genField('mk_step', c.step != null ? c.step : '', 'step %'), genField('mk_levels', c.levels != null ? c.levels : '1', 'levels')]));
        box.appendChild(genRow([genField('mk_asksize', c.askSize != null ? c.askSize : (c.size != null ? c.size : ''), 'ask size'), genField('mk_bidsize', c.bidSize != null ? c.bidSize : (c.size != null ? c.size : ''), 'bid size')]));
        box.appendChild(el('div', { style: 'color:var(--red);font-weight:700;font-size:12px;margin-top:10px', text: 'ASKS — you SELL ' + ccy() + ' (higher)' }));
        for (var i = 5; i >= 0; i--) { var la = asks[i] || {}; box.appendChild(levelRow('A' + (i + 1), 'mk_askP' + i, 'mk_askA' + i, la.p, la.a, 'var(--red)')); }
        box.appendChild(el('div', { style: 'color:var(--in);font-weight:700;font-size:12px;margin-top:10px', text: 'BIDS — you BUY ' + ccy() + ' (lower)' }));
        for (var j = 0; j < 6; j++) { var lb = bids[j] || {}; box.appendChild(levelRow('B' + (j + 1), 'mk_bidP' + j, 'mk_bidA' + j, lb.p, lb.a, 'var(--in)')); }
        box.appendChild(editRow('Min trade (' + ccy() + ')', editInput('mk_min', c.min != null ? c.min : '')));
        box.appendChild(el('button', { class: 'cta', text: 'Save & publish', onclick: function () { saveEditor(peg); } }));
        box.appendChild(el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
            el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Withdraw market', onclick: function () { AX.ui.onWithdraw && AX.ui.onWithdraw(); S.editing = false; } }),
            el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Cancel', onclick: function () { S.editing = false; render(); } })
        ]));
        setTimeout(wireAutofill, 0);   // client-side: typing mid/step/levels/ask-size/bid-size seeds the rungs
        return box;
    }
    function numVal(id) { var e = document.getElementById(id); return e ? e.value.replace(/[^0-9.\-]/g, '') : ''; }
    function wireAutofill() {
        function gv(id) { return Number(numVal(id)) || 0; }
        function setV(id, v) { var e = document.getElementById(id); if (e) e.value = v; }
        function fill() {
            var mid = gv('mk_mid'), step = gv('mk_step'), askSize = gv('mk_asksize'), bidSize = gv('mk_bidsize');
            if (!(mid > 0) || !(step > 0) || !(askSize > 0 || bidSize > 0)) return;
            var levels = Math.max(1, Math.min(O.MAX_LEVELS, Math.floor(gv('mk_levels')) || 1));
            var quoted = mid * (1 + Math.max(-20, Math.min(20, gv('mk_bias'))) / 100);
            for (var i = 0; i < O.MAX_LEVELS; i++) {
                var askOn = i < levels && askSize > 0, bidOn = i < levels && bidSize > 0;
                setV('mk_askP' + i, askOn ? AX.fmt.px(quoted * (1 + (i + 1) * step / 100)) : '');
                setV('mk_askA' + i, askOn ? AX.fmt.px(askSize) : '');
                setV('mk_bidP' + i, bidOn ? AX.fmt.px(quoted * (1 - (i + 1) * step / 100)) : '');
                setV('mk_bidA' + i, bidOn ? AX.fmt.px(bidSize) : '');
            }
        }
        ['mk_mid', 'mk_step', 'mk_levels', 'mk_asksize', 'mk_bidsize', 'mk_bias'].forEach(function (id) { var e = document.getElementById(id); if (e) e.addEventListener('input', fill); });
    }
    function saveEditor(peg) {
        function gv(id) { return Number(numVal(id)) || 0; }
        var manual = { bids: [], asks: [] };
        for (var i = 0; i < O.MAX_LEVELS; i++) {
            var ap = gv('mk_askP' + i), aa = gv('mk_askA' + i);
            if (ap > 0 && aa > 0) manual.asks.push({ p: ap, a: aa });
            var bp = gv('mk_bidP' + i), ba = gv('mk_bidA' + i);
            if (bp > 0 && ba > 0) manual.bids.push({ p: bp, a: ba });
        }
        var askSize = gv('mk_asksize'), bidSize = gv('mk_bidsize'), step = gv('mk_step');
        var cfg = { pegEnable: peg && step > 0 && (askSize > 0 || bidSize > 0), min: gv('mk_min'),
            step: step, bias: gv('mk_bias'), reprice: gv('mk_reprice') || 1,
            levels: Math.max(1, Math.min(O.MAX_LEVELS, Math.floor(gv('mk_levels')) || 1)),
            size: Math.max(askSize, bidSize), askSize: askSize, bidSize: bidSize };
        S.makerCfg = cfg; S.makerManual = manual; S.editing = false;
        if (AX.ui.onSaveOrder) AX.ui.onSaveOrder(cfg, manual);
    }
    function depthRow(bid, ask, best) {
        function half(row, isBid) {
            if (!row) return el('div', { class: 'half' + (isBid ? ' bid' : '') }, [el('span', { class: 'sz', text: '—' })]);
            var cap = B.levelCap(row.maker, row.level, isBid);
            var mine = B.isMine(row.maker, myId());
            return el('div', { class: 'half' + (isBid ? ' bid' : ''), onclick: function () { if (!mine && cap > 0) AX.ui.onTake && AX.ui.onTake(row.maker, isBid); } }, [
                el('span', { class: 'mono px ' + (isBid ? 'bidpx' : 'askpx'), text: AX.fmt.px(row.level.p) }),
                document.createTextNode(' '),
                el('span', { class: 'sz', text: AX.fmt.abbrev(row.level.a) }),
                el('div', { class: 'tag' + (mine ? ' you' : ''), text: mine ? 'you' : AX.fmt.shorten(row.maker.signerPk) })
            ]);
        }
        return el('div', { class: 'depth' + (best ? ' best' : '') }, [half(bid, true), el('span', { class: 'divider', text: '│' }), half(ask, false)]);
    }

    // ---- MARKET HISTORY (native marketView/MarketChartView port: network-wide price feed) ----
    function fmtChartPrice(v) { return v < 1 ? (Math.round(v * 1e5) / 1e5).toString() : (Math.round(v * 100) / 100).toString(); }
    function relTime(ms) {
        var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.round(s / 60) + ' min. ago';
        if (s < 86400) return Math.round(s / 3600) + ' hr. ago';
        return Math.round(s / 86400) + ' days ago';
    }
    function marketHistory() {
        var m = S.market || { chart: [], recent: [] };
        var wrap = el('div', { style: 'margin-top:16px' }, [
            el('div', { class: 'label', text: 'MARKET HISTORY' })
        ]);
        var canvas = el('canvas', { class: 'card', width: '640', height: '180', style: 'width:100%;height:180px;border-radius:14px;margin-top:6px' });
        wrap.appendChild(canvas);
        // draw after the node is attached (jsdom has no 2d context — guard, assert element only)
        setTimeout(function () { try { drawChart(canvas, m.chart); } catch (e) { } }, 0);
        var last = m.chart.length ? fmtChartPrice(m.chart[m.chart.length - 1].price) : '—';
        var ex = 0, op = 0;
        (m.recent || []).forEach(function (t) { if (t.status === 'EXECUTED') ex++; else if (t.status === 'OPEN') op++; });
        wrap.appendChild(el('div', { class: 'mono', style: 'font-size:11px;color:var(--dim2);padding:8px 2px 6px',
            text: 'last ' + last + ' USDT/' + ccy() + '  ·  ' + ex + ' filled · ' + op + ' open  ·  price only (buy/sell not shown)' }));
        if (!(m.recent || []).length) {
            wrap.appendChild(el('div', { class: 'empty', text: 'No market trades observed yet. AtomiX records ' + ccy() + ' swaps network-wide as they happen — it can’t backfill, so history builds from now on.' }));
            return wrap;
        }
        m.recent.forEach(function (t) {
            var exd = t.status === 'EXECUTED', ref = t.status === 'REFUNDED';
            wrap.appendChild(el('div', { class: 'card tight', style: 'display:flex;align-items:center;gap:8px;margin-top:6px' }, [
                el('span', { style: 'flex:1;font-size:11px;color:var(--dim2)', text: relTime(t.observedAt) }),
                el('span', { class: 'mono', style: 'font-size:14px', text: fmtChartPrice(t.price) }),
                el('span', { class: 'mono', style: 'font-size:12px;color:var(--dim);padding:0 8px', text: AX.fmt.abbrev(Number(t.sizeMinima)) + ' M' }),
                el('span', { class: 'pill ' + (exd ? 'fill-ok' : ref ? 'fill-ref' : ''), text: exd ? 'filled' : ref ? 'cancelled' : 'open' })
            ]));
        });
        return wrap;
    }
    /** Canvas port of native MarketChartView: axes DIM2, accent 2px line + 2.5px dots, top/bottom price labels. */
    function drawChart(canvas, data) {
        var cv = canvas.getContext && canvas.getContext('2d');
        if (!cv) return;   // jsdom/no-2d — element renders, drawing skipped
        var w = canvas.width, h = canvas.height;
        var padL = 46, padR = 8, padT = 8, padB = 16;
        var css = getComputedStyle(document.documentElement);
        var ACCENT = (css.getPropertyValue('--accent') || '#26A17B').trim();
        var DIM = (css.getPropertyValue('--dim') || '#8B909C').trim(), DIM2 = (css.getPropertyValue('--dim2') || '#6F7583').trim();
        cv.clearRect(0, 0, w, h);
        cv.font = '12px JetBrains Mono, monospace'; cv.fillStyle = DIM;
        if (!data || data.length < 2) {
            cv.fillText(!data || !data.length ? 'Collecting market data…' : '1 trade so far — need 2+ to chart', padL, h / 2);
            return;
        }
        var minP = Infinity, maxP = -Infinity, minB = Infinity, maxB = -Infinity;
        data.forEach(function (t) {
            minP = Math.min(minP, t.price); maxP = Math.max(maxP, t.price);
            minB = Math.min(minB, t.createdBlock); maxB = Math.max(maxB, t.createdBlock);
        });
        if (maxP <= minP) maxP = minP + Math.max(minP * 0.001, 1e-9);
        if (maxB <= minB) maxB = minB + 1;
        var plotW = w - padL - padR, plotH = h - padT - padB;
        function px(b) { return padL + ((b - minB) / (maxB - minB)) * plotW; }
        function py(v) { return padT + (1 - (v - minP) / (maxP - minP)) * plotH; }
        cv.strokeStyle = DIM2; cv.lineWidth = 1;
        cv.beginPath(); cv.moveTo(padL, padT); cv.lineTo(padL, h - padB); cv.lineTo(w - padR, h - padB); cv.stroke();
        cv.font = '10px JetBrains Mono, monospace';
        cv.fillText(fmtChartPrice(maxP), 2, padT + 9);
        cv.fillText(fmtChartPrice(minP), 2, h - padB);
        cv.strokeStyle = ACCENT; cv.lineWidth = 2; cv.beginPath();
        data.forEach(function (t, i) { var x = px(t.createdBlock), y = py(t.price); if (i === 0) cv.moveTo(x, y); else cv.lineTo(x, y); });
        cv.stroke();
        cv.fillStyle = ACCENT;
        data.forEach(function (t) { cv.beginPath(); cv.arc(px(t.createdBlock), py(t.price), 2.5, 0, Math.PI * 2); cv.fill(); });
    }

    // ---- WELCOME (native showWelcome, MDS-correct requirements bullet) ----
    function welcomeDialog() {
        dialog({
            title: 'Welcome to AtomiX',
            lines: [
                { text: 'Swap ' + ccy() + ' ⇄ USDT trustlessly across chains — no middleman ever holds your funds.' },
                { text: 'To trade you’ll need:' },
                { text: '•  A Minima node with AtomiX given Write permission', cls: 'dim' },
                { text: '•  Some ' + ccy() + ' to sell — or USDT plus a little ETH (for gas) to buy ' + ccy(), cls: 'dim' },
                { text: 'Your keys are derived from your Minima node seed, so it’s the same wallet on any device.' },
                { text: 'Tabs:  Swap (quick trade) · Wallet (your money) · Activity (your swaps) · Market (full order book) · OTC (private deals).', cls: 'dim' },
                { text: 'OTC lets you negotiate a size + price directly with a liquidity provider — propose, counter, accept — and the agreed deal settles as the same trustless atomic swap.', cls: 'dim' }
            ],
            cancelText: 'Get started'
        });
    }

    // ---- WALLET ----
    function ethAddr() { return S.ctx && S.ctx.eth ? S.ctx.eth.address : null; }
    function minimaBreakdown() {
        var m = S.balsMeta;
        if (!m) return null;
        var locked = Math.max(0, (Number(m.confirmed) || 0) - (Number(m.sendable) || 0));
        var age = m.at ? Math.max(0, Math.round((Date.now() - m.at) / 1000)) + 's ago' : 'never';
        return 'confirmed ' + m.confirmed + '  ·  locked ≈ ' + (Math.round(locked * 1e6) / 1e6) + '  ·  unconfirmed ' + m.unconfirmed
            + '  ·  ' + m.coins + ' coins  ·  updated ' + age + '  ·  tap for coins';
    }
    function walletTab() {
        var addr = ethAddr();
        var pulse = S.pulse || {}; S.pulse = null;   // one-shot: consume the balance-change pulse flags
        return el('div', {}, [
            walletCard('Minima · available to swap', S.bals.minima + ' ' + ccy(), 'var(--accent)', minimaBreakdown(),
                function () { AX.ui.onCoinDump && AX.ui.onCoinDump(); }, pulse.minima),
            walletCard('Ethereum · Ethereum', S.bals.eth + ' ETH', 'var(--text)',
                addr ? AX.wallet.shortAddr(addr) : 'deriving from node seed…', addr ? receiveDialog : null, pulse.eth),
            walletCard('USDT · Ethereum', S.bals.usdt + ' USDT', 'var(--text)', null, null, pulse.usdt),
            el('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' }, [
                el('button', { class: 'pill', text: '↻  Refresh', onclick: function () { AX.ui.onRefreshBal && AX.ui.onRefreshBal(); } }),
                el('button', { class: 'pill', text: '⤓  Fund / QR', onclick: receiveDialog }),
                el('button', { class: 'pill', text: '↑  Send', onclick: sendDialog }),
                el('button', { class: 'pill', text: '🔑  Export key', onclick: exportKeyDialog })
            ]),
            // Native m:2589 — red RPC-failure line under the action pills. Cleared on the next good refresh.
            S.ethErr ? el('div', { style: 'color:var(--red);font-size:12px;padding:8px 2px 0', text: '⚠ ' + S.ethErr }) : null
        ]);
    }
    function walletCard(title, val, color, sub, onclick, pulse) {
        var kids = [
            el('div', { class: 'label', style: 'text-transform:none;letter-spacing:0', text: title }),
            el('div', { class: 'bigval' + (pulse ? ' pulse' : ''), style: 'color:' + color + ';margin-top:4px', text: val })
        ];
        if (sub) kids.push(el('div', { class: 'dim mono', style: 'font-size:11.5px;margin-top:4px;color:var(--dim)', text: sub }));
        var attrs = { class: 'card tight', style: 'border-radius:16px' + (onclick ? ';cursor:pointer' : '') };
        if (onclick) attrs.onclick = onclick;
        return el('div', attrs, kids);
    }

    /** Receive / Fund — native MainActivity.receiveDialog (:3222): full selectable address + QR of the PLAIN
     *  address on a white quiet-zone box + the all-EVM note. */
    function receiveDialog() {
        var addr = ethAddr();
        if (!addr) { AX.ui.toast && AX.ui.toast('ETH wallet not ready yet'); return; }
        var qrNode = null;
        try {
            var qr = qrcode(0, 'M');
            qr.addData(addr); qr.make();
            qrNode = el('div', { style: 'background:#FFFFFF;padding:8px;border-radius:8px;margin:10px auto;width:fit-content;text-align:center', html: qr.createImgTag(5, 6) });
        } catch (e) { qrNode = el('div', { class: 'dlgline dim', text: '(QR unavailable)' }); }
        dialog({
            title: 'Receive / Fund · Ethereum',
            lines: [
                { node: el('div', { class: 'dlgline mono', style: 'user-select:all;word-break:break-all;text-align:center;font-size:13px', text: addr }) },
                { node: qrNode },
                { text: 'Same address on all EVM networks — fund it with Ethereum ETH and tokens.', cls: 'dim' }
            ],
            confirmText: 'Copy address', cancelText: 'Close',
            onConfirm: function () { AX.ui.onCopy && AX.ui.onCopy(addr, 'ETH address copied'); }
        });
    }

    /** Export key — native 2-step (:3264/:3275): warning first, then the revealed key. Never logged. */
    function exportKeyDialog() {
        dialog({
            title: 'Export ETH private key',
            lines: [{ text: 'This key controls your ETH funds. Anyone who sees it can take them. It is also derived from your Minima node seed. Never share it or type it into a website.' }],
            confirmText: 'Reveal key', cancelText: 'Cancel',
            onConfirm: revealKeyDialog
        });
    }
    function revealKeyDialog() {
        var pk = S.ctx && S.ctx.eth ? S.ctx.eth.privKey : null;
        if (!pk) { AX.ui.toast && AX.ui.toast('ETH wallet not ready yet'); return; }
        dialog({
            title: 'ETH private key',
            lines: [
                { text: '⚠ Keep this secret.', cls: 'red' },
                { node: el('div', { class: 'dlgline mono', style: 'user-select:all;word-break:break-all;font-size:12px', text: pk }) }
            ],
            confirmText: 'Copy key', cancelText: 'Close',
            onConfirm: function () { AX.ui.onCopy && AX.ui.onCopy(pk, 'Private key copied'); }
        });
    }

    /** Send ETH / USDT — MDS-only (the native wallet is receive-only; user-decided divergence, PARITY.md).
     *  A `form` modal: its DOM is cached so poll re-renders can't wipe what the user is typing. */
    function sendDialog() {
        if (!ethAddr()) { AX.ui.toast && AX.ui.toast('ETH wallet not ready yet'); return; }
        if (!S.sendForm) S.sendForm = { asset: 'eth' };
        var f = S.sendForm;
        var toIn = el('input', { class: 'amt mono', style: 'font-size:14px;width:100%', placeholder: '0x… recipient', value: f.to || '' });
        toIn.addEventListener('input', function () { f.to = toIn.value.trim(); });
        var amtIn = el('input', { class: 'amt mono', inputmode: 'decimal', style: 'font-size:18px;width:100%', placeholder: '0.00', value: f.amt || '' });
        amtIn.addEventListener('input', function () { f.amt = amtIn.value.trim(); });
        function assetPill(kind, label) {
            var p = el('button', { class: 'pill' + (f.asset === kind ? ' on' : ''), text: label });
            p.addEventListener('click', function () {
                f.asset = kind;
                var pills = p.parentNode.querySelectorAll('.pill');
                for (var i = 0; i < pills.length; i++) pills[i].className = 'pill';
                p.className = 'pill on';
            });
            return p;
        }
        var maxBtn = el('button', { class: 'pill', text: 'Max' });
        maxBtn.addEventListener('click', function () {
            if (AX.ui.onSendMax) AX.ui.onSendMax(f.asset, function (amt) { f.amt = amt; amtIn.value = amt; });
        });
        dialog({
            form: true,
            title: 'Send from this wallet',
            lines: [
                { node: el('div', { style: 'display:flex;gap:8px;margin-bottom:8px' }, [assetPill('eth', 'ETH'), assetPill('usdt', 'USDT')]) },
                { node: el('div', {}, [el('div', { class: 'label', text: 'To' }), toIn]) },
                { node: el('div', { style: 'display:flex;gap:8px;align-items:flex-end;margin-top:8px' }, [el('div', { style: 'flex:1' }, [el('div', { class: 'label', text: 'Amount' }), amtIn]), maxBtn]) },
                { text: 'Sends are irreversible. Double-check the address.', cls: 'dim' }
            ],
            confirmText: 'Review', cancelText: 'Cancel', stayOpen: true,
            onConfirm: function () { AX.ui.onSendReview && AX.ui.onSendReview(f.asset, f.to || '', f.amt || ''); }
        });
    }

    /** The send review step (built by app.js after validation + a live gas read). */
    function sendReviewDialog(asset, to, amt, feeEth, onConfirmSend) {
        closeDialog();   // drop the form modal (values are held by app.js now)
        dialog({
            title: 'Review — Send ' + (asset === 'eth' ? 'ETH' : 'USDT'),
            lines: [
                { text: 'Send  ' + amt + ' ' + (asset === 'eth' ? 'ETH' : 'USDT') },
                { node: el('div', { class: 'dlgline mono', style: 'word-break:break-all', text: 'To  ' + to }) },
                { text: 'Network fee  ≈ ' + feeEth + ' ETH', cls: 'dim' },
                { text: 'This cannot be undone.', cls: 'red' }
            ],
            confirmText: 'Send now', cancelText: 'Back',
            onConfirm: onConfirmSend
        });
    }

    /** Coin dump — native long-press on the Minima card; here a tap. rows = [{amount, coinid}]. */
    function coinsDialog(rows) {
        dialog({
            title: 'Your ' + ccy() + ' coins',
            lines: rows.length ? rows.map(function (c) {
                return { node: el('div', { class: 'dlgline mono', style: 'font-size:12px', text: c.amount + '  ·  ' + AX.wallet.shortAddr(c.coinid) }) };
            }) : [{ text: 'No sendable coins right now.', cls: 'dim' }],
            cancelText: 'Close'
        });
    }

    // ---- ACTIVITY ----
    function activityTab() {
        var list = S.swaps || [];
        var hdrKids = [el('div', { class: 'brand', style: 'font-size:16px;flex:1', text: 'Your swaps' })];
        if (list.length) hdrKids.push(el('button', { class: 'pill', text: '⬇ Export CSV',
            onclick: function () { AX.ui.onExportCsv && AX.ui.onExportCsv(); } }));
        var wrap = el('div', {}, [el('div', { class: 'hdr', style: 'display:flex;align-items:center;gap:8px' }, hdrKids)]);
        if (!list.length) { wrap.appendChild(el('div', { class: 'empty', text: 'No swaps yet — your completed and refunded swaps will appear here.' })); return wrap; }
        list.forEach(function (sw) {
            wrap.appendChild(el('div', { class: 'card tight', style: 'cursor:pointer',
                onclick: function () { AX.ui.onSwapDetail && AX.ui.onSwapDetail(sw.hash); } }, [
                el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                    el('div', { class: 'mono', style: 'flex:1;font-size:14px', text: sw.sellamount + ' ' + tok(sw.selltoken) + ' → ' + sw.buyamount + ' ' + tok(sw.buytoken) }),
                    el('span', { class: 'status ' + sw.status.toLowerCase(), text: statusLabel(sw.status) })
                ]),
                el('div', { class: 'statusline', text: AX.inspect.statusDetail(sw) }),
                el('div', { class: 'statusline dim', style: 'font-size:11px', text: 'Tap to inspect both legs live' })
            ]));
        });
        return wrap;
    }
    function statusLabel(s) { return { STARTED: 'waiting', LOCKED: 'locked', CLAIMING: 'claiming', COMPLETE: 'complete', REFUNDED: 'refunded', ERROR: 'error' }[s] || s.toLowerCase(); }

    /** The "Swap status" live report modal (native showReport): plain-language lines + Check again. */
    function swapReportDialog(hash, lines) {
        dialog({
            title: 'Swap status',
            lines: lines.map(function (l, i) { return { text: l, cls: l.indexOf('⚠') === 0 ? 'red' : (i === 0 || l.indexOf('•') === 0 || l.indexOf('→') === 0 ? '' : 'dim') }; }),
            confirmText: 'Check again', cancelText: 'Close',
            onConfirm: function () { AX.ui.onSwapDetail && AX.ui.onSwapDetail(hash); }
        });
    }

    // ---- OTC (negotiated peer-to-peer) ----
    function otcTab() {
        var wrap = el('div', {}, [el('div', { class: 'empty', style: 'margin-top:0', text: 'Negotiate a custom size + price directly with a liquidity provider, then settle as a trustless HTLC swap.' })]);
        // my availability
        wrap.appendChild(el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'YOUR AVAILABILITY (' + ccy() + ')' }),
            editRow('Max to SELL', editInput('otc_sell', '', ccy())),
            editRow('Max to BUY', editInput('otc_buy', '', ccy())),
            el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
                el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Go live', onclick: function () { AX.ui.onOtcGoLive && AX.ui.onOtcGoLive(numVal('otc_sell'), numVal('otc_buy')); } }),
                el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Withdraw', onclick: function () { AX.ui.onOtcWithdraw && AX.ui.onOtcWithdraw(); } })
            ])
        ]));
        // active deals
        var deals = S.otcDeals || [];
        if (deals.length) {
            wrap.appendChild(el('div', { class: 'label', style: 'margin-top:14px', text: 'YOUR DEALS' }));
            deals.forEach(function (d) { wrap.appendChild(dealCard(d)); });
        }
        // LP board
        wrap.appendChild(el('div', { class: 'label', style: 'margin-top:14px', text: 'LIQUIDITY PROVIDERS' }));
        var board = S.otcBoard || [];
        if (!board.length) wrap.appendChild(el('div', { class: 'empty', text: 'No OTC LPs online right now.' }));
        board.forEach(function (lp) { wrap.appendChild(lpCard(lp)); });
        if (S.otcProposing) wrap.appendChild(proposePanel(S.otcProposing));
        if (S.otcCountering) wrap.appendChild(counterPanel(S.otcCountering));
        if (S.status) wrap.appendChild(el('div', { class: 'statusline' + (S.status.charAt(0) === '✓' ? ' ok' : ''), text: S.status }));
        return wrap;
    }
    function lpCard(lp) {
        var lines = [];
        if (lp.sellSize > 0) lines.push('sells up to ' + AX.fmt.abbrev(lp.sellSize) + ' ' + ccy());
        if (lp.buySize > 0) lines.push('buys up to ' + AX.fmt.abbrev(lp.buySize) + ' ' + ccy());
        return el('div', { class: 'card tight' }, [
            el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                el('div', { class: 'mono', style: 'flex:1;font-size:13px', text: AX.fmt.shorten(lp.commsPublicId || lp.signerPk) }),
                el('button', { class: 'pill accent', text: 'Trade', onclick: function () { S.otcProposing = lp; S.otcCountering = null; render(); } })
            ]),
            el('div', { class: 'statusline', text: lines.join('  ·  ') || 'no liquidity' })
        ]);
    }
    function dealCard(d) {
        var mine = d.whoseTurn === 'ME', term = d.status === 'AGREED' || d.status === 'EXECUTING';
        var acts = [];
        if (mine && !term) {
            acts.push(el('button', { class: 'pill accent', text: 'Accept', onclick: function () { AX.ui.onOtcAccept && AX.ui.onOtcAccept(d); } }));
            acts.push(el('button', { class: 'pill', text: 'Counter', onclick: function () { S.otcCountering = d; S.otcProposing = null; render(); } }));
            acts.push(el('button', { class: 'pill', text: 'Reject', onclick: function () { AX.ui.onOtcReject && AX.ui.onOtcReject(d); } }));
        }
        return el('div', { class: 'card tight' }, [
            el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                el('div', { class: 'mono', style: 'flex:1;font-size:13px', text: (d.side === 'SELL' ? 'LP sells ' : 'LP buys ') + d.amount + ' ' + ccy() + ' @ ' + d.price }),
                el('span', { class: 'status ' + (term ? 'complete' : ''), text: d.status.toLowerCase() })
            ]),
            el('div', { class: 'statusline', text: term ? (d.status === 'AGREED' ? 'Agreed — locking legs…' : 'Executing on-chain…') : (mine ? 'Your move.' : 'Waiting on the counterparty.') }),
            acts.length ? el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, acts) : null
        ]);
    }
    function proposePanel(lp) {
        var side = S._otcSide || (lp.sellSize > 0 ? 'SELL' : 'BUY');
        return el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'PROPOSE TO ' + AX.fmt.shorten(lp.commsPublicId || lp.signerPk) }),
            el('div', { class: 'seg' }, [
                el('button', { class: 'segbtn' + (side === 'SELL' ? ' on' : '') + (lp.sellSize > 0 ? '' : ' off'), text: 'Buy ' + ccy() + ' (LP sells)', onclick: function () { if (lp.sellSize > 0) { S._otcSide = 'SELL'; render(); } } }),
                el('button', { class: 'segbtn' + (side === 'BUY' ? ' on' : '') + (lp.buySize > 0 ? '' : ' off'), text: 'Sell ' + ccy() + ' (LP buys)', onclick: function () { if (lp.buySize > 0) { S._otcSide = 'BUY'; render(); } } })
            ]),
            editRow('Amount (' + ccy() + ')', editInput('otc_amt', '')),
            editRow('Price (USDT/' + ccy() + ')', editInput('otc_px', '')),
            el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
                el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Send proposal', onclick: function () { AX.ui.onOtcPropose && AX.ui.onOtcPropose(lp, side, numVal('otc_amt'), numVal('otc_px')); S.otcProposing = null; } }),
                el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Cancel', onclick: function () { S.otcProposing = null; render(); } })
            ])
        ]);
    }
    function counterPanel(d) {
        return el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'COUNTER — ' + d.side + ' ' + ccy() }),
            editRow('Amount (' + ccy() + ')', editInput('otc_camt', d.amount)),
            editRow('Price (USDT/' + ccy() + ')', editInput('otc_cpx', d.price)),
            el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
                el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Send counter', onclick: function () { AX.ui.onOtcCounter && AX.ui.onOtcCounter(d, numVal('otc_camt'), numVal('otc_cpx')); S.otcCountering = null; } }),
                el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Cancel', onclick: function () { S.otcCountering = null; render(); } })
            ])
        ]);
    }

    // ---- helpers ----
    function tok(t) { return TR.labelForToken(t); }
    function gt(v) { return parseFloat(v) > 0; }
    function activeSwap() { for (var i = 0; i < (S.swaps || []).length; i++) if (!isTerminal(S.swaps[i])) return S.swaps[i]; return null; }
    function isTerminal(sw) { return sw.status === 'COMPLETE' || sw.status === 'REFUNDED' || sw.status === 'ERROR'; }

    function recompute() { S.quote = B.bestMakers(S.book, myId()); render(); }
    function softUpdate() { S.quote = B.bestMakers(S.book, myId()); /* re-render only the swap card body in Phase 3; full render for now */ render(); }
    function setTab(id) { S.tab = id; render(); if ((id === 'swap' || id === 'market') && AX.ui.onEnterBookTab) AX.ui.onEnterBookTab(); if (id === 'otc' && AX.ui.onEnterOtc) AX.ui.onEnterOtc(); }
    function toggleTheme() { AX.ui.dark = !AX.ui.dark; document.documentElement.setAttribute('data-theme', AX.ui.dark ? 'dark' : 'light'); AX.ui.onThemeSaved && AX.ui.onThemeSaved(AX.ui.dark); render(); }
    function switchCurrency() { if (AX.ui.onSwitchCurrency) AX.ui.onSwitchCurrency(TR.other()); }

    AX.ui = {
        state: S, dark: true, slip: 4.2, version: '0.1.10', block: 0,
        el: el, render: render, setState: function (patch) { for (var k in patch) S[k] = patch[k]; recompute(); },
        dialog: dialog, closeDialog: closeDialog, setStatus: setStatus,
        sendReviewDialog: sendReviewDialog, coinsDialog: coinsDialog,
        swapReportDialog: swapReportDialog, welcomeDialog: welcomeDialog
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
