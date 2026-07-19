/**
 * responder — the MAKER's auto-responder: when a taker takes my published order I lock the counter-leg, a faithful
 * port of native SwapEngine's responder paths. TWO directions:
 *   • taker SELLS mxUSDT to me (their mxUSDT lock, receiver = my minima key, I don't hold the secret) → I pay USDT:
 *     acceptTakerSellMinima gate → lockEthCounterLeg (ETH newContract, chain-time+CP_SECS, STRICT clock).
 *   • taker BUYS mxUSDT from me (their USDT ETH lock, receiver = my eth; they announce the hash on the TAKE
 *     sentinel) → I give mxUSDT: acceptTakerBuyMinima gate → lockMinimaCounterLeg (lockFromCoins, block+CP_BLOCKS).
 *
 * FUND SAFETY (verbatim from native, the whole point of this module): the accept-guards are the boundary — auto-lock
 * ONLY if the take fits an enabled tranche of MY live ladder (per-take cap + price + minimum); the counter-leg
 * timelock anchors to CHAIN time STRICTLY (no device-clock fallback — a skew that inverts leg expiry is a loss);
 * record-before-broadcast + a persistent swap-row dedup so a lost txnpost can't double-lock (the mxUSDT leg has no
 * on-chain hash uniqueness); a burst cap + per-coin reservation so two concurrent takes never double-select a coin.
 * The OTC-deal path (state[7]=TRUE) is Phase 6 — skipped here.
 *
 * configure(ctx): { rpc, ethPriv, ethAddr, myMinimaPk, myMinimaAddr, myIdentity, getOrder(), notify?, onSwapsChanged? }.
 * getOrder() returns my current armSafe'd published order (or null if not live). Requires AX.swapdb, AX.htlc,
 * AX.ethops, AX.dec, AX.flow, AX.trading, AX.identity. Attaches to AX.responder.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var DB = AX.swapdb, H = AX.htlc, EO = AX.ethops, D = AX.dec, F = AX.flow, TR = AX.trading, ID = AX.identity;
    var SYM = AX.order.SYM;

    var CP_LOCK_BURST = 2, MAX_LOCK_COINS = 50, SCAN_DEPTH = 72;
    // incoming queue bounds: an announced hash whose USDT lock never appears can't be settled once the taker's own
    // TIMELOCK window is spent — drop it (else junk handshakes accumulate an eth_call per entry per poll, forever).
    var INCOMING_TTL_MS = 2 * AX.htlc.TIMELOCK_SECS * 1000, INCOMING_MAX = 128;
    var C = null, cpInFlight = {}, incoming = {};   // cpInFlight: hash → reserved coinids csv; incoming: hash → {h,t}
    var _now = function () { return Date.now(); };
    function nowUnix() { return Math.floor(_now() / 1000); }

    function configure(ctx) { C = ctx; }
    function ready() { return !!(C && C.rpc && C.ethPriv && C.ethAddr && C.myMinimaPk && C.myMinimaAddr); }
    function ops() { return EO.make(C.rpc, C.ethPriv, C.ethAddr); }
    function notify(t, b) { if (C && C.notify) C.notify(t, b); }
    function onChanged() { if (C && C.onSwapsChanged) C.onSwapsChanged(); }
    function myOrder() { return C && C.getOrder ? C.getOrder() : null; }
    function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
    function validPos(d) { return isFinite(d) && d > 0; }
    function pair(order) { return order && order.pairs ? order.pairs[SYM] : null; }
    /** Strict positive decimal-string check for ON-CHAIN state values that later reach BigInt parsing (parseUnits):
     *  a crafted non-numeric state[1] would otherwise throw inside an async MDS callback and wedge the poll loop. */
    function validDec(s) { return /^[0-9]+(\.[0-9]+)?$/.test(String(s == null ? '' : s).trim()); }

    // ============================ accept-guards (the fund-safety boundary) ============================
    /** Taker SELLS mxUSDT to me (they locked mxUSDT wanting USDT). Auto-lock only if it fits an enabled BID tranche:
     *  within the tranche cap AND the USDT I'd pay ≤ (mxUSDT received × tranche price), meeting my minimum. */
    function acceptTakerSellMinima(order, coin) {
        var p = pair(order);
        if (!p || !p.en) return false;
        var giveRaw = H.stateAt(coin, 1);                          // USDT they requested, I'd pay (ON-CHAIN, hostile)
        if (!validDec(giveRaw)) return false;                      // non-numeric → decline (never reach BigInt parse)
        var recvMinima = num(H.coinAmount(coin));                  // mxUSDT the taker locked, I receive
        var giveUsdt = num(giveRaw);
        if (recvMinima <= 0 || giveUsdt <= 0) return false;        // 0-request = malformed take, decline (gas waste)
        if (validPos(p.min) && recvMinima < p.min) return false;
        if (!p.bids.length) return validPos(p.sell) && giveUsdt <= recvMinima * p.sell;   // legacy scalar
        for (var i = 0; i < p.bids.length; i++) {
            var t = p.bids[i];
            if (!validPos(t.p) || !validPos(t.a)) continue;
            if (recvMinima > t.a) continue;                       // per-take cap
            if (giveUsdt <= recvMinima * t.p) return true;
        }
        return false;
    }
    /** Taker BUYS mxUSDT from me (they locked USDT wanting mxUSDT). Auto-lock only if it fits an enabled ASK tranche:
     *  within the cap AND the USDT I'd receive ≥ (mxUSDT given × tranche price), meeting my minimum. */
    function acceptTakerBuyMinima(order, c) {
        // REAL USDT ONLY: the ETH HTLC vault is multi-token, so a taker could lock a WORTHLESS ERC20 as the paying
        // leg. Native rejects this via pairFor(c.tokenContract) (its allowlist returns null for a non-USDT token);
        // this is the same gate lockEthCounterLeg + otcVerifyBuy already enforce — never drop it on the buy path.
        if (!c.tokenContract || String(c.tokenContract).toLowerCase() !== EO.NET.usdt.toLowerCase()) return false;
        var p = pair(order);
        if (!p || !p.en) return false;
        var giveMinima = num(D.formatUnits(c.requestAmount, 18));                 // mxUSDT I'd give
        var recvUsdt = num(D.formatUnits(c.amount, decimalsOf(c.tokenContract))); // USDT I'd receive
        if (giveMinima <= 0) return false;
        if (validPos(p.min) && giveMinima < p.min) return false;
        if (!p.asks.length) return validPos(p.buy) && recvUsdt >= giveMinima * p.buy;   // legacy scalar
        for (var i = 0; i < p.asks.length; i++) {
            var t = p.asks[i];
            if (!validPos(t.p) || !validPos(t.a)) continue;
            if (giveMinima > t.a) continue;                       // per-take cap
            if (recvUsdt >= giveMinima * t.p) return true;
        }
        return false;
    }
    function decimalsOf(tokenAddr) { return String(tokenAddr).toLowerCase() === EO.NET.usdt.toLowerCase() ? EO.NET.usdtDecimals : 18; }

    // ============================ Minima-leg discovery: a taker's SELL take ============================
    /** Called from settle.checkCanSwapCoin's secret-UNKNOWN branch: a mxUSDT coin locked to me that I can't claim
     *  (no secret) is a taker selling to me → lock the ETH counter-leg. Active-currency + not-OTC only. next(). */
    function onSellTake(coin, block, next) {
        if (!ready()) return next();
        var hash = H.stateAt(coin, 5), reqTokenAddr = stripReqToken(H.stateAt(coin, 2));
        if (!hash) return next();
        // active-currency token only (a stale take of the OTHER currency after a switch would misprice)
        if (String(TR.active().tokenId).toLowerCase() !== String(coin.tokenid || '0x00').toLowerCase()) return next();
        var timelock = Number(H.stateAt(coin, 3)) || 0;
        if (timelock - block < AX.htlc.CP_BLOCKS_CHECK) return next();            // first leg too close to expiry
        var otc = String(H.stateAt(coin, 7)).toUpperCase() === 'TRUE';
        DB.hasEvent(hash, DB.EV_CPSENT, function (e, sent) {
            if (sent) return next();
            DB.getSwap(hash, function (e2, existing) {
                if (existing) return next();                                     // persistent dedup (restart-proof)
                gateSell(coin, hash, reqTokenAddr, otc, function (ok) {          // OTC deal-match OR ladder-fit gate
                    if (!ok || cpBurstFull(hash)) return next();
                    reserveHash(hash, '');
                    lockEthCounterLeg(coin, hash, reqTokenAddr, next);
                });
            });
        });
    }
    /** The sell-take fund gate: an OTC lock must match an AGREED LP deal exactly; a ladder lock must fit my order. */
    function gateSell(coin, hash, reqTokenAddr, otc, cb) {
        if (otc) {
            if (!AX.otc || !AX.otc.ready()) return cb(false);
            return AX.otc.otcLpDeal(hash, function (deal) { cb(!!(deal && AX.otc.otcVerifySell(coin, deal, reqTokenAddr))); });
        }
        cb(!!myOrder() && acceptTakerSellMinima(myOrder(), coin));
    }

    /** [ETH] Lock the USDT counter-leg (now + CP_SECS, STRICT chain clock). Record-before-broadcast. next(). */
    function lockEthCounterLeg(coin, hash, reqTokenAddr, next) {
        var token = { address: EO.NET.usdt, decimals: EO.NET.usdtDecimals };
        if (String(reqTokenAddr).toLowerCase() !== token.address.toLowerCase()) { releaseHash(hash); return next(); }
        var o = ops();
        var tokenHuman = H.stateAt(coin, 1);                 // USDT the taker requested — what I lock
        var reqMinimaHuman = H.coinAmount(coin);             // mxUSDT they locked
        var receiverEth = H.stateAt(coin, 6);                // taker's ETH address (withdraws my USDT)
        // BELT (both gates route here): these are ON-CHAIN strings — a BigInt parse throw would escape the async
        // callback chain and wedge the poll loop, so decline malformed values instead of trusting the gate alone.
        var sellRaw, reqRaw;
        try { sellRaw = D.parseUnits(tokenHuman, token.decimals); reqRaw = D.parseUnits(reqMinimaHuman, 18); }
        catch (ePU) { releaseHash(hash); return next(); }
        if (sellRaw <= 0n) { releaseHash(hash); return next(); }
        ensureAllowance(o, token.address, sellRaw, function (eA, okA) {
            if (eA || !okA) { releaseHash(hash); return next(); }
            ethChainNowStrict(function (eT, chainNow) {
                if (eT) { releaseHash(hash); return next(); }   // no strict chain time → abort, retry next cycle
                var timelock = chainNow + Number(AX.htlc.CP_SECS);
                var swap = { hash: hash, role: 'RESPONDER', direction: 'MINIMA_TO_ERC20', sellToken: 'USDT',
                    sellAmount: tokenHuman, buyToken: TR.active().coinLabel, buyAmount: reqMinimaHuman,
                    counterparty: receiverEth, status: DB.ST_LOCKED, contractId: EO.contractId(hash),
                    myTimelock: timelock, myLegIsMinima: false };
                DB.upsertSwap(swap, function () {
                    onChanged();
                    o.newContract(C.myMinimaPk, receiverEth, hash, BigInt(timelock), token.address, sellRaw, reqRaw, false, function (eN, txhash) {
                        if (eN) {
                            // ETH_BUSY (cross-instance lock deferred us) PROVABLY didn't broadcast → drop the record-
                            // before-broadcast row so the next poll re-locks (the row would otherwise dedup us out).
                            if (eN.busy) return DB.deleteSwap(hash, function () { releaseHash(hash); next(); });
                            releaseHash(hash); return next();
                        }
                        DB.logEvent(hash, DB.EV_CPSENT, 'ETH:' + token.address, tokenHuman, txhash, function () {
                            notify('Locked your USDT', 'Waiting for the counterparty to reveal the secret');
                            releaseHash(hash); onChanged(); next();
                        });
                    });
                });
            });
        });
    }

    // ============================ ETH-leg discovery: a taker's BUY take (TAKE handshake) ============================
    /** Scan the TAKE sentinel for sealed hashlock announcements addressed to me, then process each. next(). */
    /** Queue an announced buy hashlock (from an OTC EXECUTE) for the next poll to process — an OTC LP has no ladder
     *  order but still must respond, so this path is independent of a published order. */
    /** Queue an announced hash. When FULL, evict the OLDEST scan entry (refusing new ones would let a 4h-TTL junk
     *  flood crowd out fresh legit takes, which are only visible in the sentinel scan ~1h). force=true (durable OTC
     *  re-arm, bounded by persisted EXECUTING deals) bypasses the cap so junk can never block an agreed deal. */
    function addIncoming(hash, force) {
        if (!hash) return;
        var k = normHash(hash);
        if (incoming[k]) return;                                              // keep first-seen stamp
        var keys = Object.keys(incoming);
        if (keys.length >= INCOMING_MAX && !force) {
            var oldest = null;
            for (var i = 0; i < keys.length; i++) { if (oldest == null || incoming[keys[i]].t < incoming[oldest].t) oldest = keys[i]; }
            delete incoming[oldest];
        }
        incoming[k] = { h: hash, t: _now() };
    }
    /** Drop queue entries whose USDT lock never appeared within the taker's own spendable window. */
    function pruneIncoming() {
        var now = _now();
        for (var k in incoming) { if (now - incoming[k].t > INCOMING_TTL_MS) delete incoming[k]; }
    }

    /** Re-seed `incoming` from persisted EXECUTING SELL OTC deals (native SwapEngine re-arm). The in-memory set is
     *  lost on a restart and may have been consumed by the OTHER instance (fg vs bg) whose onIncomingHash is a no-op,
     *  so re-derive from the durable OtcDb every poll — else a SELL OTC deal stalls (its USDT refunds at timelock). */
    function rearmOtc(cb) {
        if (!AX.otc || !AX.otc.allDeals) return cb();
        AX.otc.allDeals(function (e, deals) {
            (deals || []).forEach(function (d) {
                if (d.role === AX.otc.ROLE_LP && d.status === AX.otc.ST_EXECUTING && d.side === AX.otc.SELL && d.hash) addIncoming(d.hash, true);
            });
            cb();
        });
    }

    function scanIncomingBuys(block, next) {
        if (!ready()) return next();
        rearmOtc(function () { doScanIncoming(block, next); });
    }
    function doScanIncoming(block, next) {
        // Scan the TAKE sentinel for LADDER buy-take handshakes ONLY if I have a live published order + identity.
        // OTC buy-takes arrive as queued `incoming` hashes (from EXECUTE / rearmOtc) and are processed regardless.
        var doScan = C.myIdentity && myOrder();
        function processQueue() {
            pruneIncoming();
            var hashes = [];
            for (var k in incoming) hashes.push(incoming[k].h);
            if (!hashes.length) return next();
            // ETH chain time once per cycle for the half-window guard (the clock the vault enforces); device-clock
            // fallback on error only (native SwapEngine:942 parity — never worse than native, usually better).
            C.rpc.latestBlockTimestamp(function (eT, chainNow) {
                var ethNow = eT ? nowUnix() : chainNow;
                F.each(hashes, function (hash, j, nx) { processIncomingBuy(hash, block, ethNow, nx); }, next);
            });
        }
        if (!doScan) return processQueue();
        var addr = TR.active().takeAddr;
        AX.mds.cmd('coinnotify action:add address:' + addr, function () {
            AX.mds.cmd('coins simplestate:true order:desc depth:' + SCAN_DEPTH + ' address:' + addr, function (r) {
                var coins = (r && r.response instanceof Array) ? r.response : [];
                for (var i = 0; i < coins.length; i++) {
                    var blob = AX.htlc.stateAt(coins[i], 99);
                    if (!blob) continue;
                    try {
                        var opened = ID.openValid(C.myIdentity, String(blob).replace(/^0x/i, ''));
                        if (!opened) continue;
                        var msg = JSON.parse(AX.hex.utf8Decode(opened.plaintext));
                        if (msg && msg.hash && msg.to === C.myIdentity.publicId()) addIncoming(msg.hash);
                    } catch (e) { }
                }
                processQueue();
            });
        });
    }

    /** Find one announced buy's USDT lock by deterministic contractId, verify it's to me, run the responder path.
     *  ethNow = chain-time unix secs for the half-window guard (optional; falls back to the device clock). */
    function processIncomingBuy(hash, block, ethNow, next) {
        if (typeof ethNow === 'function') { next = ethNow; ethNow = nowUnix(); }   // legacy 3-arg callers
        DB.getSwap(hash, function (e, existing) {
            if (existing) { delete incoming[normHash(hash)]; return next(); }
            DB.hasEvent(hash, DB.EV_CPSENT, function (e2, sent) {
                if (sent) { delete incoming[normHash(hash)]; return next(); }
                ops().getContract(EO.contractId(hash), function (e3, c) {
                    if (e3 || !c) return next();                              // USDT lock not visible yet → retry (TTL-pruned)
                    if (c.withdrawn || c.refunded) { delete incoming[normHash(hash)]; return next(); }
                    if (!c.receiver || String(c.receiver).toLowerCase() !== String(C.ethAddr).toLowerCase()) return next();  // foreign/stale
                    if (c.timelock - ethNow < Number(AX.htlc.CP_SECS_CHECK)) return next();   // their USDT lock too close to timeout
                    gateBuy(c, hash, !!c.otc, function (ok) {   // OTC deal-match OR ladder-fit gate
                        if (!ok || cpBurstFull(hash)) return next();
                        lockMinimaCounterLeg(c, block, next);
                    });
                });
            });
        });
    }

    /** The buy-take fund gate: an OTC lock must match an AGREED LP deal exactly; a ladder lock must fit my order. */
    function gateBuy(c, hash, otc, cb) {
        if (otc) {
            if (!AX.otc || !AX.otc.ready()) return cb(false);
            return AX.otc.otcLpDeal(hash, function (deal) { cb(!!(deal && AX.otc.otcVerifyBuy(c, deal))); });
        }
        cb(!!myOrder() && acceptTakerBuyMinima(myOrder(), c));
    }

    /** [Minima] Lock the mxUSDT counter-leg (block + CP_BLOCKS) from largest-first reserved coins. next(). */
    function lockMinimaCounterLeg(c, block, next) {
        var hash = c.hashlock, timelock = block + Number(AX.htlc.CP_BLOCKS);
        var reqMinimaHuman = D.formatUnits(c.requestAmount, 18);    // mxUSDT they want from me
        var receiverPubkey = c.minimaPublicKey;
        var actTok = TR.active().tokenId;
        H.myFreeCoins(actTok, function (e, coins) {
            if (e) return next();
            var picked = selectCoins(coins, reqMinimaHuman);
            if (!picked.ids.length) {
                notify('Buy request declined', 'Not enough free ' + TR.active().coinLabel + ' to fill ' + reqMinimaHuman);
                return next();
            }
            reserveHash(hash, picked.ids.join(','));
            var swap = { hash: hash, role: 'RESPONDER', direction: 'ERC20_TO_MINIMA', sellToken: TR.active().coinLabel,
                sellAmount: reqMinimaHuman, buyToken: 'USDT', buyAmount: D.formatUnits(c.amount, decimalsOf(c.tokenContract)),
                counterparty: receiverPubkey, status: DB.ST_LOCKED, contractId: c.contractId,
                myTimelock: timelock, myLegIsMinima: true };
            DB.upsertSwap(swap, function () {
                onChanged();
                H.lockFromCoins({ coinids: picked.ids, totalSelected: picked.sum, amount: reqMinimaHuman,
                    requestAmount: reqMinimaHuman, reqToken: 'minima', receiverPubkey: receiverPubkey, ownerEthKey: C.ethAddr,
                    hashlock: hash, timelockBlock: timelock, otc: 'FALSE', myPubkey: C.myMinimaPk, tokenId: actTok, myAddress: C.myMinimaAddr },
                function (eL, txpowid) {
                    if (eL) {
                        // a build failure (no POSTED: tag) provably didn't broadcast → drop the row so it can retry
                        if (String(eL.message).indexOf('POSTED:') !== 0) DB.deleteSwap(hash, function () {});
                        releaseHash(hash); return next();
                    }
                    DB.logEvent(hash, DB.EV_CPSENT, 'minima', reqMinimaHuman, txpowid, function () {
                        delete incoming[normHash(hash)];
                        notify('Locked your ' + TR.active().coinLabel, 'Waiting for the counterparty to reveal the secret');
                        releaseHash(hash); onChanged(); next();   // coin freed on confirm elsewhere; row is the durable dedup
                    });
                });
            });
        });
    }

    /** Largest-first coin selection totalling ≥ need, skipping coins reserved by other in-flight locks. */
    function selectCoins(coins, needHuman) {
        var used = {};
        for (var k in cpInFlight) { var v = cpInFlight[k]; if (v) v.split(',').forEach(function (u) { if (u) used[u] = 1; }); }
        var pool = [];
        for (var i = 0; i < coins.length; i++) {
            var cid = coins[i].coinid, amt = H.coinAmount(coins[i]);
            if (!cid || used[cid]) continue;
            pool.push({ id: cid, amt: amt });
        }
        pool.sort(function (a, b) { return Number(b.amt) - Number(a.amt); });   // largest-first → fewest inputs
        var ids = [], sum = '0';
        for (var m = 0; m < pool.length && ids.length < MAX_LOCK_COINS; m++) {
            ids.push(pool[m].id); sum = addDec(sum, pool[m].amt);
            if (Number(D.sub(sum, needHuman)) >= 0) return { ids: ids, sum: sum };   // covered need
        }
        return { ids: [], sum: '0' };   // can't cover need in one tx
    }
    function addDec(a, b) { return D.sub(a, D.sub('0', b)); }   // a + b via a - (0 - b)

    // ---- burst + reservation ----
    function cpBurstFull(hash) { return Object.keys(cpInFlight).length >= CP_LOCK_BURST && !(hash in cpInFlight); }
    function reserveHash(hash, coinCsv) { cpInFlight[hash] = coinCsv || ''; }
    function releaseHash(hash) { delete cpInFlight[hash]; }
    function normHash(h) { return String(h).replace(/^0x/i, '').toLowerCase(); }
    function stripReqToken(raw) { if (!raw) return ''; var s = String(raw); if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') s = s.slice(1, -1); if (s.indexOf('ETH:') === 0) s = s.slice(4); return s; }

    // ---- non-blocking allowance gate (F4 zero-first) — the SINGLE shared copy in AX.ethops (one pending map
    // for engine + responder, so the two callers can't each fire a duplicate MAX approve). ----
    function ensureAllowance(o, token, needed, cb) { EO.ensureAllowance(o, token, needed, cb); }

    /** CHAIN time for the counter-leg — STRICT (no device-clock fallback). cb(err, unixSecs). Rejects a >24h skew. */
    function ethChainNowStrict(cb) {
        C.rpc.latestBlockTimestamp(function (e, chain) {
            if (e) return cb(e);
            if (Math.abs(chain - nowUnix()) > 24 * 60 * 60) return cb(new Error('chain/device clock skew too large'));
            cb(null, chain);
        });
    }

    AX.responder = {
        configure: configure, ready: ready,
        acceptTakerSellMinima: acceptTakerSellMinima, acceptTakerBuyMinima: acceptTakerBuyMinima,
        onSellTake: onSellTake, scanIncomingBuys: scanIncomingBuys, processIncomingBuy: processIncomingBuy, addIncoming: addIncoming,
        _reset: function () { cpInFlight = {}; incoming = {}; EO._resetApprovals(); }, _setNow: function (fn) { _now = fn; EO._setNow(fn); },
        _selectCoins: selectCoins, _incoming: function () { return incoming; }, pruneIncoming: pruneIncoming,
        CP_LOCK_BURST: CP_LOCK_BURST, INCOMING_TTL_MS: INCOMING_TTL_MS, INCOMING_MAX: INCOMING_MAX
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
