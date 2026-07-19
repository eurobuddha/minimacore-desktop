/**
 * engine — the taker (initiator) leg of the atomic swap, a faithful port of native SwapEngine's user-driven start
 * paths. Two directions, each locking MY first leg and generating the secret, with record-before-broadcast so a
 * lost RPC response never loses funds:
 *   • startSell  (MINIMA_TO_ERC20): give the active currency (mxUSDT/MINIMA), receive ERC20 USDT — lock the Minima
 *     coin FIRST (block + 144), state[0..7]; the responder locks USDT and I claim by revealing the secret.
 *   • startBuy   (ERC20_TO_MINIMA): give ERC20 USDT, receive the active currency — approve (F4 zero-first) then
 *     newContract FIRST (chain-time + 7200s), then hand the maker our hashlock over the TAKE channel so they can
 *     locate the lock via getContract (contractId = sha256(hash)).
 * confirmMyLock gates a sweep's next (worse-priced) leg on the current leg actually landing on-chain.
 *
 * Platform note (vs native): native's UI-initiated buy BLOCKS on an allowance-confirm poll (Thread.sleep). MDS/
 * Rhino has no blocking sleep or event loop, so — exactly like native's non-blocking watcher approveIfReady — a
 * short allowance submits the approve (TTL-guarded) and asks the user to retry once it confirms; a wallet that
 * already has MAX allowance (the common case on the shared seed-derived wallet) locks in one shot.
 *
 * configure(ctx) before use: ctx = { rpc, ethPriv, ethAddr, myMinimaPk, onSwapsChanged? }. Active currency
 * (label + tokenId) is read live from AX.trading. Requires AX.swapdb, AX.htlc, AX.ethops, AX.dec, AX.flow,
 * AX.trading, AX.take. Attaches to AX.engine.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var DB = AX.swapdb, H = AX.htlc, EO = AX.ethops, D = AX.dec, F = AX.flow, TR = AX.trading;

    var HTLC_SCAN_DEPTH = 256;
    var MAX_UINT = EO.MAX_UINT;

    var C = null;                          // context (set by configure)
    var _now = function () { return Date.now(); };

    function configure(ctx) { C = ctx; }
    function ready() { return !!(C && C.rpc && C.ethPriv && C.ethAddr && C.myMinimaPk); }
    function ops() { return EO.make(C.rpc, C.ethPriv, C.ethAddr); }
    function usdt() { return { address: EO.NET.usdt, decimals: EO.NET.usdtDecimals }; }
    function notifyChanged() { if (C && typeof C.onSwapsChanged === 'function') C.onSwapsChanged(); }

    /** Unix seconds from CHAIN time for the initiator's first ETH timelock (F2); device-clock fallback is safe here
     *  — it only makes MY leg LONGER, and a slow clock is independently rejected by the responder's half-window. */
    function ethChainNow(cb) {
        C.rpc.latestBlockTimestamp(function (e, ts) { cb(e ? Math.floor(_now() / 1000) : ts); });
    }

    function baseSwap(hash, role, dir, sellTok, sellAmt, buyTok, buyAmt, cp, timelock, legIsMinima, contractId) {
        return {
            hash: hash, role: role, direction: dir, sellToken: sellTok, sellAmount: sellAmt,
            buyToken: buyTok, buyAmount: buyAmt, counterparty: cp, status: DB.ST_STARTED,
            contractId: contractId || '', myTimelock: timelock, myLegIsMinima: !!legIsMinima
        };
    }

    /** Record the secret + myhtlc request + swap row BEFORE broadcasting the lock (record-before-broadcast). */
    function recordStart(hash, secret, reqAmount, reqToken, swap, cb) {
        F.waterfall([
            function (n) { DB.insertSecret(hash, secret, function (e) { n(e); }); },
            function (n) { DB.insertMyHtlc(hash, reqAmount, reqToken, function (e) { n(e); }); },
            function (n) { DB.upsertSwap(swap, function (e) { n(e); }); }
        ], cb);
    }

    // ---- SELL: give active currency (Minima leg), receive ERC20 USDT ----
    function startSell(maker, sellMinima, symbol, buyTokenAmount, otc, cb) {
        if (!ready()) return cb(new Error('Not ready'));
        var token = usdt();
        var reqToken = 'ETH:' + token.address;
        var actTok = TR.active().tokenId, actLabel = TR.active().coinLabel;
        H.generateSecret(function (e, sec) {
            if (e) return cb(e);
            H.currentBlock(function (e2, block) {
                if (e2) return cb(e2);
                var timelock = block + H.TIMELOCK_BLOCKS;
                var swap = baseSwap(sec.hash, 'INITIATOR', 'MINIMA_TO_ERC20', actLabel, sellMinima, symbol, buyTokenAmount, maker.eth, timelock, true, null);
                recordStart(sec.hash, sec.secret, buyTokenAmount, reqToken, swap, function (eRec) {
                    if (eRec) return cb(eRec);
                    notifyChanged();
                    H.lock({
                        amount: sellMinima, requestAmount: buyTokenAmount, reqToken: token.address,
                        receiverPubkey: maker.mpk, ownerEthKey: C.ethAddr, hashlock: sec.hash,
                        timelockBlock: timelock, otc: otc ? 'TRUE' : 'FALSE', myPubkey: C.myMinimaPk, tokenId: actTok
                    }, function (eLock, txpowid) {
                        if (eLock) return cb(eLock);
                        DB.logEvent(sec.hash, DB.EV_STARTED, 'minima', sellMinima, txpowid, function () { cb(null, sec.hash); });
                    });
                });
            });
        });
    }

    // ---- BUY: give ERC20 USDT, receive active currency (Minima leg) ----
    function startBuy(maker, symbol, sellTokenAmount, buyMinima, otc, cb) {
        if (!ready()) return cb(new Error('Not ready'));
        var token = usdt();
        var reqMinima = D.grain6(buyMinima);                   // M1: quantize the request to the 6dp fillable grain
        var sellRaw = D.parseUnits(sellTokenAmount, token.decimals);   // USDT at 6dp
        var reqRaw = D.parseUnits(reqMinima, 18);              // requestAmount carried at 18dp (interop constant)
        var actLabel = TR.active().coinLabel;
        var o = ops();
        ensureAllowance(o, token.address, sellRaw, function (eAllow, ok) {
            if (eAllow) return cb(eAllow);
            if (!ok) return cb(new Error('Approving USDT spend — try the buy again in ~30s'));
            H.generateSecret(function (e, sec) {
                if (e) return cb(e);
                ethChainNow(function (now) {
                    var timelock = now + Number(H.TIMELOCK_SECS);
                    var swap = baseSwap(sec.hash, 'INITIATOR', 'ERC20_TO_MINIMA', symbol, sellTokenAmount, actLabel, reqMinima, maker.mpk, timelock, false, EO.contractId(sec.hash));
                    recordStart(sec.hash, sec.secret, reqMinima, 'minima', swap, function (eRec) {
                        if (eRec) return cb(eRec);
                        notifyChanged();
                        o.newContract(C.myMinimaPk, maker.eth, sec.hash, BigInt(timelock), token.address, sellRaw, reqRaw, !!otc, function (eNc, txhash) {
                            if (eNc) return cb(eNc);
                            DB.logEvent(sec.hash, DB.EV_STARTED, 'ETH:' + token.address, sellTokenAmount, txhash, function () { cb(null, sec.hash); });
                        });
                    });
                });
            });
        });
    }

    /** Non-blocking allowance gate (approveIfReady semantics) — the SINGLE shared copy lives in AX.ethops so the
     *  taker engine and the maker responder can't each fire a duplicate MAX approve from independent pending maps. */
    function ensureAllowance(o, token, needed, cb) { EO.ensureAllowance(o, token, needed, cb); }

    /**
     * startLeg — the single fund-safety chokepoint for BOTH the single-swap path and every sweep leg (mirrors
     * native MainActivity.startLeg). Re-checks the maker is still live right before locking (a maker that switched
     * currency / withdrew publishes a no-liquidity tombstone → makerLive false; locking against it would strand the
     * leg to the ~2h refund), then dispatches by direction. For BUYs it seals our hashlock to the maker after the
     * USDT locks. hooks = { makerLive():bool, me:identity, myPublicId, onWithdrawn(), onNote(tag) }. cb(err, hash).
     */
    function startLeg(maker, symbol, sellMinima, minima, usdtAmt, hooks, cb) {
        hooks = hooks || {};
        if (hooks.makerLive && !hooks.makerLive()) {
            if (hooks.onWithdrawn) hooks.onWithdrawn();
            return cb(new Error('that market was just withdrawn — refreshing the book, try again in a moment'));
        }
        if (sellMinima) {
            startSell(maker, minima, symbol, usdtAmt, false, cb);
        } else {
            startBuy(maker, symbol, usdtAmt, minima, false, function (e, hash) {
                if (e) return cb(e);
                cb(null, hash);                               // leg placed — report before the (async) handshake
                if (!hooks.me || !maker.cid) { if (hooks.onNote) hooks.onNote('buy-started-no-contact'); return; }
                var myPub = hooks.myPublicId || hooks.me.publicId();   // keep the sealed "from" consistent with the sender
                AX.take.send(hooks.me, maker.cid, myPub, hash, function (te) {
                    if (hooks.onNote) hooks.onNote(te ? ('buy-notify-failed:' + te.message) : 'buy-notified');
                });
            });
        }
    }

    // ---- confirmMyLock: is MY first leg visible on-chain yet? (gates the next sweep leg / halts on a dropped leg) ----
    function normKey(pk) { return H.normKey(pk); }
    function isMyPublishKey(pk) { return C && C.myMinimaPk && normKey(pk) === normKey(C.myMinimaPk); }
    function sameHash(a, b) {
        if (!a || !b) return false;
        a = String(a).replace(/^0x/i, ''); b = String(b).replace(/^0x/i, '');
        return a !== '' && a.toLowerCase() === b.toLowerCase();
    }
    function confirmMyLock(hash, myLegIsMinima, cb) {
        if (myLegIsMinima) {
            H.scanByHash(hash, 1, HTLC_SCAN_DEPTH, function (e, arr) {
                if (e) return cb(false);
                for (var i = 0; i < arr.length; i++) {
                    var c = arr[i];
                    if (c && isMyPublishKey(H.stateAt(c, 0)) && sameHash(H.stateAt(c, 5), hash)) return cb(true);
                }
                cb(false);
            });
        } else {
            ops().getContract(EO.contractId(hash), function (e, c) { cb(!e && !!c && c.amount != null && c.amount > 0n); });
        }
    }

    /** Instigator: execute an AGREED OTC deal — lock leg 1 (otc=TRUE) in the direction the deal side implies.
     *  side SELL (LP sells mxUSDT → I BUY): lock USDT. side BUY (LP buys mxUSDT → I SELL): lock mxUSDT. cb(err, hash). */
    function executeOtc(deal, cb) {
        var lp = { mpk: deal.peerMinimaPk, eth: deal.peerEthAddr, cid: deal.peerCommsId };
        var usdt = D.mulFloor(deal.amount, deal.price, 6);   // USDT = amount × price, floored to the 6dp grain
        if (deal.side === 'SELL') startBuy(lp, 'USDT', usdt, deal.amount, true, cb);
        else startSell(lp, deal.amount, 'USDT', usdt, true, cb);
    }

    AX.engine = {
        configure: configure, ready: ready,
        startSell: startSell, startBuy: startBuy, startLeg: startLeg, executeOtc: executeOtc,
        confirmMyLock: confirmMyLock, ensureAllowance: ensureAllowance,
        _setNow: function (fn) { _now = fn; EO._setNow(fn); }, _resetApprovals: function () { EO._resetApprovals(); },
        MAX_UINT: MAX_UINT, HTLC_SCAN_DEPTH: HTLC_SCAN_DEPTH
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
