/**
 * ethrpc — Ethereum JSON-RPC over MDS.net.POST, a faithful port of native EthRpc.java. Sticky endpoint with a
 * 9-provider keyless fallback: any endpoint that returns a non-JSON body / an error object / a dead connection is
 * skipped, and the first that answers becomes the active one — a single public node being down or rate-limited must
 * never stall a read or a broadcast. All methods are async (MDS.net.POST is callback-based); every cb is
 * cb(err[, value]). Timelocks are anchored to CHAIN time (latestBlockTimestamp), never the device clock (F2).
 * Requires AX.mds. Attaches to AX.ethrpc as a constructor: new AX.ethrpc.Rpc(primaryUrl).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds;

    // Keyless mainnet endpoints (verbatim from native EthNet/EthRpc, live 2026-07-18). General-purpose full nodes
    // first; the historically rate-limited 1rpc is LAST. The active endpoint is tried first (sticky), then these.
    var FALLBACKS = [
        'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org',
        'https://eth-mainnet.public.blastapi.io', 'https://eth-pokt.nodies.app',
        'https://eth.api.onfinality.io/public', 'https://api.zan.top/eth-mainnet',
        'https://eth.rpc.blxrbdn.com', 'https://gateway.tenderly.co/public/mainnet', 'https://1rpc.io/eth'
    ];

    /** BigInt from a 0x-hex string (or ZERO on null/empty) — the eth_* numeric decoder. */
    function hexToBig(hex) {
        if (hex == null) return 0n;
        hex = String(hex).trim();
        if (hex.indexOf('0x') === 0 || hex.indexOf('0X') === 0) hex = hex.slice(2);
        if (hex === '') return 0n;
        return BigInt('0x' + hex);
    }

    function host(url) { var m = /^https?:\/\/([^\/]+)/.exec(url || ''); return m ? m[1] : url; }
    function snippet(s) {
        if (!s) return '(empty)';
        s = String(s).replace(/\s+/g, ' ').trim();
        return s.length > 80 ? s.slice(0, 80) + '…' : s;
    }

    function Rpc(url) { this.setUrl(url); }

    Rpc.prototype.setUrl = function (url) {
        this.url = url;
        var seen = {}, eps = [];
        function add(u) { if (u && !seen[u]) { seen[u] = 1; eps.push(u); } }
        add(url);                              // configured primary first
        for (var i = 0; i < FALLBACKS.length; i++) add(FALLBACKS[i]);  // then the known-good keyless nodes
        this.endpoints = eps;
    };

    /** Raw JSON-RPC call with endpoint fallback. cb(err, result). The first endpoint that answers sticks. */
    Rpc.prototype.call = function (method, params, cb) {
        var self = this, errs = [];
        var i = 0, eps = self.endpoints;
        function tryNext() {
            if (i >= eps.length) return cb(new Error(method + ' failed on all RPCs: ' + errs.join('  |  ')));
            var ep = eps[i++];
            self._callOnce(ep, method, params, function (err, result) {
                if (err) { errs.push(err.message); return tryNext(); }
                if (ep !== self.url) self.url = ep;   // stick to whichever responded
                cb(null, result);
            });
        }
        tryNext();
    };

    Rpc.prototype._callOnce = function (url, method, params, cb) {
        var payload = { jsonrpc: '2.0', id: 1, method: method, params: params || [] };
        M.netPost(url, JSON.stringify(payload), function (res) {
            var body;
            try { body = M.netText(res); } catch (e) { return cb(new Error(host(url) + ' body read error: ' + e.message)); }
            var trimmed = body == null ? '' : String(body).trim();
            // A healthy node answers with a JSON object; anything else (HTML error page, 5xx text, empty) is a fail.
            if (trimmed.charAt(0) !== '{') return cb(new Error(host(url) + ' non-JSON: ' + snippet(trimmed)));
            var resp;
            try { resp = JSON.parse(trimmed); } catch (e) { return cb(new Error(host(url) + ' parse error: ' + e.message)); }
            if (resp.error) {
                var m = resp.error && resp.error.message ? resp.error.message : snippet(trimmed);
                return cb(new Error(host(url) + ': ' + m));
            }
            cb(null, resp.result);
        });
    };

    Rpc.prototype.callStr = function (method, params, cb) {
        this.call(method, params, function (e, r) { cb(e, e ? null : (r == null ? null : String(r))); });
    };

    // ---- typed convenience reads (all cb(err, value)) ----
    // A dead/hostile node can answer 200-OK with malformed "0xZZ" — decoding it must surface a clean cb ERROR
    // (so EthTx aborts the send rather than allocating a 0 nonce / 0 gas), never throw uncaught inside a callback.
    function big(cb) {
        return function (e, r) {
            if (e) return cb(e, 0n);
            try { cb(null, hexToBig(r)); } catch (ex) { cb(new Error('bad hex from RPC: ' + (ex && ex.message)), 0n); }
        };
    }
    Rpc.prototype.getBalance = function (addr, cb) { this.callStr('eth_getBalance', [addr, 'latest'], big(cb)); };
    /** Nonce at the "pending" tag — the count EthTx allocates from (fresh read each send; see F1 self-heal). */
    Rpc.prototype.getTransactionCount = function (addr, cb) { this.callStr('eth_getTransactionCount', [addr, 'pending'], big(cb)); };
    Rpc.prototype.gasPrice = function (cb) { this.callStr('eth_gasPrice', [], big(cb)); };
    Rpc.prototype.blockNumber = function (cb) { this.callStr('eth_blockNumber', [], big(cb)); };
    /** The latest block's unix-second timestamp — the clock the HTLC vault enforces timelocks against. */
    Rpc.prototype.latestBlockTimestamp = function (cb) {
        this.call('eth_getBlockByNumber', ['latest', false], function (e, r) {
            if (e) return cb(e);
            if (!r || typeof r !== 'object') return cb(new Error('eth_getBlockByNumber: no block header'));
            var ts = r.timestamp || '';
            if (!ts) return cb(new Error('eth_getBlockByNumber: no timestamp'));
            cb(null, Number(hexToBig(ts)));
        });
    };
    /** Latest EIP-1559 base fee (wei), or 0 on any failure — used only to RAISE a legacy gasPrice floor (F5). */
    Rpc.prototype.baseFeePerGasOrZero = function (cb) {
        this.call('eth_getBlockByNumber', ['latest', false], function (e, r) {
            if (e || !r || typeof r !== 'object') return cb(null, 0n);
            var bf = r.baseFeePerGas || '';
            cb(null, bf ? hexToBig(bf) : 0n);
        });
    };
    /** eth_call to a contract; cb(err, rawHexReturn "0x…"). */
    Rpc.prototype.ethCall = function (to, data, cb) {
        this.callStr('eth_call', [{ to: to, data: data }, 'latest'], cb);
    };
    Rpc.prototype.sendRawTransaction = function (signedHex, cb) {
        this.callStr('eth_sendRawTransaction', [signedHex], cb);
    };

    AX.ethrpc = { Rpc: Rpc, hexToBig: hexToBig, FALLBACKS: FALLBACKS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
