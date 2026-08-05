/**
 * inspect — the "Swap status" live report, a faithful port of native SwapEngine.inspect/reportInspection.
 * buildReport is PURE (all chain reads happen in the caller) so the plain-language lines are unit-testable;
 * statusDetail/statusLabel are the Activity-card copy (native MainActivity). Requires AX.htlc (coinAmount/
 * stateAt), AX.dec. Attaches to AX.inspect.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var H = AX.htlc, D = AX.dec;

    /** Plain-language description of where a swap is, so "waiting" isn't ambiguous (native statusDetail). */
    function statusDetail(s) {
        var initiator = s.role === 'INITIATOR';
        switch (s.status) {
            case 'STARTED': return 'Locked your ' + s.sellamount + ' ' + tok(s.selltoken) + ' — waiting for the counterparty to lock their side.';
            case 'LOCKED': return initiator ? 'Counterparty locked — claiming your funds next.'
                : 'You locked your side — waiting for the counterparty to reveal the secret.';
            case 'CLAIMING': return 'Counterparty locked — claiming your ' + s.buyamount + ' ' + tok(s.buytoken) + ' now.';
            case 'COMPLETE': return 'Done — received ' + s.buyamount + ' ' + tok(s.buytoken) + '.';
            case 'REFUNDED': return 'Timed out — your ' + s.sellamount + ' ' + tok(s.selltoken) + ' was refunded.';
            default: return '';
        }
    }
    function tok(t) { return (typeof t === 'string' && t.indexOf('0x') === 0 && AX.trading) ? AX.trading.labelForToken(t) : t; }

    /**
     * Compose the report lines. facts = {
     *   swap: {status, role, direction, sellAmount, sellToken, buyAmount, buyToken, myTimelock, contractId},
     *   block: int|-1, secretKnown: bool,
     *   myMin: coin|null, cpMin: coin|null,                    // my locked coin / coin locked to me (hash-matched)
     *   gc: Contract|null, gcChecked: bool,                    // ETH getContract result (when relevant)
     *   myEthStillLocked: bool|null,                           // canCollect(my contractId), BUY direction
     *   events: [{note}], usdtDecimals: fn(tokenAddr)→dp
     * } → [lines]. Strings are native-verbatim (mxUSDT literals follow the swap's own labels).
     */
    function buildReport(f) {
        var s = f.swap, L = [];
        var sell = s.direction === 'MINIMA_TO_ERC20';
        L.push((sell ? 'Sell ' : 'Buy ') + s.sellAmount + ' ' + s.sellToken + ' → ' + s.buyAmount + ' ' + s.buyToken
            + '  ·  ' + String(s.status).toLowerCase());

        // ---- my leg ----
        if (s.myLegIsMinima) {
            if (f.myMin) {
                var tl = Number(H.stateAt(f.myMin, 3)) || 0;
                L.push('• Your ' + s.sellAmount + ' ' + s.sellToken + ': LOCKED — refundable at block ' + tl
                    + (f.block > 0 ? ' (~' + Math.max(0, Math.round((tl - f.block) * 50 / 60)) + ' min)' : ''));
            } else {
                L.push('• Your ' + s.sellAmount + ' ' + s.sellToken + ': not locked on-chain now — '
                    + (s.status === 'REFUNDED' ? 'refunded' : s.status === 'COMPLETE' ? 'claimed by the counterparty (complete)' : 'spent/claimed'));
            }
        } else {
            L.push('• Your ' + s.sellAmount + ' ' + s.sellToken + ': ' + (f.myEthStillLocked ? 'LOCKED on Ethereum' : 'claimed or refunded'));
        }

        // ---- counterparty leg ----
        // myLegIsMinima, not direction: for a RESPONDER row the old `sell` key printed my own ETH lock as the
        // counterparty leg ("withdrawn (complete)" on a stuck swap). Native parity: atomix 0.1.17.
        if (s.myLegIsMinima) {
            if (!f.gc) {
                L.push('• Counterparty ' + s.buyToken + ' leg: NOT FOUND yet — the maker hasn’t locked it.');
            } else {
                var claimable = !f.gc.withdrawn && !f.gc.refunded;
                L.push('• Counterparty ' + s.buyToken + ' leg: FOUND ' + f.gcAmountHuman + ' ' + s.buyToken
                    + (claimable ? ' — claimable now' : (f.gc.withdrawn ? ' — withdrawn (complete)' : ' — refunded')));
                if (claimable) L.push('→ Claiming on the next poll — your ' + s.buyToken + ' arrives shortly.');
                else if (f.gc.refunded) L.push('→ Maker’s leg timed out & refunded; your ' + s.sellToken + ' auto-refunds at block ' + s.myTimelock + '.');
            }
        } else {
            if (f.cpMin) {
                L.push('• Counterparty ' + s.buyToken + ' leg: FOUND ' + H.coinAmount(f.cpMin) + ' ' + s.buyToken + ' — '
                    + (f.secretKnown ? 'claimable now (claiming on the next poll)' : 'waiting for the secret'));
            } else {
                L.push('• Counterparty ' + s.buyToken + ' leg: NOT FOUND — not locked yet, <2 confirmations old, or already spent.');
            }
        }

        L.push('• Secret: ' + (f.secretKnown ? 'known (you can claim)' : 'not revealed yet'));
        for (var i = 0; i < (f.events || []).length; i++) {
            var n = String(f.events[i].note || '').toLowerCase();
            if (n.indexOf('mismatch') >= 0 || n.indexOf('invalid') >= 0 || n.indexOf('incorrect') >= 0
                || n.indexOf('too close') >= 0 || n.indexOf('fail') >= 0) L.push('⚠ ' + f.events[i].note);
        }
        if (s.status !== 'COMPLETE' && s.status !== 'REFUNDED')
            L.push('(swaps take a few minutes — ~50s polls + 2 confirmations per step)');
        return L;
    }

    AX.inspect = { buildReport: buildReport, statusDetail: statusDetail };
})(typeof globalThis !== 'undefined' ? globalThis : this);
