/**
 * settle — the TAKER settlement engine (service.js poll cycle), a faithful port of native SwapEngine's poll()
 * taker paths. On each NEWBLOCK it drives MY in-flight swaps to a terminal state:
 *   • BUY  (myLegIsMinima=false): I locked USDT on ETH; the maker locks mxUSDT on Minima to me → I CLAIM the
 *     Minima leg with my secret (reveals it via the notify coin). My ETH leg is withdrawn BY the maker, or I
 *     REFUND it past my timelock.
 *   • SELL (myLegIsMinima=true): I locked mxUSDT; the maker locks USDT on ETH with receiver=me → I WITHDRAW the
 *     ETH leg with my secret. My Minima leg is claimed BY the maker, or I REFUND it past my timelock.
 *
 * Fund-safety carried verbatim from native: amountTokenOk (never reveal my secret unless the counterparty locked
 * ≥ what I asked, in the right token); F1 broadcast-vs-confirmation split (terminal status ONLY from the ETH
 * contract's withdrawn/refunded flags re-read each cycle, never from a broadcast ack) with a self-healing
 * ETH_RETRY_SECS window so a dropped tx re-sends (nonce-healed) instead of stranding; per-cycle inflight dedup.
 * The responder path (secret unknown → lock the counter-leg) is wired via AX.responder; the RESPONDER's settlement
 * needs the secret HARVESTS (notify coin state[100] + ETH contract preimage — native SwapEngine:515/814): the maker
 * never generates the secret, so without them every filled maker order strands past its timelock (fund loss).
 *
 * configure(ctx) before use: { rpc, ethPriv, ethAddr, myMinimaPk, myMinimaAddr, notify?(t,b), onSwapsChanged? }.
 * Requires AX.swapdb, AX.htlc, AX.ethops, AX.dec, AX.flow, AX.trading. Attaches to AX.settle.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var DB = AX.swapdb, H = AX.htlc, EO = AX.ethops, D = AX.dec, F = AX.flow, TR = AX.trading;

    var HTLC_SCAN_DEPTH = 256, NOTIFY_SCAN_DEPTH = 256, ETH_RETRY_SECS = 150;
    var C = null, ethAttempt = {}, inflight = {};
    var _now = function () { return Date.now(); };
    function nowUnix() { return Math.floor(_now() / 1000); }

    function configure(ctx) { C = ctx; }
    function ready() { return !!(C && C.rpc && C.ethPriv && C.ethAddr && C.myMinimaPk && C.myMinimaAddr); }
    function ops() { return EO.make(C.rpc, C.ethPriv, C.ethAddr); }
    function notify(t, b) { if (C && C.notify) C.notify(t, b); }
    function onChanged() { if (C && C.onSwapsChanged) C.onSwapsChanged(); }
    function ethRetryDue(k) { return nowUnix() - (ethAttempt[k] || 0) >= ETH_RETRY_SECS; }
    function markEthAttempt(k) { ethAttempt[k] = nowUnix(); }
    function isMyPublishKey(pk) { return !!(C && C.myMinimaPk && H.normKey(pk) === H.normKey(C.myMinimaPk)); }
    function sameHash(a, b) {
        if (!a || !b) return false;
        a = String(a).replace(/^0x/i, ''); b = String(b).replace(/^0x/i, '');
        return a !== '' && a.toLowerCase() === b.toLowerCase();
    }
    function stripReqToken(raw) {
        if (!raw) return '';
        var s = String(raw);
        if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') s = s.slice(1, -1);
        if (s.indexOf('ETH:') === 0) s = s.slice(4);
        return s;
    }
    function decimalsOf(tokenAddr) { return String(tokenAddr).toLowerCase() === EO.NET.usdt.toLowerCase() ? EO.NET.usdtDecimals : 18; }
    /** Log a counterparty amount/token mismatch ONCE, as EV_MISMATCH — NEVER as EV_COLLECT. The claim gates on
     *  hasEvent(EV_COLLECT), so logging COLLECT here (native SwapEngine:577 does — backport this fix) lets ANY
     *  third party poison a victim's real claim with one hostile dust coin carrying the victim's active hash. */
    function logMismatchOnce(hash, leg, note, next) {
        DB.hasEvent(hash, DB.EV_MISMATCH, function (e, have) {
            if (have) return next();
            DB.logEvent(hash, DB.EV_MISMATCH, leg, '0', note, function () { next(); });
        });
    }
    /** Never reveal my secret unless the counterparty locked ≥ req[0] of the right token. req=[amount, token]. */
    function amountTokenOk(req, gotHuman, tokenAddr, ethLeg) {
        try {
            if (Number(D.sub(gotHuman, req[0])) < 0) return false;   // they locked LESS than I asked
            var reqToken = req[1] || '';
            if (reqToken.indexOf('ETH:') === 0) reqToken = reqToken.slice(4);
            var t = String(tokenAddr).toLowerCase(), r = reqToken.toLowerCase();
            if (ethLeg) return r === t;
            return r === 'minima' || r === t;
        } catch (e) { return false; }
    }

    // ---- poll: Minima checks then ETH checks ----
    function poll(cb) {
        cb = F.once(cb || function () {});
        if (!ready()) return cb();
        H.currentBlock(function (e, block) {
            if (e) return cb();
            runMinimaChecks(block, function () {
                runEthChecks(block, function () {
                    // MAKER buy-take discovery (TAKE-sentinel handshakes → lock the mxUSDT counter-leg), if the
                    // responder is live on this instance (needs a published order); a no-op on a taker-only instance.
                    if (AX.responder && AX.responder.ready()) AX.responder.scanIncomingBuys(block, cb);
                    else cb();
                });
            });
        });
    }

    function activeSwaps(all) { return all.filter(function (s) { return s && s.status !== DB.ST_COMPLETE && s.status !== DB.ST_REFUNDED && s.status !== DB.ST_ERROR; }); }

    /**
     * RESPONDER SECRET HARVEST (native SwapEngine:515/1208): the maker never generates the secret — it is REVEALED
     * by the taker's Minima claim in the notify coin (state[100], hash in state[101]). For every active swap whose
     * secret is still unknown, scan the notify sink and insertSecret (idempotent, first-write-wins). Without this
     * the maker can never withdraw the taker's USDT counter-leg → guaranteed fund loss on every buy-take fill.
     */
    function harvestNotifySecrets(all, done) {
        var unknown = activeSwaps(all);
        F.each(unknown, function (s, i, nextS) {
            DB.getSecret(s.hash, function (e, secret) {
                if (e || secret) return nextS();
                H.scanNotifySecret(s.hash, NOTIFY_SCAN_DEPTH, function (err, coins) {
                    coins = coins || [];
                    var found = null;
                    for (var j = 0; j < coins.length; j++) {
                        var c = coins[j];
                        if (c && sameHash(H.stateAt(c, 101), s.hash) && H.stateAt(c, 100)) { found = H.stateAt(c, 100); break; }
                    }
                    if (!found) return nextS();
                    DB.insertSecret(s.hash, found, function () { nextS(); });
                });
            });
        }, done);
    }

    function runMinimaChecks(block, done) {
        DB.allSwaps(function (e, all) {
            if (e) return done();
            all = all || [];
            harvestNotifySecrets(all, function () {
            // BUY-claim discovery per hash (reliable — a coin I only RECEIVE can be missed by relevant:true).
            var claimHashes = all.filter(function (s) { return s && !s.myLegIsMinima && s.status !== DB.ST_COMPLETE && s.status !== DB.ST_REFUNDED && s.status !== DB.ST_ERROR; })
                .map(function (s) { return s.hash; });
            F.each(claimHashes, function (hash, i, nextH) {
                H.scanByHash(hash, 2, HTLC_SCAN_DEPTH, function (err, coins) {
                    coins = coins || [];
                    F.each(coins, function (coin, j, nextC) {
                        if (coin && isMyPublishKey(H.stateAt(coin, 4)) && sameHash(H.stateAt(coin, 5), hash)) checkCanSwapCoin(coin, block, nextC);
                        else nextC();
                    }, nextH);
                });
            }, function () {
                // REFUND discovery (my expired locks) + a claim backstop, bounded to MY key.
                H.scanByKey(C.myMinimaPk, 2, HTLC_SCAN_DEPTH, function (err, coins) {
                    coins = coins || [];
                    F.each(coins, function (coin, j, nextC) {
                        if (!coin) return nextC();
                        if (isMyPublishKey(H.stateAt(coin, 4))) checkCanSwapCoin(coin, block, nextC);   // locked to me → claim
                        else if (isMyPublishKey(H.stateAt(coin, 0))) checkExpiredMinima(coin, block, nextC);  // I locked → refund if expired
                        else nextC();
                    }, done);
                });
            });
            });   // close harvestNotifySecrets
        });
    }

    /** The tokenid of the currency a swap BOUGHT (from its buyToken label), for verifying the received coin. */
    function expectedTokenId(sw) {
        var lbl = sw && sw.buyToken;
        if (lbl === TR.MINIMA.coinLabel) return TR.MINIMA.tokenId;
        if (lbl === TR.MXUSDT.coinLabel) return TR.MXUSDT.tokenId;
        return TR.active().tokenId;
    }

    /** I am the receiver (state[4]) of a Minima HTLC coin and I hold the secret → claim it. */
    function checkCanSwapCoin(coin, block, next) {
        var hash = H.stateAt(coin, 5);
        if (!hash) return next();
        var reqTokenAddr = stripReqToken(H.stateAt(coin, 2));
        DB.getSecret(hash, function (e, secret) {
            if (e) return next();
            if (!secret) {   // no secret → I'm the maker responding to a taker SELLING mxUSDT to me (lock the ETH leg)
                if (AX.responder && AX.responder.ready()) return AX.responder.onSellTake(coin, block, next);
                return next();
            }
            // FUND-SAFETY: the coin locked to me MUST be the currency I'm buying — a taker's `reqToken` is the
            // currency-agnostic literal 'minima', so amountTokenOk can't catch a maker who locks a WORTHLESS coloured
            // token of the right AMOUNT. Verify the coin's OWN tokenid against the swap's buy-currency before revealing
            // my secret (an honest maker always locks the right token → no interop cost).
            DB.getSwap(hash, function (eS, sw) {
                var expTok = expectedTokenId(sw), got = String(coin.tokenid || '0x00').toLowerCase();
                if (got !== String(expTok).toLowerCase()) {
                    return logMismatchOnce(hash, 'minima', 'wrong token locked to me', next);
                }
                DB.getRequest(hash, function (e2, req) {
                    if (req && !amountTokenOk([req.reqAmount, req.reqToken], H.coinAmount(coin), reqTokenAddr, false)) {
                        return logMismatchOnce(hash, 'minima', 'counterparty amount/token mismatch', next);
                    }
                    DB.hasEvent(hash, DB.EV_COLLECT, function (e3, have) {
                        if (have || !ethRetryDue('claimM:' + hash)) return next();
                        markEthAttempt('claimM:' + hash);
                        DB.setSwapStatus(hash, DB.ST_CLAIMING, function () {
                            onChanged();
                            H.claim(coin, hash, secret, C.myMinimaAddr, function (eC, txpowid) {
                                if (eC) return next();          // leave the attempt stamp → retry after the window
                                DB.logEvent(hash, DB.EV_COLLECT, 'minima', H.coinAmount(coin), txpowid, function () {
                                    DB.setSwapStatus(hash, DB.ST_COMPLETE, function () {
                                        delete ethAttempt['claimM:' + hash];
                                        notify('Swap complete', 'Claimed ' + H.coinAmount(coin) + ' ' + TR.labelForToken(coin.tokenid || '0x00'));
                                        onChanged(); next();
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    }

    /** A coin I locked (owner state[0]) past its timelock → reclaim it. */
    function checkExpiredMinima(coin, block, next) {
        var timelock = Number(H.stateAt(coin, 3)) || 0;
        if (block <= timelock) return next();
        var hash = H.stateAt(coin, 5), key = 'refundM:' + hash;
        DB.hasEvent(hash, DB.EV_EXPIRED, function (e, have) {
            if (have || inflight[key]) return next();
            inflight[key] = true;
            H.refund(coin, C.myMinimaAddr, function (eR, txpowid) {
                if (eR) { delete inflight[key]; return next(); }
                DB.logEvent(hash, DB.EV_EXPIRED, 'minima', H.coinAmount(coin), txpowid, function () {
                    DB.setSwapStatus(hash, DB.ST_REFUNDED, function () {
                        delete inflight[key];
                        notify('Swap refunded', 'Timelock passed — reclaimed your ' + TR.labelForToken(coin.tokenid || '0x00'));
                        onChanged(); next();
                    });
                });
            });
        });
    }

    // ---- ETH side ----
    function runEthChecks(block, done) {
        DB.allSwaps(function (e, all) {
            if (e) return done();
            F.each(activeSwaps(all || []), function (s, i, next) { checkEthContractFor(s, next); }, done);
        });
    }

    /** RESPONDER SECRET HARVEST (native SwapEngine:814): a withdrawn ETH leg carries the revealed preimage IN the
     *  contract tuple — store it (idempotent) so the maker's Minima claim can fire. Without this the maker who
     *  locked USDT on a sell-take can never claim the taker's mxUSDT → guaranteed fund loss on every fill. cb(). */
    function harvestEthPreimage(hash, gc, cb) {
        try {
            if (gc && gc.preimage && AX.ethrpc.hexToBig(gc.preimage) !== 0n) {
                return DB.insertSecret(hash, gc.preimage, function () { cb(); });
            }
        } catch (e2) { }
        cb();
    }

    function checkEthContractFor(swap, next) {
        var hash = swap.hash, cid = EO.contractId(hash);
        ops().getContract(cid, function (e, gc) {
            if (e || !gc) return next();                    // the ETH leg isn't locked yet
            harvestEthPreimage(hash, gc, function () { checkEthContractBody(swap, hash, cid, gc, next); });
        });
    }
    function checkEthContractBody(swap, hash, cid, gc, next) {
            var myEth = String(C.ethAddr).toLowerCase();
            var iAmReceiver = gc.receiver && String(gc.receiver).toLowerCase() === myEth;
            var iAmSender = gc.owner && String(gc.owner).toLowerCase() === myEth;
            if (iAmReceiver) {
                if (gc.withdrawn) return confirmEthWithdrawn(hash, swap, next);   // AUTHORITATIVE: my claim settled
                if (gc.refunded) return finalizeEthLost(hash, next);             // counterparty refunded before I claimed
                DB.getSecret(hash, function (e2, secret) {
                    if (e2 || !secret) return next();
                    DB.getRequest(hash, function (e3, req) {
                        if (req) {
                            var gotHuman = D.formatUnits(gc.amount, decimalsOf(gc.tokenContract));
                            if (!amountTokenOk([req.reqAmount, req.reqToken], gotHuman, gc.tokenContract, true)) {
                                return logMismatchOnce(hash, 'ETH:' + gc.tokenContract, 'counterparty amount/token mismatch', next);
                            }
                        }
                        broadcastEthWithdraw(cid, hash, secret, next);
                    });
                });
            } else if (iAmSender) {
                if (gc.refunded) return confirmEthRefunded(hash, next);           // AUTHORITATIVE: my leg refunded
                if (gc.withdrawn) return next();                                  // maker claimed my USDT; my mxUSDT arrives via the Minima claim
                C.rpc.latestBlockTimestamp(function (eT, chainNow) {
                    var now = eT ? nowUnix() : chainNow;                          // chain time is what the vault enforces
                    if (now > gc.timelock) return broadcastEthRefund(cid, hash, next);
                    next();
                });
            } else next();
    }

    // F1: broadcast (retryable, ack-only) vs. confirmation (terminal, from the contract flag on a later cycle).
    function broadcastEthWithdraw(cid, hash, secret, next) {
        var key = 'wdEth:' + hash;
        if (!ethRetryDue(key) || inflight[key]) return next();
        inflight[key] = true; markEthAttempt(key);
        DB.setSwapStatus(hash, DB.ST_CLAIMING, function () {
            onChanged();
            // ETH_BUSY (the cross-instance lock deferred us) provably did NOT broadcast → clear the retry stamp so
            // the NEXT poll retries promptly instead of waiting out ETH_RETRY_SECS. Confirmed on-chain, not here.
            ops().withdraw(cid, secret, function (e) { if (e && e.busy) delete ethAttempt[key]; delete inflight[key]; next(); });
        });
    }
    function broadcastEthRefund(cid, hash, next) {
        var key = 'refundE:' + hash;
        if (!ethRetryDue(key) || inflight[key]) return next();
        inflight[key] = true; markEthAttempt(key);
        ops().refund(cid, function (e) { if (e && e.busy) delete ethAttempt[key]; delete inflight[key]; next(); });
    }

    function confirmEthWithdrawn(hash, swap, next) {
        delete ethAttempt['wdEth:' + hash];
        DB.getSwap(hash, function (e, cur) {
            if (cur && cur.status === DB.ST_COMPLETE) return next();
            finalize(hash, DB.EV_COLLECT, DB.ST_COMPLETE, function (have, cb2) {
                if (!have) DB.logEvent(hash, DB.EV_COLLECT, 'ETH', '', 'confirmed on-chain', cb2); else cb2();
            }, function () { notify('Swap complete', 'Withdrew your ' + (swap.buyToken || 'USDT')); onChanged(); next(); });
        });
    }
    function confirmEthRefunded(hash, next) {
        delete ethAttempt['refundE:' + hash];
        DB.getSwap(hash, function (e, cur) {
            if (cur && cur.status === DB.ST_REFUNDED) return next();
            finalize(hash, DB.EV_EXPIRED, DB.ST_REFUNDED, function (have, cb2) {
                if (!have) DB.logEvent(hash, DB.EV_EXPIRED, 'ETH', '', 'confirmed on-chain', cb2); else cb2();
            }, function () { notify('Swap refunded', 'Reclaimed your tokens'); onChanged(); next(); });
        });
    }
    /** The counterparty refunded the ETH leg I was to receive — this swap failed for me. Mark terminal ONCE. */
    function finalizeEthLost(hash, next) {
        DB.getSwap(hash, function (e, cur) {
            if (!cur || cur.status === DB.ST_ERROR || cur.status === DB.ST_REFUNDED || cur.status === DB.ST_COMPLETE) return next();
            DB.setSwapStatus(hash, DB.ST_ERROR, function () { onChanged(); next(); });
        });
    }
    // helper: log the terminal event (once) then set the terminal status.
    function finalize(hash, ev, status, logIfNeeded, done) {
        DB.hasEvent(hash, ev, function (e, have) {
            logIfNeeded(have, function () { DB.setSwapStatus(hash, status, function () { done(); }); });
        });
    }

    AX.settle = {
        configure: configure, ready: ready, poll: poll,
        amountTokenOk: amountTokenOk, stripReqToken: stripReqToken, decimalsOf: decimalsOf,
        _setNow: function (fn) { _now = fn; }, _reset: function () { ethAttempt = {}; inflight = {}; },
        ETH_RETRY_SECS: ETH_RETRY_SECS
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
