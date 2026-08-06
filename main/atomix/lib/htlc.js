/**
 * htlc — the Minima-leg HTLC covenant constants + one-time setup + state helpers. Byte-identical to native
 * MinimaHtlc.java (a single changed script byte would change the address and break interop). Attaches to AX.htlc.
 * Requires AX.mds. The spends themselves (lock/claim/refund) are built in the engine (Phase 3/4).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds;

    // VERBATIM from native MinimaHtlc.HTLC_SCRIPT — do not reformat.
    var HTLC_SCRIPT =
        'LET version=1.2 LET owner=PREVSTATE(0) LET requestamount=PREVSTATE(1) LET requesttoken=PREVSTATE(2) ' +
        'LET timelock=PREVSTATE(3) LET counterparty=PREVSTATE(4) LET hash=PREVSTATE(5) LET ownerethkey=PREVSTATE(6) ' +
        'IF SIGNEDBY(owner) AND (@BLOCK GT timelock) THEN RETURN TRUE ENDIF LET secret=STATE(100) ' +
        'ASSERT SIGNEDBY(counterparty) AND (SHA2(secret) EQ hash) ASSERT STATE(101) EQ hash ' +
        'ASSERT STATE(102) EQ STRING(owner) ASSERT STATE(103) EQ STRING(counterparty) ' +
        'RETURN VERIFYOUT(@INPUT 0xFFEEDD9999 0.0001 @TOKENID TRUE)';

    var HTLC_ADDRESS = 'MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G';
    var NOTIFY = '0xFFEEDD9999';
    var NOTIFY_AMOUNT = '0.0001';
    var MINIMA_BLOCK_TIME = 50;                 // seconds
    var TIMELOCK_BLOCKS = 7200 / MINIMA_BLOCK_TIME;   // 144 — first Minima leg
    var CP_BLOCKS = 36;                         // second Minima leg (buy responder)
    var CP_BLOCKS_CHECK = 72;                   // responder half-window guard
    var TIMELOCK_SECS = 7200;                   // first ETH leg
    var CP_SECS = 1800;                         // second ETH leg
    var CP_SECS_CHECK = 3600;                   // responder half-window guard

    /** Register the covenant so its address resolves + reads coins, and pick/persist the swap identity key.
     *  setup(cb(err, {miniaddress, address, publickey})).
     *
     *  PERSISTED as of 0.1.19. It used to take a fresh `getaddress` every boot — but that is core
     *  Wallet.getDefaultAddress() → new Random().nextInt(numkeys), i.e. a RANDOM default key per call. So the
     *  published receiver key ROTATED on every service restart / page reload, and settle.js's claim discovery
     *  (isMyPublishKey on state[4]) then failed to recognise a counter-leg locked to the previous boot's key:
     *  swap stuck in CLAIMING, counterparty refunds at timeout and keeps the side we already paid. Native
     *  persists for exactly this reason ("the published maker key must stay constant").
     *
     *  Persisting reintroduces the orphan risk (a reseed makes the saved key unsignable), which is why the
     *  saved key is verified against the node's live key list here and the app HALTS on a mismatch
     *  (identitywatch) instead of silently re-picking. */
    function setup(cb) {
        M.cmdR('newscript trackall:false script:"' + HTLC_SCRIPT + '"', function (err) {
            if (err) return cb(err);
            M.kvGet('swap_identity', '', function (raw) {
                var saved = null;
                try { saved = raw ? JSON.parse(raw) : null; } catch (e) { saved = null; }
                if (saved && saved.miniaddress && saved.publickey) {
                    // Adopt it either way — in-flight swaps must keep settling with the key they were made
                    // with — and let identitywatch halt new liabilities if the node does not own it.
                    loadKeys(function (e2, keys) {
                        if (!e2 && keys && keys.length && keys.indexOf(normKey(saved.publickey)) < 0)
                            MDS.log('[AtomiX] IDENTITY ORPHANED: node does not own saved swap key '
                                + saved.publickey + ' (' + keys.length + ' keys checked) — halting; reinstall required');
                        cb(null, saved);
                    });
                    return;
                }
                M.cmdR('getaddress', function (err2, a) {
                    if (err2) return cb(err2);
                    if (!a || !a.miniaddress) return cb(new Error('getaddress returned no address (node pending/locked?)'));
                    var info = { miniaddress: a.miniaddress, address: a.address, publickey: a.publickey };
                    M.kvSet('swap_identity', JSON.stringify(info), function () { cb(null, info); });
                });
            });
        });
    }

    /** All 64 node default pubkeys (normalised UPPER, no 0x) for owner/refund matching. loadKeys(cb(err, [pk])). */
    function loadKeys(cb) {
        M.cmdR('keys action:list', function (err, r) {
            if (err) return cb(err);
            var keys = (r && r.keys) || r || [];
            var out = [];
            for (var i = 0; i < keys.length; i++) out.push(normKey(keys[i].publickey || keys[i]));
            cb(null, out);
        });
    }

    /** Node stores state hex UPPER-CASE and matches `state:` case-sensitively — normalise every filter/compare. */
    function normKey(v) { return String(v).replace(/^0x/i, '').toUpperCase(); }

    /** Read a coin state value by port, handling both {"port":val} simplestate and [{port,data}] shapes. */
    function stateAt(coin, port) {
        var st = coin && coin.state;
        if (!st) return null;
        if (Array.isArray(st)) {
            for (var i = 0; i < st.length; i++) if (Number(st[i].port) === Number(port)) return st[i].data;
            return null;
        }
        var v = st[String(port)];
        return (v == null || v === '') ? null : v;
    }

    // ---- Minima-leg operations (port of MinimaHtlc.java) ----

    /** Fresh 32-byte secret + its SHA2 (SHA256) hashlock, the same way the bridge does. cb(err, {secret, hash}). */
    function generateSecret(cb) {
        M.cmdR('random type:sha2', function (err, resp) {
            if (err) return cb(err);
            if (!resp) return cb(new Error('random returned nothing'));
            var secret = resp.random || '', hash = resp.hashed || '';
            if (!secret || !hash) return cb(new Error('random missing secret/hash'));
            cb(null, { secret: secret, hash: hash });
        });
    }

    /** FUND-SAFETY: verify a candidate preimage hashes (SHA2/SHA256 — the exact derivation generateSecret used, via
     *  the node's `hash type:sha2`) to `hash`. The NOTIFY sink is anyone-can-write and DB.insertSecret is
     *  first-write-wins, so a harvested preimage MUST be verified before it is pinned — otherwise a forged notify
     *  coin (or a fabricated ETH-contract tuple) poisons the secret store and permanently blocks the maker's claim.
     *  cb(err, boolean). */
    function verifyPreimage(secret, hash, cb) {
        if (!secret || !hash) return cb(null, false);
        M.cmdR('hash type:sha2 data:' + secret, function (err, resp) {
            if (err || !resp || !resp.hash) return cb(null, false);
            cb(null, normKey(resp.hash) === normKey(hash));
        });
    }

    /** Current chain tip block number. cb(err, block:int). */
    function currentBlock(cb) {
        M.cmdR('block', function (err, resp) { cb(err, err ? 0 : (resp ? Number(resp.block || 0) : 0)); });
    }

    /** Quantize a Minima-leg (mxUSDT) lock amount DOWN to the 6dp trade grain — the 1:1 grain vs the 6dp ERC20
     *  USDT counter-leg. Last-line guard that a >6dp amount can never reach the node as a sub-grain send. */
    function grain(amt) { try { return AX.dec.grain6(amt); } catch (e) { return amt; } }
    /** Grain only when the locked token is mxUSDT (the 6dp ERC20 pair); native MINIMA (0x00, 44dp) is left as-is. */
    function maybeGrain(amt, tokenId) {
        var usdt = AX.trading && AX.trading.USDT_TOKENID;
        return (usdt && String(tokenId).toLowerCase() === String(usdt).toLowerCase()) ? grain(amt) : amt;
    }

    /** The traded VALUE of a coin: mxUSDT is a coloured token whose `amount` is ~1e-37 underlying — the real value
     *  is `tokenamount`; native 0x00 has no `tokenamount` so `amount` IS the value. ALWAYS read through here. */
    function coinAmount(coin) {
        if (!coin) return '0';
        var ta = coin.tokenamount;
        if (ta != null && ta !== '') return String(ta);
        var a = coin.amount;
        return (a == null || a === '') ? '0' : String(a);
    }

    /**
     * LOCK: send a single coin to the HTLC with the 7 PREVSTATE fields (state 0-7). p = {amount, requestAmount,
     * reqToken, receiverPubkey, ownerEthKey, hashlock, timelockBlock, otc('TRUE'|'FALSE'), myPubkey, tokenId}.
     * Funds from ANY of my 64 default addresses (refund owner pinned via state[0]); grains when tokenId is mxUSDT.
     * cb(err, txpowid). NOTE: like native, a returned txpowid is the mempool id — NOT the eventual on-chain id.
     */
    function lock(p, cb) {
        var state = {
            '0': p.myPubkey, '1': p.requestAmount, '2': '[' + p.reqToken + ']', '3': p.timelockBlock,
            '4': p.receiverPubkey, '5': p.hashlock, '6': p.ownerEthKey, '7': p.otc
        };
        var amount = maybeGrain(p.amount, p.tokenId);
        var send = 'send amount:' + amount + ' mine:true address:' + HTLC_ADDRESS +
            ' state:' + JSON.stringify(state) + ' tokenid:' + p.tokenId;
        M.cmdR(send, function (err, resp) { cb(err, err ? '' : (resp ? (resp.txpowid || '') : '')); });
    }

    /** Run a list of node commands in sequence; cb(err, lastResponse). A failing step short-circuits (the caller
     *  must txndelete on error — claim/refund do). Uses cmdR so status:false surfaces as a real error. */
    function runSeq(cmds, cb) {
        var last = null;
        AX.flow.each(cmds, function (c, i, next) { M.cmdR(c, function (e, resp) { last = resp; next(e); }); },
            function (err) { cb(err, last); });
    }
    /** Node-side transaction id. The counter is NOT decoration: Date.now() alone is millisecond-granular,
     *  so two settlement actions starting in the same millisecond produced the SAME id — their
     *  txninput/txnstate/txnsign commands then interleaved into ONE merged transaction which got posted.
     *  A corrupt spend, and a signature over content neither caller intended. Native uses nanoTime; this is
     *  the JS equivalent (same fix as pandapools/service.js). */
    var txnSeq = 0;
    function txnId() { return 'axswap_' + Math.floor(Date.now()).toString(16) + '_' + (++txnSeq).toString(16); }
    function deleteTxn(id) { M.cmd('txndelete id:' + id, function () {}); }

    /**
     * CLAIM: I am the receiver (state[4]) of a Minima HTLC coin — spend it revealing the secret. The notify coin
     * (0.0001 → NOTIFY) MUST be output 0 (the script's VERIFYOUT(@INPUT NOTIFY …)); ports 100-103 carry
     * secret/hash/[owner]/[receiver]; sign with the coin's receiver key (one of my 64 defaults). cb(err, txpowid).
     */
    function claim(coin, hash, secret, myAddress, cb) {
        var coinid = coin && coin.coinid;
        if (!coinid) return cb(new Error('claim: coin has no coinid'));   // never build a spend with an empty input
        var tokenid = coin.tokenid || '0x00';
        var amount = coinAmount(coin), owner = stateAt(coin, 0), receiver = stateAt(coin, 4);
        var change = AX.dec.sub(amount, NOTIFY_AMOUNT);
        var id = txnId();
        var seq = [
            'txncreate id:' + id,
            'txninput id:' + id + ' coinid:' + coinid,
            'txnoutput id:' + id + ' tokenid:' + tokenid + ' amount:' + NOTIFY_AMOUNT + ' address:' + NOTIFY
        ];
        if (AX.dec.gt0(change)) seq.push('txnoutput id:' + id + ' tokenid:' + tokenid + ' amount:' + change + ' address:' + myAddress);
        seq.push('txnstate id:' + id + ' port:100 value:' + secret);
        seq.push('txnstate id:' + id + ' port:101 value:' + hash);
        seq.push('txnstate id:' + id + ' port:102 value:[' + owner + ']');
        seq.push('txnstate id:' + id + ' port:103 value:[' + receiver + ']');
        seq.push('txnsign id:' + id + ' publickey:' + receiver);
        seq.push('txnpost id:' + id + ' mine:true auto:true txndelete:true');
        runSeq(seq, function (err, last) { if (err) { deleteTxn(id); return cb(err); } cb(null, txpowOf(last)); });
    }

    /**
     * LOCK from MULTIPLE pinned coins (combined) — the responder counter-leg for a deal larger than any single
     * coin. One txninput per coinid, one HTLC output (grained amount), change → myAddress. The broadcast (txnpost)
     * is SPLIT from the build so a build failure PROVABLY didn't broadcast (retryable) while a txnpost failure MAY
     * have landed with a lost response → tagged "POSTED:" so the caller must NOT retry (no on-chain hash-uniqueness
     * on the mxUSDT leg → a retry would double-lock). p = { coinids, totalSelected, amount, requestAmount, reqToken,
     * receiverPubkey, ownerEthKey, hashlock, timelockBlock, otc, myPubkey, tokenId, myAddress }. cb(err, txpowid).
     */
    function lockFromCoins(p, cb) {
        if (!p.coinids || !p.coinids.length) return cb(new Error('no coins to lock'));
        var amount = maybeGrain(p.amount, p.tokenId), change = AX.dec.sub(p.totalSelected, amount);
        var id = txnId(), seq = ['txncreate id:' + id];
        for (var i = 0; i < p.coinids.length; i++) seq.push('txninput id:' + id + ' coinid:' + p.coinids[i]);
        seq.push('txnstate id:' + id + ' port:0 value:' + p.myPubkey);
        seq.push('txnstate id:' + id + ' port:1 value:' + p.requestAmount);
        seq.push('txnstate id:' + id + ' port:2 value:[' + p.reqToken + ']');
        seq.push('txnstate id:' + id + ' port:3 value:' + p.timelockBlock);
        seq.push('txnstate id:' + id + ' port:4 value:' + p.receiverPubkey);
        seq.push('txnstate id:' + id + ' port:5 value:' + p.hashlock);
        seq.push('txnstate id:' + id + ' port:6 value:' + p.ownerEthKey);
        seq.push('txnstate id:' + id + ' port:7 value:' + p.otc);
        seq.push('txnoutput id:' + id + ' amount:' + amount + ' address:' + HTLC_ADDRESS + ' tokenid:' + p.tokenId + ' storestate:true');
        if (AX.dec.gt0(change)) seq.push('txnoutput id:' + id + ' amount:' + change + ' address:' + p.myAddress + ' tokenid:' + p.tokenId + ' storestate:false');
        seq.push('txnsign id:' + id + ' publickey:auto');
        runSeq(seq, function (err) {
            if (err) { deleteTxn(id); return cb(err); }
            M.cmdR('txnpost id:' + id + ' mine:true auto:true txndelete:true', function (pe, resp) {
                if (pe) { deleteTxn(id); return cb(new Error('POSTED:' + pe.message)); }   // may have broadcast → NEVER retry
                cb(null, txpowOf(resp));
            });
        });
    }

    /** My spendable coins of a token (confirmed, coinage:1) — the pool a responder/ladder can lock against. cb(err, arr). */
    function myFreeCoins(tokenId, cb) {
        M.cmdR('coins relevant:true sendable:true tokenid:' + tokenId + ' coinage:1', function (err, resp) {
            cb(err, (!err && Array.isArray(resp)) ? resp : []);
        });
    }

    // (splitCoins removed — native dropped ladder coin pre-splitting: the responder locks by COMBINING coins
    //  (lockFromCoins multi-input), so ladder readiness is a publish-time BACKING CLAMP (maker.clampAsks), not
    //  a background split. See PARITY.md "ladder backing clamp".)

    /** ALL open HTLC coins of the ACTIVE token (the network-wide market feed — native scanAllHtlcCoins).
     *  Bounded depth: the HTLC address is a shared, potentially heavy sink. cb(err, arr). */
    function scanAllHtlcCoins(coinageMin, depth, cb) {
        M.cmd('coinnotify action:add address:' + HTLC_ADDRESS, function () {
            M.cmdR('coins coinage:' + coinageMin + ' tokenid:' + AX.trading.active().tokenId +
                ' simplestate:true depth:' + depth + ' address:' + HTLC_ADDRESS, function (err, resp) {
                cb(err, (!err && Array.isArray(resp)) ? resp : []);
            });
        });
    }

    /** REFUND: owner (state[0]) reclaims the whole coin after the timelock; sign with the owner key. cb(err, txpowid). */
    function refund(coin, myAddress, cb) {
        var coinid = coin && coin.coinid;
        if (!coinid) return cb(new Error('refund: coin has no coinid'));
        var tokenid = coin.tokenid || '0x00';
        var amount = coinAmount(coin), owner = stateAt(coin, 0);
        var id = txnId();
        var seq = [
            'txncreate id:' + id,
            'txninput id:' + id + ' coinid:' + coinid,
            'txnoutput id:' + id + ' tokenid:' + tokenid + ' amount:' + amount + ' address:' + myAddress,
            'txnsign id:' + id + ' publickey:' + owner,
            'txnpost id:' + id + ' auto:true txndelete:true'
        ];
        runSeq(seq, function (err, last) { if (err) { deleteTxn(id); return cb(err); } cb(null, txpowOf(last)); });
    }
    function txpowOf(resp) { return resp ? (resp.txpowid || '') : ''; }

    // ---- settlement scans (coinnotify-add a shared address FIRST, then a bounded state-filtered read) ----

    function scanState(value, coinageMin, depth, cb, megammr) {
        // SETTLEMENT scan: NO tokenid filter — the state: value (a unique hashlock or my pubkey) already scopes the
        // reply, and dropping the token filter lets a claim/refund find an in-flight coin in EITHER currency.
        M.cmd('coinnotify action:add address:' + HTLC_ADDRESS, function () {
            M.cmdR('coins coinage:' + coinageMin + ' simplestate:true state:' + normKey(value) +
                ' address:' + HTLC_ADDRESS + ' depth:' + depth + (megammr ? ' megammr:true' : ''), function (err, resp) {
                cb(err, (!err && Array.isArray(resp)) ? resp : []);
            });
        });
    }
    /** Open HTLC coins for one hashlock (state[5]). */
    function scanByHash(hash, coinageMin, depth, cb) { scanState(hash, coinageMin, depth, cb); }
    /** As scanByHash, but also asks the node to fall through into the MegaMMR once the TxPoW tree runs out.
     *  `coins` downgrades this itself (coins.java: checkmegammr = GeneralParams.IS_MEGAMMR), so a node not run
     *  with -megammr silently ignores it. On a MegaMMR node a coin I locked stays findable at ANY age — the only
     *  way to refund a lock older than the ~1024-block tree. Used by the expired-refund sweep. */
    function scanByHashDeep(hash, coinageMin, depth, cb) { scanState(hash, coinageMin, depth, cb, true); }
    /** Open HTLC coins carrying MY key — owner state[0] (coins I locked) or receiver state[4] (locked to me). */
    function scanByKey(myPubkey, coinageMin, depth, cb) { scanState(myPubkey, coinageMin, depth, cb); }

    /** Find the revealed-secret notify coin for ONE hashlock (a claim writes the hash to state[101]). The notify
     *  address is a SHARED global sink, so we coinnotify-add it then filter by state:<hash> (else a busy mainnet
     *  could return a multi-MB reply). cb(err, arr). */
    function scanNotifySecret(hash, depth, cb) {
        M.cmd('coinnotify action:add address:' + NOTIFY, function () {
            M.cmdR('coins simplestate:true depth:' + depth + ' state:' + normKey(hash) + ' address:' + NOTIFY,
                function (err, resp) { cb(err, (!err && Array.isArray(resp)) ? resp : []); });
        });
    }

    AX.htlc = {
        SCRIPT: HTLC_SCRIPT, ADDRESS: HTLC_ADDRESS, NOTIFY: NOTIFY, NOTIFY_AMOUNT: NOTIFY_AMOUNT,
        MINIMA_BLOCK_TIME: MINIMA_BLOCK_TIME, TIMELOCK_BLOCKS: TIMELOCK_BLOCKS, CP_BLOCKS: CP_BLOCKS,
        CP_BLOCKS_CHECK: CP_BLOCKS_CHECK, TIMELOCK_SECS: TIMELOCK_SECS, CP_SECS: CP_SECS, CP_SECS_CHECK: CP_SECS_CHECK,
        setup: setup, loadKeys: loadKeys, normKey: normKey, stateAt: stateAt,
        generateSecret: generateSecret, verifyPreimage: verifyPreimage, currentBlock: currentBlock, grain: grain, maybeGrain: maybeGrain,
        coinAmount: coinAmount, lock: lock, lockFromCoins: lockFromCoins, myFreeCoins: myFreeCoins,
        claim: claim, refund: refund, scanByHash: scanByHash, scanByHashDeep: scanByHashDeep,
        scanByKey: scanByKey, scanNotifySecret: scanNotifySecret,
        scanAllHtlcCoins: scanAllHtlcCoins,
        _txnId: txnId          // exported for the uniqueness test only
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
