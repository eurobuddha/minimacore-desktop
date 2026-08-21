/**
 * wallet — the Wallet tab's ETH-side operations: address helpers, the gas-reserve math, and plain-ETH /
 * ERC20-USDT sends. Manual send is an MDS-ONLY feature (user-decided divergence: the native wallet is
 * receive-only — see PARITY.md). Sends ride the SAME AX.ethtx per-address nonce serializer + cross-instance
 * ax_ethlock as the swap engine, so a user send can never nonce-clash a settlement broadcast.
 * Requires AX.ethtx, AX.abi, AX.dec, AX.ethops (NET). Attaches to AX.wallet.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var ETX = AX.ethtx, ABI = AX.abi, D = AX.dec, EO = AX.ethops;

    var GAS_ETH = 21000n;      // fixed intrinsic gas of a plain value transfer
    var GAS_ERC20 = 100000n;   // same safety limit native uses for its ERC20 approve; unused gas refunds

    /** first 8 + … + last 6 — native MainActivity.shortAddr (:3302). */
    function shortAddr(a) {
        a = String(a == null ? '' : a);
        return a.length < 14 ? a : a.slice(0, 8) + '…' + a.slice(-6);
    }
    function isEthAddr(a) { return /^0x[0-9a-fA-F]{40}$/.test(String(a == null ? '' : a).trim()); }
    function validDec(s) { return /^[0-9]+(\.[0-9]+)?$/.test(String(s == null ? '' : s).trim()); }

    /** The wei this wallet must RESERVE for one send's gas, mirroring the serializer's +12.5% headroom (0.1.40:
     *  was +20%; F5's base-fee floor can raise the actual price further — the review shows "≈"). gasPriceWei: BigInt. */
    function gasReserveWei(gasPriceWei, gasLimit) { return gasLimit * ((gasPriceWei * 9n) / 8n); }
    /** Max spendable ETH after reserving gas for the send itself. Returns wei BigInt ≥ 0. */
    function maxEthSendWei(balanceWei, gasPriceWei) {
        var m = balanceWei - gasReserveWei(gasPriceWei, GAS_ETH);
        return m > 0n ? m : 0n;
    }

    /**
     * Validate a send BEFORE building it. kind 'eth'|'usdt'; amounts are decimal strings; balances are RAW
     * BigInt (wei / 6dp units) — display strings are rounded and MUST NOT be used for fund checks.
     * Returns { ok } or { ok:false, err:'plain-words reason' }.
     */
    function checkSend(kind, to, amountStr, ethWei, usdtRaw, gasPriceWei) {
        if (!isEthAddr(to)) return { ok: false, err: 'Enter a valid Ethereum address (0x + 40 hex characters).' };
        if (!validDec(amountStr)) return { ok: false, err: 'Enter a plain decimal amount.' };
        if (kind === 'eth') {
            var wei = D.parseUnits(amountStr, 18);
            if (wei <= 0n) return { ok: false, err: 'Enter an amount above zero.' };
            if (wei + gasReserveWei(gasPriceWei, GAS_ETH) > ethWei)
                return { ok: false, err: 'Not enough ETH for that amount plus network gas — try Max.' };
            return { ok: true };
        }
        var raw = D.parseUnits(amountStr, EO.NET.usdtDecimals);
        if (raw <= 0n) return { ok: false, err: 'Enter an amount above zero.' };
        if (raw > usdtRaw) return { ok: false, err: 'That is more USDT than this wallet holds.' };
        if (gasReserveWei(gasPriceWei, GAS_ERC20) > ethWei)
            return { ok: false, err: 'Sending USDT needs a little ETH for gas — fund the wallet with ETH first.' };
        return { ok: true };
    }

    /** Broadcast a plain ETH transfer. cb(err, txHash). */
    function sendEth(rpc, privHex, from, to, amountStr, cb) {
        var wei;
        try { wei = D.parseUnits(amountStr, 18); } catch (e) { return cb(new Error('bad amount')); }
        ETX.send(rpc, privHex, from, EO.NET.chainId, String(to).trim(), '0x', wei, GAS_ETH, cb);
    }
    /** Broadcast an ERC20 USDT transfer(to, amount). cb(err, txHash). */
    function sendUsdt(rpc, privHex, from, to, amountStr, cb) {
        var raw, data;
        try {
            raw = D.parseUnits(amountStr, EO.NET.usdtDecimals);
            data = ABI.encodeCall('transfer(address,uint256)', [{ t: 'address', v: String(to).trim() }, { t: 'uint256', v: raw }]);
        } catch (e) { return cb(new Error('bad amount/address')); }
        ETX.send(rpc, privHex, from, EO.NET.chainId, EO.NET.usdt, data, 0n, GAS_ERC20, cb);
    }

    AX.wallet = {
        GAS_ETH: GAS_ETH, GAS_ERC20: GAS_ERC20,
        shortAddr: shortAddr, isEthAddr: isEthAddr, validDec: validDec,
        gasReserveWei: gasReserveWei, maxEthSendWei: maxEthSendWei, checkSend: checkSend,
        sendEth: sendEth, sendUsdt: sendUsdt
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
