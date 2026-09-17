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
    /** REFUND discovery only. `coins depth:` is a walk-back over BLOCKS from the tip, so at 256 a coin I locked
     *  went invisible ~3h33m after creation — while the responder leg becomes refundable just 36 blocks in. Miss
     *  that window and the coin was stranded for good. 1024 is the practical ceiling
     *  (MINIMA_CASCADE_START_DEPTH: past it the tree cascades and there is no parent to walk), which is why the
     *  sweep also asks for MegaMMR. The hot path keeps 256 — this is used only by the per-hash expired sweep. */
    var REFUND_SCAN_DEPTH = 1024;
    var C = null, ethAttempt = {}, inflight = {};
    /** Last failure message reported per claim/refund key — one event row + one notification per DISTINCT
     *  reason, not one per attempt (a two-hour claim window is ~45 attempts). Cleared on success. */
    var lastFail = {};
    var _now = function () { return Date.now(); };
    function nowUnix() { return Math.floor(_now() / 1000); }

    function configure(ctx) { C = ctx; }
    function ready() { return !!(C && C.rpc && C.ethPriv && C.ethAddr && C.myMinimaPk && C.myMinimaAddr); }
    function ops() { return EO.make(C.rpc, C.ethPriv, C.ethAddr); }
    function notify(t, b) { if (C && C.notify) C.notify(t, b); }
    function log(s) { try { if (g.MDS && g.MDS.log) g.MDS.log(s); } catch (e) { } }
    /**
     * A claim/refund attempt failed. This used to be `if (err) return next();` — no log line, no event, no
     * notification, no status change — and on 2026-09-15 that hid ~45 consecutive failures of a 5 mxUSDT claim
     * for two hours, until the counterparty refunded at the timelock and kept both sides (the node had lost the
     * covenant's script row; every attempt was refused by txncheck; the reason was discarded each time).
     *   - log the full error + txncheck verdict on EVERY attempt (the node log is the operator's record);
     *   - write ONE event row per distinct reason (the Activity row and the Check report read it);
     *   - notify on the first failure and whenever the reason changes — the user had two hours to act;
     *   - when the cause was ours to fix (covenant re-registered) or the transport (RPC timeout), make the retry
     *     stamp due on the NEXT poll instead of after ETH_RETRY_SECS. A genuine rejection keeps the window.
     */
    function reportFailure(kind, hash, coin, err, next) {
        var msg = String((err && err.message) || err), key = (kind === 'claim' ? 'claimM:' : 'refundM:') + hash;
        var detail = err && err.detail ? ' ' + JSON.stringify(err.detail) : '';
        log('[AtomiX] ' + kind.toUpperCase() + ' FAILED ' + hash + (err && err.step ? ' at ' + err.step : '') + ': ' + msg + detail);
        // Due again in 1s — i.e. on the NEXT poll, not a second attempt by the other scan path in this pass.
        if (err && (err.code === 'SCRIPT_MISSING' || /RPC timeout|ECONN|timed out/i.test(msg))) ethAttempt[key] = nowUnix() - ETH_RETRY_SECS + 1;
        if (lastFail[key] === msg) return next();
        lastFail[key] = msg;
        var ev = kind === 'claim' ? DB.EV_MINIMA_CLAIM_FAILED : DB.EV_MINIMA_REFUND_FAILED;
        DB.logEvent(hash, ev, (coin && coin.tokenid) || '0x00', H.coinAmount(coin), msg, function () {
            notify('AtomiX ' + kind + ' failing', msg + ' — retrying automatically. Swap ' + hash);
            onChanged(); next();
        });
    }
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
                confirmPendingMinima(function () {
                runEthChecks(block, function () {
                    // MAKER buy-take discovery (TAKE-sentinel handshakes → lock the mxUSDT counter-leg), if the
                    // responder is live on this instance (needs a published order); a no-op on a taker-only instance.
                    if (AX.responder && AX.responder.ready()) AX.responder.scanIncomingBuys(block, cb);
                    else cb();
                });
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
                    // Candidate preimages: every notify coin whose state[101] matches this hashlock and carries a
                    // state[100]. The NOTIFY sink is ANYONE-CAN-WRITE, so we must NOT trust the first match — we
                    // VERIFY each candidate hashes to the lock (SHA2) and pin the first VALID one. insertSecret is
                    // first-write-wins, so pinning a forged preimage here would permanently block MY claim (fund loss).
                    var cands = [];
                    for (var j = 0; j < coins.length; j++) {
                        var c = coins[j];
                        if (c && sameHash(H.stateAt(c, 101), s.hash) && H.stateAt(c, 100)) cands.push(H.stateAt(c, 100));
                    }
                    (function tryCand(k) {
                        if (k >= cands.length) return nextS();          // no valid preimage revealed yet
                        H.verifyPreimage(cands[k], s.hash, function (ve, ok) {
                            if (ok) return DB.insertSecret(s.hash, cands[k], function () { nextS(); });
                            tryCand(k + 1);                              // forged/garbage preimage → keep scanning
                        });
                    })(0);
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
            // DEEP, like the refund sweep: the secret is revealed on the COUNTERPARTY's schedule, so by the time
            // it arrives the counter-coin can be older than the shallow walk-back — the shallow scan then finds
            // nothing forever and the swap freezes in CLAIMING with the funds claimable on-chain (the claim-side
            // twin of the stranded-refund bug the deep sweep already fixes; native parity: atomix 0.1.17).
            // Throttled HARD: the deep scan is a heavy per-hash node query (coinnotify + 1024-block walk) and
            // the node runs commands on ONE thread — unthrottled per-poll scans for several pending claims
            // build a backlog that outlives every callback timeout and nothing settles. ONE scan per cycle,
            // one per hash per ETH_RETRY_SECS window, round-robin across hashes (native parity: atomix 0.1.17).
            var claimHashes = all.filter(function (s) {
                if (!s || s.myLegIsMinima) return false;
                if (s.status === DB.ST_COMPLETE || s.status === DB.ST_REFUNDED || s.status === DB.ST_ERROR) return false;
                // ZOMBIE-SCAN REAPER (0.1.21, native SwapEngine parity): an ERC20→mxUSDT INITIATOR past its own ETH
                // refund window can never still claim the shorter mxUSDT counter-leg; if that leg's refund never
                // CONFIRMED on-chain the swap stays non-terminal and claimScan polls its dead hash forever.
                // Membership only, no fund decision. Scoped to this role+direction (a MINIMA_TO_ERC20 RESPONDER's
                // mxUSDT claim stays live ~2h, so a blanket cutoff would strand it).
                if (s.role === 'INITIATOR' && s.direction === 'ERC20_TO_MINIMA' && s.myTimelock > 0 && nowUnix() > s.myTimelock) return false;
                return true;
            }).map(function (s) { return s.hash; });
            var dueClaim = null;
            for (var ci = 0; ci < claimHashes.length; ci++) {
                if (ethRetryDue('claimScan:' + claimHashes[ci])) { dueClaim = claimHashes[ci]; break; }
            }
            if (dueClaim) markEthAttempt('claimScan:' + dueClaim);
            F.each(dueClaim ? [dueClaim] : [], function (hash, i, nextH) {
                H.scanByHashDeep(hash, 2, REFUND_SCAN_DEPTH, function (err, coins) {
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
                    }, function () {
                        // The scan above reaches only HTLC_SCAN_DEPTH blocks back, so it stops finding my own
                        // expired locks long before they stop being refundable. Drive those from the DB, which
                        // has no depth window — exactly as the ETH side already does.
                        sweepExpiredMinima(all, block, done);
                    });
                });
            });
            });   // close harvestNotifySecrets
        });
    }

    /** The tokenid of the currency a swap BOUGHT (from its buyToken label), for verifying the received coin.
     *  Uses the one canonical label -> market map so the legacy mxUSDT spelling attributes too. */
    function expectedTokenId(sw) {
        var c = sw ? TR.forCoinLabel(sw.buyToken) : null;
        return c ? c.tokenId : TR.active().tokenId;
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
                                if (eC) return reportFailure('claim', hash, coin, eC, next);   // stamp stays unless reportFailure clears it
                                delete lastFail['claimM:' + hash];
                                DB.logEvent(hash, DB.EV_MINIMA_CLAIM_SUBMITTED, coin.tokenid || '0x00', H.coinAmount(coin), txpowid, function () {
                                    onChanged(); next();
                                });
                            });
                        });
                    });
                });
            });
        });
    }

    /** REFUND backstop, driven from the DB rather than a bounded chain scan.
     *
     *  Refund eligibility used to be decided by the same shallow scan that found the coin, so a lock older than
     *  HTLC_SCAN_DEPTH blocks became permanently unrefundable — discovery and eligibility were tied together.
     *  `swaps` records every leg I locked and its absolute timelock, so eligibility is decided WITHOUT the chain.
     *  Only a swap already known to be past its timelock costs a node command, and then per-hash and deep. */
    function sweepExpiredMinima(all, block, done) {
        var due = (all || []).filter(function (s) {
            return s && s.hash && s.myLegIsMinima
                && s.status !== DB.ST_COMPLETE && s.status !== DB.ST_REFUNDED
                && s.myTimelock > 0 && block > s.myTimelock
                && ethRetryDue('refundM:' + s.hash) && ethRetryDue('refundScan:' + s.hash);      // same window as the refund itself
        });
        due.sort(function (a, b) { return (ethAttempt['refundScan:' + a.hash] || 0) - (ethAttempt['refundScan:' + b.hash] || 0); });
        F.each(due.slice(0, 1), function (s, i, nextS) {
            markEthAttempt('refundScan:' + s.hash);
            DB.hasEvent(s.hash, DB.EV_EXPIRED, function (e, have) {
                if (have) return nextS();
                H.scanByHashDeep(s.hash, 2, REFUND_SCAN_DEPTH, function (err, coins) {
                    F.each(coins || [], function (coin, j, nextC) {
                        if (coin && isMyPublishKey(H.stateAt(coin, 0)) && sameHash(H.stateAt(coin, 5), s.hash))
                            checkExpiredMinima(coin, block, nextC);
                        else nextC();
                    }, nextS);
                });
            });
        }, done);
    }

    /** A coin I locked (owner state[0]) past its timelock → reclaim it. */
    function checkExpiredMinima(coin, block, next) {
        var rawTimelock = H.stateAt(coin, 3), timelock = Number(rawTimelock);
        if (!/^[0-9]+$/.test(String(rawTimelock)) || !isFinite(timelock) || timelock > 2147483647 || block <= timelock) return next();
        var hash = H.stateAt(coin, 5), key = 'refundM:' + hash;
        DB.hasEvent(hash, DB.EV_EXPIRED, function (e, have) {
            // SELF-HEALING gate, as on the claim path. The old guard was a bare `inflight[key] = true` cleared
            // only inside the post callback, so a callback that never arrived held it forever and the refund
            // NEVER retried. A timestamp cannot leak: a lost callback costs one ETH_RETRY_SECS window.
            if (have || !ethRetryDue(key)) return next();
            markEthAttempt(key);
            H.refund(coin, C.myMinimaAddr, function (eR, txpowid) {
                if (eR) return reportFailure('refund', hash, coin, eR, next);   // stamp stays unless reportFailure clears it
                delete lastFail[key];
                DB.logEvent(hash, DB.EV_MINIMA_REFUND_SUBMITTED, coin.tokenid || '0x00', H.coinAmount(coin), txpowid, function () {
                    onChanged(); next();
                });
            });
        });
    }

    function confirmPendingMinima(done) {
        DB.allSwaps(function (err, swaps) {
            if (err) return done();
            var selected = null, oldest = Infinity;
            F.each(swaps || [], function (s, i, next) {
                if (!s || s.status === DB.ST_COMPLETE || s.status === DB.ST_REFUNDED) return next();
                DB.getEvents(s.hash, function (e, events) {
                    (events || []).forEach(function (r) {
                        if (r.event !== DB.EV_MINIMA_CLAIM_SUBMITTED && r.event !== DB.EV_MINIMA_REFUND_SUBMITTED) return;
                        if (!/^0x[0-9a-f]{64}$/i.test(String(r.note))) return;
                        var key = 'receiptM:' + r.note, at = ethAttempt[key] || 0;
                        if (ethRetryDue(key) && at < oldest) { oldest = at; selected = { hash: s.hash, receipt: r, key: key }; }
                    });
                    next();
                });
            }, function () {
                if (!selected) return done();
                var r = selected.receipt, hash = selected.hash, refund = r.event === DB.EV_MINIMA_REFUND_SUBMITTED;
                markEthAttempt(selected.key);
                H.confirmationDepth(r.note, function (e, depth) {
                    if (e || depth < 2) return done();
                    DB.getSwap(hash, function (eS, s) {
                        if (eS || !s || s.status === DB.ST_COMPLETE || s.status === DB.ST_REFUNDED) return done();
                        DB.setSwapStatus(hash, refund ? DB.ST_REFUNDED : DB.ST_COMPLETE, function (eW) {
                            if (eW) return done();
                            DB.logEvent(hash, refund ? DB.EV_EXPIRED : DB.EV_COLLECT, 'minima', r.amount, r.note, function () {
                                delete ethAttempt[(refund ? 'refundM:' : 'claimM:') + hash];
                                notify(refund ? 'Swap refunded' : 'Swap complete', (refund ? 'Reclaimed ' : 'Claimed ') + r.amount + ' ' + TR.labelForToken(r.token) + ' — confirmed on-chain');
                                onChanged(); done();
                            });
                        });
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
                // Defence-in-depth: the ETH tuple comes from a single public RPC — verify the preimage hashes to
                // the lock before pinning, so a fabricated getContract can't poison the store.
                return H.verifyPreimage(gc.preimage, hash, function (ve, ok) {
                    if (ok) return DB.insertSecret(hash, gc.preimage, function () { cb(); });
                    cb();
                });
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
                if (gc.withdrawn) return checkMinimaLost(swap, hash, next);       // they hold my USDT: my mxUSDT arrives via the Minima claim — or never
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
    /** A human reason a swap refunded (0.1.21, native parity; role-aware since 0.1.24): prefer a stored
     *  EV_MISMATCH note; else by role — an INITIATOR's leg refunds because the counterparty never locked, a
     *  RESPONDER's counter-leg because the counterparty locked but never claimed (proven live 2026-08-27: a
     *  first-time buyer locked 438 USDT, never claimed the matching mxUSDT counter-leg, and the bare
     *  "Timelock passed" left the operator diagnosing on-chain). Returns the bare clause — callers prefix.
     *  Async (DB.getEvents + DB.getSwap). Read-only; no fund decision. */
    function refundReason(hash, cb) {
        DB.getEvents(hash, function (e, evs) {
            var m = null;
            (evs || []).forEach(function (ev) { if (!m && ev.event === DB.EV_MISMATCH && ev.note) m = ev.note; });
            if (m) return cb(m);
            DB.getSwap(hash, function (e2, sw) {
                cb(sw && sw.role === 'RESPONDER'
                    ? 'the counterparty locked their side but never claimed yours before the timeout'
                    : 'the counterparty never locked their side before the timeout');
            });
        });
    }
    function confirmEthRefunded(hash, next) {
        delete ethAttempt['refundE:' + hash];
        DB.getSwap(hash, function (e, cur) {
            if (cur && cur.status === DB.ST_REFUNDED) return next();
            finalize(hash, DB.EV_EXPIRED, DB.ST_REFUNDED, function (have, cb2) {
                if (!have) DB.logEvent(hash, DB.EV_EXPIRED, 'ETH', '', 'confirmed on-chain', cb2); else cb2();
            }, function () { refundReason(hash, function (reason) { notify('Swap refunded', 'Reclaimed your tokens — ' + reason); onChanged(); next(); }); });
        });
    }
    /** The counterparty refunded the ETH leg I was to receive — this swap failed for me. Mark terminal ONCE. */
    function finalizeEthLost(hash, next) {
        DB.getSwap(hash, function (e, cur) {
            if (!cur || cur.status === DB.ST_ERROR || cur.status === DB.ST_REFUNDED || cur.status === DB.ST_COMPLETE) return next();
            var note = 'counterparty refunded their ' + cur.buyAmount + ' ' + cur.buyToken + ' leg before you claimed it'
                + (cur.myLegIsMinima ? ' — your ' + cur.sellAmount + ' ' + cur.sellToken + ' lock is refundable at its timelock' : '');
            finalize(hash, DB.EV_LOST, DB.ST_ERROR, function (have, cb2) {
                if (!have) DB.logEvent(hash, DB.EV_LOST, 'ETH', cur.buyAmount, note, cb2); else cb2();
            }, function () { notify('Swap FAILED', note + '. Swap ' + hash); onChanged(); next(); });
        });
    }
    /**
     * The counterparty withdrew my ETH leg (they hold my USDT and revealed the secret) and my Minima claim never
     * confirmed. Once their coin is GONE and its timelock has passed, they reclaimed it and this swap is lost for
     * me — say so ONCE (ST_ERROR + SWAP_LOST + notify) instead of "claiming" forever. 2026-09-15: the row read
     * CLAIMING for two days after the loss, with nothing left to claim. Decision inputs, all read-only: no
     * COLLECT, no RECENT claim submission (a confirmed late claim still flips ERROR → COMPLETE via
     * confirmPendingMinima), no open coin for the hash in the deep scan, and the block past the leg's timelock —
     * from the market collector's row for the hash, or, if it never observed the lock, a bounded fallback: four
     * hours past my own ETH timelock, by when any 144-block Minima leg has long expired. Throttled per hash. */
    var LOST_FALLBACK_SECS = 4 * 3600, RECENT_SUBMIT_MS = 30 * 60 * 1000;
    function checkMinimaLost(swap, hash, next) {
        if (!swap || swap.myLegIsMinima) return next();
        var key = 'lostM:' + hash;
        if (!ethRetryDue(key)) return next();
        markEthAttempt(key);
        DB.hasEvent(hash, DB.EV_COLLECT, function (e, collected) {
            if (e || collected) return next();
            DB.getEvents(hash, function (e2, evs) {
                if (e2) return next();
                var recentSubmit = (evs || []).some(function (r) { return r.event === DB.EV_MINIMA_CLAIM_SUBMITTED && (_now() - Number(r.date || 0)) < RECENT_SUBMIT_MS; });
                if (recentSubmit) return next();
                H.currentBlock(function (e3, block) {
                    if (e3) return next();
                    H.scanByHashDeep(hash, 2, REFUND_SCAN_DEPTH, function (e4, coins) {
                        if (e4) return next();
                        var open = (coins || []).some(function (c) { return c && isMyPublishKey(H.stateAt(c, 4)) && sameHash(H.stateAt(c, 5), hash); });
                        if (open) return next();                       // still claimable — the claim path owns it
                        DB.tradeByHash(hash, function (e5, t) {
                            var expired = (t && t.timelock > 0) ? block > t.timelock
                                : (swap.myTimelock > 0 && nowUnix() > swap.myTimelock + LOST_FALLBACK_SECS);
                            if (!expired) return next();
                            finalizeMinimaLost(hash, next);
                        });
                    });
                });
            });
        });
    }
    function finalizeMinimaLost(hash, next) {
        DB.getSwap(hash, function (e, cur) {
            if (!cur || cur.status === DB.ST_ERROR || cur.status === DB.ST_REFUNDED || cur.status === DB.ST_COMPLETE) return next();
            var note = 'counterparty withdrew your ' + cur.sellAmount + ' ' + cur.sellToken + ' and reclaimed their '
                + cur.buyAmount + ' ' + cur.buyToken + ' at the timelock — our claim never posted';
            finalize(hash, DB.EV_LOST, DB.ST_ERROR, function (have, cb2) {
                if (!have) DB.logEvent(hash, DB.EV_LOST, 'minima', cur.buyAmount, note, cb2); else cb2();
            }, function () { notify('Swap FAILED', note + '. Swap ' + hash); onChanged(); next(); });
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
        _setNow: function (fn) { _now = fn; }, _reset: function () { ethAttempt = {}; inflight = {}; lastFail = {}; },
        ETH_RETRY_SECS: ETH_RETRY_SECS
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
