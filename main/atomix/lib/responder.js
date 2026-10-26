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
    // decline reporting (native 0.1.84): takerOf = normHash → the taker's AUTHENTICATED comms id from the sealed
    // handshake (where a notice goes back to); noticesSent = normHash → count (each notice is a signed send).
    var takerOf = {}, noticesSent = {}, MAX_NOTICES_PER_HASH = 3;
    var _now = function () { return Date.now(); };
    function nowUnix() { return Math.floor(_now() / 1000); }

    function configure(ctx) { C = ctx; }
    // HALTED (identitywatch): the responder is the ONE place this dapp commits fresh money against someone
    // else's lock, so the halt lands here — both onSellTake and scanIncomingBuys go through ready(). Settlement
    // of swaps already in flight is deliberately NOT gated: freezing that is how funds got stranded.
    function ready() {
        if (AX.identitywatch && AX.identitywatch.halted()) return false;
        return !!(C && C.rpc && C.ethPriv && C.ethAddr && C.myMinimaPk && C.myMinimaAddr);
    }
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
    /** EXACT decimal compare of a vs b×c (-1/0/1). The accept-gates compared the taker's requested amount against
     *  amount×price as a DOUBLE product, and 44.4×0.99 = 43.955999999999996 < the exactly-priced 43.956 the taker
     *  (native, BigDecimal) computed — so a take sitting exactly ON the published price was silently declined every
     *  poll until it refunded at timelock (live 2026-10-05). Exactly-priced takes are the COMMON case, not an edge.
     *  Scaled-BigInt compare, exact at any length; a non-plain-decimal input (scientific notation) falls back to
     *  the old float compare, which is never worse than before. */
    function cmpAmtMul(a, b, c) {
        var re = /^[0-9]+(\.[0-9]+)?$/, as = String(a).trim(), bs = String(b).trim(), cs = String(c).trim();
        if (!re.test(as) || !re.test(bs) || !re.test(cs)) {
            var f = num(a) - num(b) * num(c); return f < 0 ? -1 : f > 0 ? 1 : 0;
        }
        function parse(s) { var i = s.indexOf('.'); return i < 0 ? [BigInt(s), 0] : [BigInt(s.slice(0, i) + s.slice(i + 1)), s.length - i - 1]; }
        var A = parse(as), B = parse(bs), C2 = parse(cs);
        var av = A[0], bv = B[0] * C2[0], d = A[1] - (B[1] + C2[1]);
        if (d < 0) av *= 10n ** BigInt(-d); else bv *= 10n ** BigInt(d);
        return av < bv ? -1 : av > bv ? 1 : 0;
    }

    // ============================ accept-guards (the fund-safety boundary) ============================
    /** Taker SELLS mxUSDT to me (they locked mxUSDT wanting USDT). Auto-lock only if it fits an enabled BID tranche:
     *  within the tranche cap AND the USDT I'd pay ≤ (mxUSDT received × tranche price), meeting my minimum. */
    function acceptTakerSellMinima(order, coin) {
        var p = pair(order);
        if (!p || !p.en) return false;
        var giveRaw = H.stateAt(coin, 1);                          // USDT they requested, I'd pay (ON-CHAIN, hostile)
        if (!validDec(giveRaw)) return false;                      // non-numeric → decline (never reach BigInt parse)
        var recvRaw = H.coinAmount(coin);                          // mxUSDT the taker locked, I receive
        var recvMinima = num(recvRaw);
        var giveUsdt = num(giveRaw);
        if (recvMinima <= 0 || giveUsdt <= 0) return false;        // 0-request = malformed take, decline (gas waste)
        if (validPos(p.min) && recvMinima < p.min) return false;
        if (!p.bids.length) return validPos(p.sell) && cmpAmtMul(giveRaw, recvRaw, p.sell) <= 0;   // legacy scalar
        for (var i = 0; i < p.bids.length; i++) {
            var t = p.bids[i];
            if (!validPos(t.p) || !validPos(t.a)) continue;
            if (recvMinima > t.a) continue;                       // per-take cap
            if (cmpAmtMul(giveRaw, recvRaw, t.p) <= 0) return true;   // EXACT: I pay ≤ received × price
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
        var giveRaw = D.formatUnits(c.requestAmount, 18);                 // mxUSDT I'd give
        var recvRaw = D.formatUnits(c.amount, decimalsOf(c.tokenContract)); // USDT I'd receive
        var giveMinima = num(giveRaw);
        if (giveMinima <= 0) return false;
        if (validPos(p.min) && giveMinima < p.min) return false;
        if (!p.asks.length) return validPos(p.buy) && cmpAmtMul(recvRaw, giveRaw, p.buy) >= 0;   // legacy scalar
        for (var i = 0; i < p.asks.length; i++) {
            var t = p.asks[i];
            if (!validPos(t.p) || !validPos(t.a)) continue;
            if (giveMinima > t.a) continue;                       // per-take cap
            if (cmpAmtMul(recvRaw, giveRaw, t.p) >= 0) return true;   // EXACT: I receive ≥ given × price
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
        for (var t in takerOf) { if (!incoming[t]) { delete takerOf[t]; delete noticesSent[t]; } }   // bounded with the queue
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
        keepWallet(function () { rearmOtc(function () { doScanIncoming(block, next); }); });
    }
    function doScanIncoming(block, next) {
        // Scan the TAKE sentinel for LADDER buy-take handshakes if I have a live published order + identity, and
        // for MAKER NOTICES if I am a taker with a started buy waiting on a maker (0.1.39 — before this a taker
        // never read the channel, so a decline could not reach it). OTC buy-takes arrive as queued `incoming`
        // hashes (from EXECUTE / rearmOtc) and are processed regardless.
        if (!C.myIdentity) return processQueue();
        if (myOrder()) return scanTake(true);
        takerWaiting(function (waiting) { if (waiting) scanTake(false); else processQueue(); });
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
        function scanTake(maker) {
            var addr = TR.active().takeAddr, notices = [];
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
                            if (!msg || !msg.hash || msg.to !== C.myIdentity.publicId()) continue;
                            var authed = sameId(opened.fromPublicId, msg.from);   // the sealed signer IS the claimed sender
                            if (msg.notice != null) { if (authed) notices.push({ hash: msg.hash, from: opened.fromPublicId, state: String(msg.notice), reason: msg.reason }); continue; }
                            if (!maker) continue;
                            addIncoming(msg.hash);
                            if (authed) takerOf[normHash(msg.hash)] = opened.fromPublicId;
                        } catch (e) { }
                    }
                    // Notices are informational (settle.onMakerNotice); sequential, then the buy queue as before.
                    F.each(notices, function (n, j, nx) {
                        if (!AX.settle || !AX.settle.onMakerNotice) return nx();
                        AX.settle.onMakerNotice(n.hash, n.from, n.state, n.reason, function () { nx(); });
                    }, function () { processQueue(); });
                });
            });
        }
    }
    function sameId(a, b) { return !!a && !!b && String(a).replace(/^0x/i, '').toLowerCase() === String(b).replace(/^0x/i, '').toLowerCase(); }
    /** A started buy of mine (ETH-first initiator) still waiting on its maker — only those can get a notice. */
    function takerWaiting(cb) {
        DB.allSwaps(function (e, all) {
            cb(!e && (all || []).some(function (s) { return s && s.role === 'INITIATOR' && s.status === DB.ST_STARTED && !s.myLegIsMinima; }));
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
                    // Every skip below RECORDS its reason and tells the taker (recordDecline) — the gates themselves
                    // are unchanged. Live 2026-10-26: these were bare `return next()`s and a taker waited two hours.
                    if (!c.receiver || String(c.receiver).toLowerCase() !== String(C.ethAddr).toLowerCase())   // foreign/stale
                        return recordDecline(hash, 'Maker declined: your USDT lock pays ' + (c.receiver || 'nobody') + ', not this maker\'s ' + C.ethAddr + '.', true, next);
                    if (c.timelock - ethNow < Number(AX.htlc.CP_SECS_CHECK))   // their USDT lock too close to timeout
                        return recordDecline(hash, 'Maker declined: your USDT lock expires at ' + isoUnix(c.timelock) + ', less than '
                            + Math.round(Number(AX.htlc.CP_SECS_CHECK) / 60) + ' min away — too close to its timeout to lock safely.', true, next);
                    gateBuy(c, hash, !!c.otc, function (ok) {   // OTC deal-match OR ladder-fit gate
                        if (!ok) return recordDecline(hash, buyDeclineReason(c, !!c.otc), !c.otc || !!(AX.otc && AX.otc.ready()), next);
                        if (cpBurstFull(hash)) return recordDecline(hash, 'Maker busy: already locking ' + CP_LOCK_BURST
                            + ' other buys — it retries on the next block.', false, next);
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

    /** Why gateBuy said no, in the taker's terms (reporting only — re-derives, never decides). */
    function buyDeclineReason(c, otc) {
        if (otc) return AX.otc && AX.otc.ready() ? 'Maker declined: no agreed OTC deal matches this lock.'
                                                 : 'Maker\'s OTC desk is not running yet — it retries.';
        var order = myOrder(), label = TR.active().coinLabel;
        if (!order) return 'Maker declined: this maker has no live order right now.';
        if (!c.tokenContract || String(c.tokenContract).toLowerCase() !== EO.NET.usdt.toLowerCase())
            return 'Maker declined: your lock pays token ' + (c.tokenContract || 'unknown') + ', not USDT ' + EO.NET.usdt + '.';
        var p = pair(order);
        if (!p || !p.en) return 'Maker declined: this maker is not selling ' + label + ' right now.';
        var give = D.formatUnits(c.requestAmount, 18), recv = D.formatUnits(c.amount, decimalsOf(c.tokenContract));
        if (!(num(give) > 0)) return 'Maker declined: your lock asks for no ' + label + '.';
        if (validPos(p.min) && num(give) < p.min) return 'Maker declined: you asked for ' + give + ' ' + label + ', below this maker\'s minimum of ' + p.min + '.';
        var levels = p.asks.length ? p.asks.map(function (t) { return t.p + ' up to ' + t.a; }).join(', ') : (p.buy + ' (any size)');
        return 'Maker declined: you pay ' + recv + ' USDT for ' + give + ' ' + label + '; none of this maker\'s asks fits (price up to size: ' + levels + ').';
    }
    function isoUnix(t) { return new Date(Number(t) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'); }

    /** Maker: record WHY a buy was not locked, once per (hash, reason) via the events log, and tell the taker
     *  (sealed, on the TAKE channel, at most MAX_NOTICES_PER_HASH per hash). fin = never (declined) vs retrying.
     *  Reporting only — never changes what happens to funds. cb() always. */
    function recordDecline(hash, reason, fin, cb) {
        cb = cb || function () {};
        if (!hash || !reason) return cb();
        DB.getEvents(hash, function (e, evs) {
            if (e) return cb();
            for (var i = 0; i < evs.length; i++) if (evs[i].event === DB.EV_DECLINED && evs[i].note === reason) return cb();
            log('[AtomiX] buy ' + hash + ' not locked: ' + reason);
            DB.logEvent(hash, DB.EV_DECLINED, '', '', reason, function () {
                sendNotice(hash, fin ? 'declined' : 'retrying', reason);
                onChanged(); cb();
            });
        });
    }
    function sendNotice(hash, state, reason) {
        var k = normHash(hash), to = takerOf[k], n = noticesSent[k] || 0;
        if (!to || !C || !C.myIdentity || !AX.take || n >= MAX_NOTICES_PER_HASH) return;
        noticesSent[k] = n + 1;
        try {
            AX.take.notice(C.myIdentity, to, C.myIdentity.publicId(), hash, state, reason, function (err) {
                if (err) log('[AtomiX] notice not sent for ' + hash + ': ' + (err.message || err));
            });
        } catch (ex) { log('[AtomiX] notice not sent for ' + hash + ': ' + ex.message); }
    }

    /** [Minima] Lock the mxUSDT counter-leg (block + CP_BLOCKS) from largest-first reserved coins. next(). */
    var lastCoinDecline = 0;
    function lockMinimaCounterLeg(c, block, next) {
        var hash = c.hashlock, timelock = block + Number(AX.htlc.CP_BLOCKS);
        var reqMinimaHuman = D.formatUnits(c.requestAmount, 18);    // mxUSDT they want from me
        var receiverPubkey = c.minimaPublicKey;
        var actTok = TR.active().tokenId;
        H.myFreeCoins(actTok, function (e, coins) {
            if (e) {
                releaseHash(hash);
                if (!lastCoinDecline || Date.now() - lastCoinDecline >= 1800000) {
                    lastCoinDecline = Date.now();
                    notify('Buy request declined', e.message + ' Hashlock: ' + hash);
                }
                return recordDecline(hash, 'Maker wallet: ' + e.message + ' — it consolidates automatically and retries.', false, next);
            }
            if (actTok !== TR.active().tokenId)
                return recordDecline(hash, 'Maker switched market while locking — it retries.', false, next);
            var picked = selectCoins(coins, reqMinimaHuman);
            if (!picked.ids.length) {
                notify('Buy request declined', 'Not enough free ' + TR.active().coinLabel + ' to fill ' + reqMinimaHuman);
                return recordDecline(hash, 'Maker wallet: not enough free ' + TR.active().coinLabel + ' to fill ' + reqMinimaHuman
                    + ' — it retries as its coins free up.', false, next);
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
                        if (String(eL.message).indexOf('POSTED:') !== 0) {
                            DB.deleteSwap(hash, function () {});
                            releaseHash(hash);
                            return recordDecline(hash, 'Maker lock failed: ' + eL.message + ' — it retries on the next block.', false, next);
                        }
                        releaseHash(hash); return next();   // may have broadcast — the swap row is the dedup
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

    // ---- wallet keeper: keep the active token's coins inside the band the engine can trade with ----
    // Every sell take lands as a new coin, so a busy maker fragments until the safe coin read (53 tokens / 200
    // MINIMA, htlc.guardedCoins) refuses and EVERY buy is declined (live 2026-10-26: 56 MxUSD coins). Merge well
    // before that; split when a single coin would serialise concurrent takes. Same commands as native AtomiX's
    // manual Wallet tools (MinimaHtlc.consolidateCoins / splitCoins). A split makes 10 coins, merging stops at 30,
    // so the two can never chase each other.
    var KEEP_MERGE_ABOVE = 30, KEEP_MERGE_ABOVE_MINIMA = 120, KEEP_MERGE_INPUTS = 20;
    var KEEP_SPLIT_BELOW = 2, KEEP_SPLIT_INTO = 10, KEEP_GAP_MS = 120000;
    var keepBusy = false, keepLast = 0;
    /** Pure: what (if anything) to run for this settled balance. null = wallet is fine. */
    function keepPlan(b, tokenId, myAddr) {
        if (!b || !isHexTok(tokenId) || Number(b.unconfirmed) !== 0) return null;   // only ever act on a settled wallet
        var minima = String(tokenId).toLowerCase() === '0x00';
        if (b.coins > (minima ? KEEP_MERGE_ABOVE_MINIMA : KEEP_MERGE_ABOVE))
            return { kind: 'merge', cmd: 'consolidate tokenid:' + tokenId + ' coinage:3 maxcoins:' + KEEP_MERGE_INPUTS + ' maxsigs:5',
                why: b.coins + ' coins (keeping it at or below ' + (minima ? KEEP_MERGE_ABOVE_MINIMA : KEEP_MERGE_ABOVE) + ')' };
        if (b.coins < KEEP_SPLIT_BELOW && Number(b.sendable) >= KEEP_SPLIT_INTO && myAddr)
            return { kind: 'split', cmd: 'send amount:' + b.sendable + ' address:' + myAddr + ' tokenid:' + tokenId
                + ' split:' + KEEP_SPLIT_INTO + ' coinage:1 mine:true',
                why: b.coins + ' coin holding ' + b.sendable + ' (two takes cannot share one coin)' };
        return null;
    }
    function isHexTok(t) { return /^0x[0-9a-fA-F]+$/.test(String(t || '')); }
    /** Runs at most one merge/split, never while a counter-leg lock holds coins; never waits for it (next() now). */
    function keepWallet(next) {
        if (keepBusy || Object.keys(cpInFlight).length || _now() - keepLast < KEEP_GAP_MS) return next();
        var tok = TR.active().tokenId;
        H.tokenBalance(tok, function (e, b) {
            var plan = e ? null : keepPlan(b, tok, C && C.myMinimaAddr);
            if (!plan || keepBusy || Object.keys(cpInFlight).length) return next();
            keepBusy = true; keepLast = _now();
            var label = TR.active().coinLabel, title = plan.kind === 'merge' ? 'Merging ' + label + ' coins' : 'Splitting ' + label + ' coins';
            log('[AtomiX] wallet keeper: ' + plan.kind + ' — ' + plan.why + ' — ' + plan.cmd);
            AX.mds.cmdR(plan.cmd, function (err, resp) {
                keepBusy = false; keepLast = _now();
                var id = resp && (resp.txpowid || (resp.txpow && resp.txpow.txpowid)) || '';
                if (err) { log('[AtomiX] wallet keeper ' + plan.kind + ' failed: ' + err.message); notify(title + ' failed', err.message); }
                else { log('[AtomiX] wallet keeper ' + plan.kind + ' posted ' + id); notify(title, plan.why + '. Coins stay in your wallet.' + (id ? ' txpow ' + id : '')); }
            });
            next();
        });
    }
    function log(s) { try { if (g.MDS && g.MDS.log) g.MDS.log(s); } catch (e) { } }

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
        recordDecline: recordDecline, buyDeclineReason: buyDeclineReason, MAX_NOTICES_PER_HASH: MAX_NOTICES_PER_HASH,
        _takerOf: function () { return takerOf; },
        _reset: function () { cpInFlight = {}; incoming = {}; takerOf = {}; noticesSent = {}; EO._resetApprovals(); }, _setNow: function (fn) { _now = fn; EO._setNow(fn); },
        _selectCoins: selectCoins, keepPlan: keepPlan, keepWallet: keepWallet, _resetKeeper: function () { keepBusy = false; keepLast = 0; }, _incoming: function () { return incoming; }, pruneIncoming: pruneIncoming,
        CP_LOCK_BURST: CP_LOCK_BURST, INCOMING_TTL_MS: INCOMING_TTL_MS, INCOMING_MAX: INCOMING_MAX
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
