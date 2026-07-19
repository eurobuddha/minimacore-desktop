/**
 * ethhtlc — the Ethereum ERC20-HTLC contract interface (port of native eth/EthHtlc.java + EthNet). Builds the
 * calldata for approve/allowance/newContract/withdraw/refund/canCollect/getContract, computes the deterministic
 * contractId = sha256(b32(hashlock)), and decodes the 12-field getContract tuple. Byte-parity with web3j (gated by
 * the interop vectors). Requires AX.abi, AX.sodium, AX.hex, AX.dec. Attaches to AX.ethhtlc.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var abi = AX.abi, S = AX.sodium, H = AX.hex;

    var NET = {
        chainId: 1,
        htlc: '0x67376c3bf3b5a336b14398920cfbc292013718ea',   // shared ERC20 HTLC vault (upstream bridge)
        usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        usdtDecimals: 6,
        reqDecimals: 18,   // mxUSDT requestAmount is carried at 18dp on the ETH side (hard interop constant)
        rpcs: [
            'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org',
            'https://eth-mainnet.public.blastapi.io', 'https://eth-pokt.nodies.app',
            'https://eth.api.onfinality.io/public', 'https://api.zan.top/eth-mainnet',
            'https://eth.rpc.blxrbdn.com', 'https://gateway.tenderly.co/public/mainnet', 'https://1rpc.io/eth'
        ],
        gas: { approve: 100000, newContract: 500000, withdraw: 500000, refund: 500000 }
    };

    /** native b32: left-pad when shorter, keep the LAST 32 bytes when longer → 32-byte Uint8Array. */
    function b32(hex) {
        var b = H.from(hex);
        if (b.length === 32) return b;
        var out = new Uint8Array(32);
        var srcStart = Math.max(0, b.length - 32), dstStart = Math.max(0, 32 - b.length), n = Math.min(32, b.length);
        for (var i = 0; i < n; i++) out[dstStart + i] = b[srcStart + i];
        return out;
    }

    /** contractId = SHA-256(b32(hashlock)), deterministic — locate a leg without scanning logs. */
    function contractId(hashlock) { return '0x' + H.to(S.sha256Bytes(b32(hashlock))); }

    // ---- calldata builders: each returns { to, data, gas } ----
    function approve(spender, amountRaw) {
        return { to: NET.usdt, data: abi.encodeCall('approve(address,uint256)', [{ t: 'address', v: NET.htlc }, { t: 'uint256', v: amountRaw }]), gas: NET.gas.approve };
    }
    function allowance(owner) {
        return { to: NET.usdt, data: abi.encodeCall('allowance(address,address)', [{ t: 'address', v: owner }, { t: 'address', v: NET.htlc }]) };
    }
    function newContract(senderMinimaPk, receiverEth, hashlock, timelockUnix, token, amountRaw, requestAmountRaw, otc) {
        return { to: NET.htlc, gas: NET.gas.newContract, data: abi.encodeCall(
            'newContract(bytes32,address,bytes32,uint256,address,uint256,uint256,bool)', [
                { t: 'bytes32', v: senderMinimaPk }, { t: 'address', v: receiverEth }, { t: 'bytes32', v: hashlock },
                { t: 'uint256', v: timelockUnix }, { t: 'address', v: token }, { t: 'uint256', v: amountRaw },
                { t: 'uint256', v: requestAmountRaw }, { t: 'bool', v: !!otc }]) };
    }
    function withdraw(cid, preimage) {
        return { to: NET.htlc, gas: NET.gas.withdraw, data: abi.encodeCall('withdraw(bytes32,bytes32)', [{ t: 'bytes32', v: cid }, { t: 'bytes32', v: preimage }]) };
    }
    function refund(cid) {
        return { to: NET.htlc, gas: NET.gas.refund, data: abi.encodeCall('refund(bytes32)', [{ t: 'bytes32', v: cid }]) };
    }
    function canCollectCall(cid) {
        return { to: NET.htlc, data: abi.encodeCall('canCollect(bytes32)', [{ t: 'bytes32', v: cid }]) };
    }
    function getContractCall(cid) {
        return { to: NET.htlc, data: abi.encodeCall('getContract(bytes32)', [{ t: 'bytes32', v: cid }]) };
    }

    /** decode getContract return (12-tuple, exact native field order). null if the owner is the zero address.
     *  Fail-CLOSED on a malformed/truncated body (broken or hostile RPC): a BigInt('0x') throw here would escape
     *  the async MDS callback chain and permanently wedge the settlement poll — return null instead. */
    var GET_TYPES = ['address', 'bytes32', 'address', 'address', 'uint256', 'uint256', 'bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bool'];
    function decodeGetContract(cid, retHex) {
        try {
            if (!retHex || retHex.length < 3) return null;
            if (retHex.replace(/^0x/i, '').length < GET_TYPES.length * 64) return null;   // truncated tuple
            var d = abi.decode(GET_TYPES, retHex);
            if (!d[0] || BigInt(d[0]) === 0n) return null;   // zero address = no such contract
            return {
                contractId: cid.indexOf('0x') === 0 ? cid : '0x' + cid,
                owner: d[0], minimaPublicKey: d[1], receiver: d[2], tokenContract: d[3],
                amount: d[4], requestAmount: d[5], hashlock: d[6], timelock: Number(d[7]),
                withdrawn: d[8], refunded: d[9], preimage: d[10], otc: d[11]
            };
        } catch (e) { return null; }
    }
    function decodeBool(retHex) { try { return BigInt('0x' + retHex.replace(/^0x/, '') || '0') !== 0n; } catch (e) { return false; } }

    AX.ethhtlc = {
        NET: NET, b32: b32, contractId: contractId,
        approve: approve, allowance: allowance, newContract: newContract, withdraw: withdraw, refund: refund,
        canCollectCall: canCollectCall, getContractCall: getContractCall,
        decodeGetContract: decodeGetContract, decodeBool: decodeBool
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
