/**
 * ethops — the Ethereum leg operations, a faithful port of native EthHtlc.java: approve → newContract (lock) →
 * withdraw (reveal preimage) → refund (after timelock), plus the read-only allowance / canCollect / getContract
 * views. Wires the calldata (AX.ethhtlc) to the transport (AX.ethrpc / AX.ethtx). getContract reads current state
 * via eth_call (NOT eth_getLogs) so it works on free/keyless RPCs, and because contractId = sha256(hashlock) is
 * deterministic we can find a leg, read withdrawn/refunded, and harvest the revealed preimage without scanning
 * logs. All methods are async — cb(err[, value]). Attaches to AX.ethops.
 * Requires AX.ethhtlc, AX.ethrpc, AX.ethtx.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var EH = AX.ethhtlc, ETX = AX.ethtx;
    /** Decode an eth_call uint256 return, tolerant of a malformed/hostile body — a bad read yields 0n (a short
     *  allowance re-approves, a 0 balance blocks a publish) rather than throwing uncaught inside an MDS callback. */
    function safeBig(ret) { try { return AX.ethrpc.hexToBig(ret); } catch (e) { return 0n; } }

    /** make(rpc, privHex, address) → an operations object bound to my ETH wallet + a chosen RPC. */
    function make(rpc, privHex, address) {
        var NET = EH.NET;

        function tx(call, cb) {
            ETX.send(rpc, privHex, address, NET.chainId, call.to, call.data, 0n, BigInt(call.gas), cb);
        }

        return {
            /** ERC20 approve(htlc, amountRaw) so the vault can pull the tokens. cb(err, txHash). */
            approve: function (token, amountRaw, cb) {
                var call = EH.approve(NET.htlc, amountRaw);   // data: approve(spender=htlc, amount); send to the token
                tx({ to: token, data: call.data, gas: call.gas }, cb);
            },
            /** allowance(owner=me, htlc) — cb(err, BigInt). Guarded decode: a malformed RPC return → clean 0n, never a throw. */
            allowance: function (token, cb) {
                var call = EH.allowance(address);
                rpc.ethCall(token, call.data, function (e, ret) { cb(e, e ? 0n : safeBig(ret)); });
            },
            /** ERC20 balanceOf(me) — cb(err, BigInt raw). Read-only (eth_call); used for the wallet USDT balance. */
            balanceOf: function (token, cb) {
                var data = AX.abi.encodeCall('balanceOf(address)', [{ t: 'address', v: address }]);
                rpc.ethCall(token, data, function (e, ret) { cb(e, e ? 0n : safeBig(ret)); });
            },
            /** Lock ERC20 into the HTLC. amounts are BigInt (raw units). cb(err, txHash). */
            newContract: function (senderMinima, receiverEth, hashlock, timelockUnix, token, amountRaw, requestAmountRaw, otc, cb) {
                tx(EH.newContract(senderMinima, receiverEth, hashlock, timelockUnix, token, amountRaw, requestAmountRaw, otc), cb);
            },
            withdraw: function (contractId, preimage, cb) { tx(EH.withdraw(contractId, preimage), cb); },
            refund: function (contractId, cb) { tx(EH.refund(contractId), cb); },
            /** Is this leg still collectable (not withdrawn/refunded)? cb(err, bool). */
            canCollect: function (contractId, cb) {
                var call = EH.canCollectCall(contractId);
                rpc.ethCall(NET.htlc, call.data, function (e, ret) { cb(e, e ? false : EH.decodeBool(ret)); });
            },
            /** Full contract state by id (eth_call getContract). cb(err, Contract|null); null = no such contract. */
            getContract: function (contractId, cb) {
                var call = EH.getContractCall(contractId);
                rpc.ethCall(NET.htlc, call.data, function (e, ret) { cb(e, e ? null : EH.decodeGetContract(contractId, ret)); });
            }
        };
    }

    // ---- shared non-blocking allowance gate (F4 zero-first), single copy for engine + responder so the two
    // callers can't each fire a duplicate MAX approve from independent pending maps. cb(err, ready). ready=false →
    // an approve was submitted (or is pending its TTL); the caller asks the user / next poll to retry. A non-zero
    // residual is zeroed first (Tether reverts non-zero→non-zero), then the next attempt fires the MAX approve.
    var MAX_UINT = (1n << 256n) - 1n, APPROVE_TTL_MS = 5 * 60 * 1000;
    var approvePending = {};
    var _now = function () { return Date.now(); };
    function ensureAllowance(o, token, needed, cb) {
        o.allowance(token, function (e, cur) {
            if (e) return cb(e);
            if (cur >= needed) { delete approvePending[token]; delete approvePending[token + '|0']; return cb(null, true); }
            var now = _now();
            if (cur > 0n) {                                   // F4 zero-first (own TTL key)
                var z = approvePending[token + '|0'];
                if (z == null || now - z > APPROVE_TTL_MS) { approvePending[token + '|0'] = now; return o.approve(token, 0n, function () { cb(null, false); }); }
                return cb(null, false);
            }
            var sent = approvePending[token];
            if (sent == null || now - sent > APPROVE_TTL_MS) { approvePending[token] = now; return o.approve(token, MAX_UINT, function () { cb(null, false); }); }
            cb(null, false);
        });
    }

    AX.ethops = { make: make, contractId: EH.contractId, NET: EH.NET,
        ensureAllowance: ensureAllowance, MAX_UINT: MAX_UINT,
        _setNow: function (fn) { _now = fn; }, _resetApprovals: function () { approvePending = {}; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
