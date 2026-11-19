/**
 * ui/wallet.js — window.DexiconWallet, mirror of Dexicon Android 0.1.25 (WalletTools + MainActivity.autoFund):
 *   ASSETS › CONSOLIDATE  → the service's CONSOLIDATE (node `consolidate tokenid:`, PandaPools/UTXO tool, under PandaSignLock)
 *   ASSETS › SPLIT ×10    → the service's existing SPLIT (PandaDEX SelfSplit)
 *   auto-recovery         → a BOOK/POOL trade that fails on funding is not left for the user: coins still confirming →
 *                           wait; spendable but spread over unusable coins → consolidate and wait; then the SAME LIMIT is
 *                           re-sent once (the service re-plans it within the same limit). At most 10 blocks.
 * The page never signs: every write goes to the service.
 */
(function () {
    'use strict';
    var FUND = /^Wallet has|Too many transaction inputs|needs more than|TxPoW size|too large/i;
    var last = null;   // the last LIMIT the page sent: { data, at, retried }

    function token(which) { return which === 'minima' ? '0x00' : ((window.DexiconFast && DexiconFast.usdToken()) || PandaDEX.USDT); }
    function name(which) { return which === 'minima' ? 'MINIMA' : 'MxUSD'; }
    function toService(type, data) { MDS.comms.solo(JSON.stringify({ origin: 'dexicon', type: type, data: data || {} }), function () { }); }

    /** The pointer the vendored PandaDEX text gives ("in MinimaCore") — Dexicon has it on ASSETS. */
    function here(s) {
        return String(s == null ? '' : s).replace('consolidate this token in MinimaCore', 'consolidate this token on ASSETS › CONSOLIDATE')
            .replace('Use MinimaCore consolidation', 'Use ASSETS › CONSOLIDATE').replace('Consolidate funding', 'Consolidate on ASSETS')
            .replace('consolidate coins and retry', 'consolidate on ASSETS and retry');
    }

    function consolidate(which, coins) {
        var tok = token(which), n = name(which);
        if (coins < 2) return PD.notice('Your ' + n + ' is already in ' + coins + (coins === 1 ? ' coin.' : ' coins.'), 'live');
        if (!confirm('Consolidate ' + n + '?\n\nCombine your ' + coins + ' ' + n + ' wallet coins into fewer, larger ones. Your node picks the coins with its standard consolidation command. Nothing leaves your wallet and there is no fee.\n\nconsolidate tokenid:' + tok)) return;
        toService('CONSOLIDATE', { tokenid: tok });
        PD.notice('Consolidating ' + n + '…', 'pending');
    }
    function split(which, sendable) {
        var tok = token(which), n = name(which);
        if (!sendable || !sendable.gt(0)) return PD.notice('No sendable ' + n + ' to split right now.', 'error');
        if (!confirm('Split ' + n + ' into 10 coins?\n\nSend all ' + sendable.toFixed() + ' sendable ' + n + ' to yourself as 10 equal coins, so several orders and trades can each have their own coin. The coins stay in your wallet and are spendable again once the send confirms.')) return;
        PD.send('SPLIT', { tokenid: tok, amount: sendable.toFixed() });
    }

    /** pd_app.send calls this for every LIMIT it sends. */
    function sent(type, data) { if (type === 'LIMIT') last = { data: JSON.parse(JSON.stringify(data)), at: Date.now(), retried: !!(data && data._retry) }; }

    /** pd_app's service-packet handler calls this on ERROR; true = recovery took over (don't show the raw error). */
    function failed(message) {
        if (!last || last.retried || Date.now() - last.at > 5 * 60000 || !FUND.test(String(message || ''))) return false;
        last.retried = true;
        var d = last.data, buy = !!d.buy, which = buy ? 'usdt' : 'minima', tok = token(which), n = name(which);
        var need = buy ? PandaDEX.d(d.minima).mul(PandaDEX.d(d.price)) : PandaDEX.d(d.minima);   // an upper bound at the limit price
        balance(tok, function (b) {
            if (!b) { PD.notice(here(message), 'error'); return; }
            if (b.sendable.lt(need) && b.unconfirmed.gt(0)) {
                PD.notice('Waiting for your ' + n + ' to confirm (' + b.sendable.toFixed() + ' spendable) — the trade retries by itself', 'pending');
                return wait(tok, need, false, d, Number(PD.state().block || 0));
            }
            if (b.coins < 2) { PD.notice(here(message), 'error'); return; }
            PD.notice('Your ' + n + ' is spread over ' + b.coins + ' coins — consolidating it, then the trade retries by itself', 'pending');
            toService('CONSOLIDATE', { tokenid: tok });
            wait(tok, need, true, d, Number(PD.state().block || 0));
        });
        return true;
    }

    function balance(tok, cb) {
        MDS.cmd('balance tokenid:' + tok, function (r) {
            var rows = r && r.status && r.response, row = null, i;
            for (i = 0; rows && i < rows.length; i++) if (String(rows[i].tokenid).toLowerCase() === String(tok).toLowerCase()) row = rows[i];
            if (!row) return cb(rows ? { sendable: PandaDEX.d(0), unconfirmed: PandaDEX.d(0), coins: 0 } : null);
            cb({ sendable: PandaDEX.d(row.sendable || 0), unconfirmed: PandaDEX.d(row.unconfirmed || 0), coins: Number(row.coins || 0) });
        });
    }

    /** Poll every 15 s (≤ 10 blocks) until the token is spendable again — and, after a consolidation, fully confirmed —
     *  then re-send the same LIMIT once. The service re-plans it within the same limit price. */
    function wait(tok, need, consolidated, data, start) {
        setTimeout(function () {
            var tip = Number(PD.state().block || 0);
            if (start && tip - start > 10) return PD.notice('Gave up waiting for the wallet after 10 blocks — try the trade again', 'error');
            balance(tok, function (b) {
                if (!b || b.sendable.lt(need) && !consolidated || consolidated && b.unconfirmed.gt(0)) return wait(tok, need, consolidated, data, start);
                var again = JSON.parse(JSON.stringify(data)); again._retry = true;
                PD.notice('Wallet ready — retrying your ' + (data.buy ? 'buy' : 'sell'), 'pending');
                PD.send('LIMIT', again);
            });
        }, 15000);
    }

    window.DexiconWallet = { consolidate: consolidate, split: split, sent: sent, failed: failed, here: here };
})();
