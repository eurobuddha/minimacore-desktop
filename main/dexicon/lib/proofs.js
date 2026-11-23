/**
 * proofs — the coin proof hand-over (owner 22 Nov 2026: a maker must never have to keep its backing coins young).
 *
 * A light-node taker sees a third-party coin only inside its ~1024-block window, so an order backed by an older coin could
 * not be taken. But the maker's node can prove any of its own unspent coins (`coinexport coinid:`, pinned at its tip-256,
 * tip-8 on a -test chain) and the taker's node verifies that proof against its OWN chain (`coinimport data: track:false`:
 * the byte-exact coin, token descriptor included); after it `coins coinid:` and `txninput coinid: scriptmmr:true` find the
 * coin as if it were young (for one window after the proof block). Proven on a private chain, 22 Nov 2026.
 *
 * The proof cannot ride in the order: every relay (maxima dexrelay Envelope.java), every earlier Dexicon (lib/envelope.js
 * verify) and the Android verifier (envelope/Envelope.java) refuse an order whose keys are not exactly the spec set, signed
 * or not. So it travels as sealed messages, pulled when a taker needs it:
 *   taker → maker  {k:'proofs?', coins:[coinid]}         a coin of an order is not visible to the taker's node
 *   maker → taker  {k:'proofs', proofs:{coinid: data}}   coinexport of each asked coin that backs one of the maker's live
 *                                                        orders (more messages when they do not fit in one)
 * A maker on an earlier version (service.js tick, Android MakerService.onInbox) ignores an unknown k: the order then stays
 * hidden from that taker exactly as before.
 *
 * Nothing a maker sends is trusted. A taker imports only a proof it asked THAT maker for, whose bytes name the asked coin
 * at one of the order's own script addresses, at most IMPORTS_PER_BLOCK a block; its node verifies the rest (a stale or
 * forged proof is refused: "Invalid MMR Proof"). The coin is then judged by the unchanged takeable rules (token, state,
 * address, cover, unspent) and taken by the unchanged fill.js (takerGuard, then the maker's verifyAsMaker). Garbage proofs
 * buy an attacker nothing but its own hidden orders and a bounded number of refused imports.
 *
 * Rhino-safe (ES5). Read when they run: AX.fill (exportable), AX.takeable (the taker half). Attaches to AX.proofs.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    /** At most this many coins in one request (an order backs with at most 32). */
    var MAX_ASK = 32;
    /** A proof's data (0x + hex). MEASURED 580–888 chars on a -test chain; ~2.5–3.5K estimated on mainnet (unmeasured). */
    var MAX_PROOF_CHARS = 16000;
    /** Proof data per reply message. Sealing quadruples it (lib/identity.js seal: the plaintext travels hex-encoded inside the
     *  sealed payload, and the blob is hex again). 0.0.120 (M1): 14000 chars → a ~58K-char msg, so two of them fit one
     *  poll's REPLY_CHARS_PER_POLL (it was 60000 → ~241K, one message ~5 s of sealing in Rhino). */
    var REPLY_MAX_CHARS = 14000;
    /** Maker: coinexport commands per request batch (one inbox poll), whatever the number of senders. */
    var EXPORTS_PER_POLL = 64;
    /** Maker, review 23 Nov (M1): sealing + signing a ~240K-char reply costs ~5 s in Rhino, and anyone can ask (a taker
     *  cannot be authenticated: permissionless). So one poll seals at most REPLIES_PER_POLL messages and
     *  REPLY_CHARS_PER_POLL sealed chars, and spends at most TIME_BOX_MS on exports and sealing; what is left waits in a
     *  queue (QUEUE_SENDERS senders, MAX_ASK distinct coins each) for the next polls, after their takes. Review 23 Nov
     *  (MINOR-5): the queue is served ROUND ROBIN, one message per sender per turn, and holds 256 senders, so throwaway
     *  identities cannot starve an honest taker (it used to serve one sender to the end and drop the 17th); when it is
     *  full, a new sender takes the slot of the one served longest ago and goes ahead of all that have had a turn
     *  (0.0.150, enqueue). Proofs are
     *  public, but the relay has no broadcast (an order's keys are fixed; a msg has one recipient), so one copy per
     *  asker stays. */
    var REPLIES_PER_POLL = 2, REPLY_CHARS_PER_POLL = 120000, TIME_BOX_MS = 3000, QUEUE_SENDERS = 256;
    /** Taker: makers asked (one request each) and imports per block height, and how many heights before a coin is asked
     *  for again. */
    var ASKS_PER_BLOCK = 8, IMPORTS_PER_BLOCK = 16, ASK_EVERY = 10;
    /** 0.0.118: a coin is imported only when it was created more than this many blocks before the node's tree root
     *  (`status` chain.block - chain.length). The root only rises, so a coin under it stays under it; the margin covers
     *  the status read and the import being two commands, and off-by-one between `length` and the root block. */
    var ROOT_MARGIN = 4;

    function lc(s) { return String(s || '').toLowerCase(); }
    function isId(s) { return typeof s === 'string' && /^0x[0-9A-Fa-f]{64}$/.test(s); }
    function noop() { }

    /** The coin id and address a proof's bytes name, or null. CoinProof = Coin.writeDataStream then the MMR proof; a Coin
     *  starts with its coin id then its address, each MiniData.writeHashToStream = 4-byte length (0x20) + 32 bytes.
     *  0.0.118: also `created`, the block the coin was created in, read further on (Coin.writeDataStream: amount
     *  MiniNumber, tokenid hash, storestate byte, MMR entry (MiniNumber scale + MiniData), spent byte, then the created
     *  MiniNumber); -1 when the bytes do not parse that far, or the coin says it is spent. */
    function named(d) {
        if (typeof d !== 'string' || d.length < 146 || d.length > MAX_PROOF_CHARS || !/^0x[0-9A-Fa-f]+$/.test(d)) return null;
        if (d.substr(2, 8) !== '00000020' || d.substr(74, 8) !== '00000020') return null;
        return { coinid: '0x' + d.substr(10, 64).toUpperCase(), address: '0x' + d.substr(82, 64).toUpperCase(), created: createdOf(d) };
    }
    /** MiniNumber.writeDataStream = scale byte, length byte, the unscaled two's-complement big-endian bytes. */
    function createdOf(d) {
        var at = 146, n = d.length;
        function byte() { if (at + 2 > n) throw 0; var b = parseInt(d.substr(at, 2), 16); at += 2; return b; }
        function skip(k) { if (k < 0 || at + 2 * k > n) throw 0; at += 2 * k; }
        function int4() { var v = 0, i; for (i = 0; i < 4; i++) v = v * 256 + byte(); return v; }
        function num() { var scale = byte(), len = byte(), v = 0, i; if (len > 32) throw 0; for (i = 0; i < len; i++) v = v * 256 + byte(); return { scale: scale, len: len, v: v }; }
        try {
            num();                         // amount
            skip(int4());                  // tokenid (writeHashToStream: 4-byte length + bytes)
            byte();                        // storestate
            num(); skip(int4());           // MMR entry: scale MiniNumber, then the unscaled bytes as MiniData
            if (byte() !== 0) return -1;   // spent
            var c = num();
            // a block number: scale 0, at most 6 bytes (so exact in a double), positive
            return c.scale === 0 && c.len > 0 && c.len <= 6 && !(parseInt(d.substr(at - 2 * c.len, 2), 16) & 0x80) ? c.v : -1;
        } catch (e) { return -1; }
    }

    // ---------------- maker ----------------

    /** One export per coin per block height (the same height always gives the same proof). */
    var EXP = {}, EXP_TIP = 0, OKAT = {};
    function exportAt(mds, id, tip, cb) {
        if (tip !== EXP_TIP) { EXP = {}; EXP_TIP = tip; }
        var hit = EXP[lc(id)];
        if (hit) return cb(hit.err, hit.data, true);
        mds.cmdR('coinexport coinid:' + id, function (e, r) {
            var d = r && r.data, n = named(d);
            var res = !e && n && lc(n.coinid) === lc(id) ? { err: null, data: d } : { err: e || new Error('coinexport of ' + id + ' gave no proof of it'), data: null };
            if (tip === EXP_TIP) EXP[lc(id)] = res;
            if (res.err) delete OKAT[lc(id)];   // MINOR: a failed export ends "provable" now: the next refresh relocks the coin
            cb(res.err, res.data, false);
        });
    }
    function readTip(mds, cb) { mds.cmdR('block', function (e, b) { var t = (!e && b && parseInt(b.block, 10) > 0) ? parseInt(b.block, 10) : 0; cb(t); }); }

    /** Maker, the age rule (lib/maker.js, 0.0.113): which of `coins` (my wallet rows) my node can prove now. A coin with a
     *  proof may back an order at any age: an updated taker asks for its proof. Largest first, at most EXPORTS_PER_CHECK
     *  fresh exports a call; a success is remembered for PROOF_OK_BLOCKS heights (review 23 Nov, MINOR: 10, was 100 — an
     *  order kept on a coin its node can no longer prove fell back to the relock rule only up to 100 heights later), and
     *  forgotten at once when an export for a taker fails (exportAt). A failure is logged once (the coin is then
     *  kept young by a relock, as before). cb(map: lc coin id → true). */
    var PROOF_OK_BLOCKS = 10, EXPORTS_PER_CHECK = 64;
    function exportable(mds, coins, tip, cb) {
        var out = {}, todo = [], i, k;
        if (Object.keys(OKAT).length > 4096) OKAT = {};
        var sorted = (coins || []).slice().sort(function (a, b) { return AX.fill.coinValue(b).cmp(AX.fill.coinValue(a)); });
        for (i = 0; i < sorted.length; i++) {
            k = lc(sorted[i].coinid);
            if (OKAT[k] !== undefined && tip >= OKAT[k] && tip - OKAT[k] < PROOF_OK_BLOCKS) out[k] = true;
            else if (todo.length < EXPORTS_PER_CHECK && isId(sorted[i].coinid)) todo.push(sorted[i].coinid);
        }
        (function next() {
            if (!todo.length) return cb(out);
            var id = todo.shift();
            exportAt(mds, id, tip, function (e, d, cached) {
                if (!e) { OKAT[lc(id)] = tip; out[lc(id)] = true; }
                else if (!cached && g.MDS && typeof g.MDS.log === 'function') g.MDS.log('[dexicon] no coin proof for ' + id + ' (' + (e.message || e) + '): it backs orders only while young, kept so by a relock as before');
                next();
            });
        })();
    }

    var QUEUE = [], SENT = {}, SEALED = {}, SEALED_TIP = 0, clock = function () { return Date.now(); };
    function pending() { return QUEUE.length > 0; }
    /** A request's items: coin ids (a proof each) and, since 0.0.128, 'a:' + address (an attestation each). */
    function enqueue(requests, tip) {
        (requests || []).forEach(function (rq) {
            if (!rq || typeof rq.from !== 'string') return;
            var q = null, i, keys = {};
            for (i = 0; i < QUEUE.length; i++) if (QUEUE[i].from === rq.from) q = QUEUE[i];
            if (!q) {
                // review 23 Nov (0.0.150): a full queue no longer turns a NEW sender away (256 throwaway identities locked
                // every honest taker out until they had all been served): the queued sender served longest ago gives up
                // its slot (it has had a turn; it asks again later), and a sender never served goes ahead of every one
                // that has had a turn — each sender's first message before anyone's next. Only a queue of senders none of
                // whom has had a turn yet refuses a newcomer (it asks again; a turn is served every poll).
                var first = -1;
                for (i = 0; i < QUEUE.length; i++) if (QUEUE[i].turns) { first = i; break; }
                if (QUEUE.length >= QUEUE_SENDERS) { if (first < 0) return; QUEUE.splice(first, 1); }
                q = { from: rq.from, coins: [], at: tip, turns: 0 };
                QUEUE.splice(first < 0 ? QUEUE.length : first, 0, q);
            }
            q.coins.forEach(function (k) { keys[lc(k)] = true; });
            function add(k, cap) { var n = q.coins.filter(function (x) { return (x.indexOf('a:') === 0) === (k.indexOf('a:') === 0); }).length; if (n < cap && !keys[lc(k)]) { keys[lc(k)] = true; q.coins.push(k); } }
            ((rq.attest) || []).forEach(function (a) { if (isId(a)) add('a:' + a, MAX_ASK); });
            ((rq.coins) || []).forEach(function (c) { if (isId(c)) add(c, MAX_ASK); });
        });
    }

    /** 0.0.128, the coin-key attestation (owner 23 Nov 2026: "make the maker prove he owns the coins"): the statement a
     *  backing address's key signs to say "this address backs the orders of maker identity signPk". data = SHA3-256 of
     *  UTF-8 "dexicon-backing-v1" · signPk (32 bytes) · address (32 bytes), as '0x' + 64 hex. Needs AXSHA3 (doors/sha3.js). */
    var ATTEST_TAG = 'dexicon-backing-v1';
    function hexBytes(h) { var out = [], i; h = String(h).replace(/^0x/i, ''); for (i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16)); return out; }
    function statement(signPk, address) {
        if (!isId(signPk) || !isId(address)) return null;
        var b = [], i; for (i = 0; i < ATTEST_TAG.length; i++) b.push(ATTEST_TAG.charCodeAt(i));
        return '0x' + String(g.AXSHA3.sha3_256(b.concat(hexBytes(signPk), hexBytes(address)))).toUpperCase();
    }
    /** The public key of a simple address script `RETURN SIGNEDBY(0x<pk>)` (the only kind a maker backs with), or null. */
    function scriptPk(script) { var m = /^RETURN SIGNEDBY\((0x[0-9A-Fa-f]{64})\)$/.exec(String(script || '')); return m ? m[1] : null; }

    /** Maker: the attestation of `address` (key `pk`) for MY identity `signPk`. Signed ONCE per (identity, address), ever:
     *  kept in memory and in kv 'attest_<signPk>_<address>' (both lower case); only a miss runs `sign` (one key use of
     *  that address's key; WRITE). cb(err, signatureHex, fresh). */
    var ATT = {};
    function attestFor(mds, signPk, address, pk, cb) {
        var key = 'attest_' + lc(signPk) + '_' + lc(address), data = statement(signPk, address);
        if (ATT[key]) return cb(null, ATT[key], false);
        if (!data) return cb(new Error('no statement for ' + address));
        mds.kvGet(key, '', function (have) {
            if (/^0x[0-9A-Fa-f]+$/.test(String(have || ''))) { ATT[key] = have; return cb(null, have, false); }
            mds.cmdR('sign publickey:' + pk + ' data:' + data, function (e, sig) {
                sig = typeof sig === 'string' ? sig : '';
                if (e || !/^0x[0-9A-Fa-f]+$/.test(sig) || sig.length > MAX_PROOF_CHARS) return cb(e || new Error('sign gave no signature for ' + address));
                ATT[key] = sig;
                mds.kvSet(key, sig, function () { cb(null, sig, true); });
            });
        });
    }
    /** Maker: fresh `sign` commands per poll (each a key use, once per address ever). */
    var SIGNS_PER_POLL = 4;

    /**
     * Maker: answer the proof requests of one inbox poll, [{from, coins, attest}], plus what earlier polls left queued. Only
     * coins that back one of MY live orders are exported (never another coin of my wallet), and only addresses of the
     * scripts my live orders publish are attested (0.0.128). seal(to, obj) → the raw sealed message (the caller's
     * identity.seal + envelope.msg); signPk: my identity's signing key ('0x' + 64 hex). cb(replies) with replies =
     * [{to, raw, coins: [ids, 'a:' + address]}], to be published as they are: {k:'proofs', proofs:{coinid: data},
     * attest:{address: signature}}. Review 23 Nov (M1), the work per poll is bounded whoever asks:
     *   - at most REPLIES_PER_POLL messages / REPLY_CHARS_PER_POLL sealed chars / TIME_BOX_MS, EXPORTS_PER_POLL fresh
     *     coinexports and SIGNS_PER_POLL fresh signs; the rest stays queued (oldest sender first) for the next poll,
     *     which answers its takes first;
     *   - an item is sent to one sender at most once per ASK_EVERY heights (a taker asks no more often); a repeat asked
     *     at the SAME height is answered with the message already sealed for that sender (no export, no seal);
     *   - a request's items are de-duplicated before MAX_ASK applies (NIT: 32 copies of one coin no longer hid the rest).
     */
    /** 0.0.152: kv `attest_sign` — this maker's coin-key attestations. ON when unset (the MiniDapp's default) and for any
     *  value but '0', 'false', 'off', 'no' (any case). OFF: no attestation is signed or sent (the requests' attestation
     *  items are dropped; coin proofs are answered as before). A host can also keep it off by passing no signPk. */
    function attestOn(v) { return !/^(0|false|off|no)$/i.test(String(v === undefined || v === null ? '' : v).replace(/^\s+|\s+$/g, '')); }
    function answer(mds, list, requests, cb, seal, signPk) {
        if (signPk && typeof mds.kvGet === 'function') return mds.kvGet('attest_sign', '', function (v) { answerWith(mds, list, requests, cb, seal, attestOn(v) ? signPk : null); });
        answerWith(mds, list, requests, cb, seal, signPk);
    }
    function answerWith(mds, list, requests, cb, seal, signPk) {
        var backs = {}, addrs = {}, out = [], spent = 0, signs = 0, msgs = 0, chars = 0, t0 = clock();
        (list || []).forEach(function (o) {
            if (!o || o.status !== 'live') return;
            (o.coins || []).forEach(function (c) { backs[lc(c)] = true; });
            (o.scripts || []).forEach(function (sc) { var pk = scriptPk(sc); if (pk && AX.takeable) addrs[lc(AX.takeable.scriptAddress(sc))] = pk; });
        });
        readTip(mds, function (tip) {
            var k;
            if (tip !== SEALED_TIP) { SEALED = {}; SEALED_TIP = tip; }
            if (Object.keys(SENT).length > 8192) SENT = {};
            if (Object.keys(ATT).length > 4096) ATT = {};
            for (k in SENT) if (SENT.hasOwnProperty(k) && tip - SENT[k] >= ASK_EVERY) delete SENT[k];
            enqueue(requests, tip);
            function full() { return msgs >= REPLIES_PER_POLL || chars >= REPLY_CHARS_PER_POLL || clock() - t0 >= TIME_BOX_MS; }
            function emit(to, proofs, attest, ids) {
                var obj = { k: 'proofs', proofs: proofs };
                if (Object.keys(attest).length) obj.attest = attest;
                var raw = seal(to, obj);
                msgs++; chars += raw.length;
                ids.forEach(function (c) { SENT[lc(to) + '|' + lc(c)] = tip; });
                var sd = SEALED[lc(to)] || (SEALED[lc(to)] = { coins: {}, raws: [] });
                ids.forEach(function (c) { sd.coins[lc(c)] = true; }); sd.raws.push(raw);
                out.push({ to: to, raw: raw, coins: ids });
            }
            function wanted(key) { return key.indexOf('a:') === 0 ? !!(signPk && addrs[lc(key.slice(2))]) : !!backs[lc(key)]; }
            (function nextReq() {
                if (!QUEUE.length || full()) return cb(out);
                var rq = QUEUE[0], from = lc(rq.from), sd = SEALED[from], ids = [], chunk = {}, att = {}, cids = [], size = 0, ci = 0;
                rq.coins = rq.coins.filter(wanted);
                if (sd && rq.coins.length && rq.coins.every(function (c) { return sd.coins[lc(c)]; })) {   // asked again at this height
                    QUEUE.shift();
                    sd.raws.forEach(function (raw) { msgs++; chars += raw.length; out.push({ to: rq.from, raw: raw, coins: [], again: true }); });
                    return nextReq();
                }
                rq.coins.forEach(function (c) { if (!(SENT[from + '|' + lc(c)] >= 0)) ids.push(c); });
                function turnEnds() {   // MINOR-5: one message a turn; a sender with more waits at the back of the queue
                    rq.coins = ids.slice(ci); rq.turns = (rq.turns || 0) + 1;
                    QUEUE.shift(); if (rq.coins.length) QUEUE.push(rq);
                    return nextReq();
                }
                (function nextCoin() {
                    if (ci >= ids.length || full()) { if (size) emit(rq.from, chunk, att, cids); return turnEnds(); }
                    var id = ids[ci], isA = id.indexOf('a:') === 0, addr = isA ? id.slice(2) : '';
                    if (isA ? (signs >= SIGNS_PER_POLL && !ATT['attest_' + lc(signPk) + '_' + lc(addr)]) : (spent >= EXPORTS_PER_POLL && !(tip === EXP_TIP && EXP[lc(id)]))) {
                        if (size) emit(rq.from, chunk, att, cids);
                        rq.coins = ids.slice(ci); return cb(out);
                    }
                    function got(e, d, fresh) {
                        ci++;
                        if (fresh) { if (isA) signs++; else spent++; }
                        if (e) return nextCoin();
                        var add = d.length + (isA ? addr : id).length + 6;   // NIT (proofs.js:117): the size check counts what is added
                        if (size && size + add > REPLY_MAX_CHARS) { emit(rq.from, chunk, att, cids); ci--; return turnEnds(); }
                        if (isA) att[addr] = d; else chunk[id] = d;
                        cids.push(id); size += add;
                        nextCoin();
                    }
                    if (isA) attestFor(mds, signPk, addr, addrs[lc(addr)], function (e, sig, fresh) { if (e && g.MDS && typeof g.MDS.log === 'function') g.MDS.log('[dexicon] attestation of ' + addr + ' not signed: ' + (e.message || e)); got(e, sig, fresh); });
                    else exportAt(mds, id, tip, function (e, d, cached) { got(e, d, !cached); });
                })();
            })();
        });
    }

    // ---------------- taker ----------------

    /**
     * Taker(opts): opts.cmd(command, cb(err, response)) runs one node command (AX.mds.cmdR), opts.count() is told of each;
     * opts.send(order, coinIds) seals and publishes a request to the order's maker; opts.proven(coinIds, by) is told the coins
     * this node now sees (by: lc coin id → lc publicId of the maker whose proof this node imported, for imported ones);
     * opts.log(line). The page calls onBlock(tip) on every block, want(order) when a coin of the order is not visible,
     * flush() after each verdict pass, and reply(fromPublicId, proofs) for every opened {k:'proofs'} message.
     * Review 23 Nov (M2): want() only QUEUES the order's coins under its maker; flush() sends ONE request per maker per
     * height covering all of them (up to MAX_ASK, the maker merges up to 32), to at most ASKS_PER_BLOCK makers a height.
     */
    function Taker(opts) {
        opts = opts || {};
        this.cmd = opts.cmd; this.send = opts.send || noop; this.proven = opts.proven || noop; this.log = opts.log || noop;
        this.count = opts.count || noop;   // told of every node command (the page counts them in the verdict cache's budget)
        // 0.0.137: opts.lock(body(release(k)), fail()) serialises imports across this node's pages (none: unlocked)
        this.lock = opts.lock || function (body) { body(function (k) { k(); }); };
        this.short = {};      // lc maker → {until, wait}: its proofs are deeper than this node's tree (NIT-1: per maker)
        // lc coin id → {lc maker publicId → {addrs: {lc address: true}, at: height asked}}. Review 23 Nov (MAJOR-2): one entry
        // PER MAKER — it used to be one per coin, overwritten by whichever maker's order was visited last, so a copycat
        // listing the coin at a worse price became its only "asked" maker and the honest order was hidden for the session
        this.asked = {};
        this.pend = {};       // lc maker → {order (any of its orders: send uses its pubId), coins} queued at this height
        this.sentAt = {};     // lc maker → the height its request was sent
        this.tip = 0; this.asks = 0; this.imports = 0;
        this.jobs = []; this.busy = false;
        // 0.0.129, the coin-key attestation (taker half): opts.attested(address, signPk, ok) is told every verdict;
        // opts.known: ['lc signPk|lc address'] verified before (the page keeps them in kv 'attested')
        this.attested = opts.attested || noop;
        this.attOk = {};      // lc signPk|lc address → true (verified) / false (a signature this node refused)
        this.attAsked = {};   // lc maker|lc address → {at, pk}
        this.vjobs = []; this.vbusy = false;
        (opts.known || []).forEach(function (k) { this.attOk[lc(k)] = true; }, this);
    }
    Taker.prototype.onBlock = function (tip) {
        if (!(tip > this.tip)) return;
        // review 23 Nov (MINOR-1): `pend` is kept: a block landing mid-pass used to clear what that pass had queued before it
        // flushed, so nothing was sent and the coins (stamped as asked) were not asked again for ASK_EVERY heights
        this.tip = tip; this.asks = 0; this.imports = 0;
        for (var k in this.asked) if (this.asked.hasOwnProperty(k)) {
            for (var m in this.asked[k]) if (this.asked[k].hasOwnProperty(m) && tip - this.asked[k][m].at > ASK_EVERY * 10) delete this.asked[k][m];
            if (!Object.keys(this.asked[k]).length) delete this.asked[k];
        }
        this.run();   // M2: proofs left over by the import cap are imported now, not asked again
    };
    /** Queue the order's coins not asked of its maker in the last ASK_EVERY heights for this height's request to that
     *  maker. true when queued (sent by flush()); 'later' when this height's request to that maker, or this height's
     *  makers, are full (the caller re-checks it at the next height); false when there is nothing to ask. */
    /** The addresses of the order's simple scripts whose attestation for the order's identity this node lacks and has not
     *  asked its maker for within ASK_EVERY heights: [{address, pk}]. */
    Taker.prototype.unattested = function (order) {
        var out = [], maker = lc(order && order.pubId), signPk = '0x' + maker.slice(-64), i, pk, ad, q;
        for (i = 0; i < (order.scripts || []).length && out.length < MAX_ASK; i++) {
            pk = scriptPk(order.scripts[i]); if (!pk) continue;
            ad = lc(AX.takeable.scriptAddress(order.scripts[i]));
            if (this.attOk[signPk + '|' + ad] !== undefined) continue;
            q = this.attAsked[maker + '|' + ad];
            if (q && this.tip - q.at < ASK_EVERY) continue;
            out.push({ address: ad, pk: pk });
        }
        return out;
    };
    /** Queue an attestation request for the order's unattested addresses (0.0.129). true / 'later' / false as want(). */
    Taker.prototype.wantAttest = function (order) {
        var maker = lc(order && order.pubId), need, p, self = this;
        if (!/^0x[0-9a-f]{128}$/.test(maker)) return false;
        need = this.unattested(order);
        if (!need.length) return false;
        p = this.pend[maker];
        if (!p) {
            if (this.sentAt[maker] === this.tip || this.asks + Object.keys(this.pend).length >= ASKS_PER_BLOCK) return 'later';
            p = this.pend[maker] = { order: order, coins: [] };
        }
        p.attest = p.attest || [];
        need.forEach(function (x) { if (p.attest.length < MAX_ASK && p.attest.indexOf(x.address) < 0) { p.attest.push(x.address); self.attAsked[maker + '|' + x.address] = { at: self.tip, pk: x.pk }; } });
        return true;
    };
    Taker.prototype.want = function (order) {
        var ids = [], addrs = {}, i, a, maker = lc(order && order.pubId), p;
        if (!/^0x[0-9a-f]{128}$/.test(maker)) return false;
        for (i = 0; i < (order.coins || []).length && ids.length < MAX_ASK; i++) {
            a = this.asked[lc(order.coins[i])]; a = a && a[maker];
            if (isId(order.coins[i]) && (!a || this.tip - a.at >= ASK_EVERY)) ids.push(order.coins[i]);
        }
        if (!ids.length) return false;
        var sh = this.short[maker];   // NIT-1 (0.0.141): per maker — one maker's over-deep proofs never stop the others'
        if (sh && this.tip < sh.until) return 'this node\'s chain tree is too short to import its maker\'s coin proof (retried from block ' + sh.until + ')';
        p = this.pend[maker];
        if (!p) {
            if (this.sentAt[maker] === this.tip || this.asks + Object.keys(this.pend).length >= ASKS_PER_BLOCK) return 'later';
            p = this.pend[maker] = { order: order, coins: [] };
        }
        if (p.coins.length + ids.length > MAX_ASK) return 'later';
        for (i = 0; i < (order.scripts || []).length; i++) addrs[lc(AX.takeable.scriptAddress(order.scripts[i]))] = true;
        for (i = 0; i < ids.length; i++) { (this.asked[lc(ids[i])] = this.asked[lc(ids[i])] || {})[maker] = { addrs: addrs, at: this.tip }; p.coins.push(ids[i]); }
        this.wantAttest(order);   // 0.0.129: the same request asks the attestation of its addresses
        return true;
    };
    /** Send this height's queued requests: one per maker. */
    Taker.prototype.flush = function () {
        var k, p;
        for (k in this.pend) if (this.pend.hasOwnProperty(k)) {
            p = this.pend[k];
            this.sentAt[k] = this.tip; this.asks++;
            for (var i = 0; i < p.coins.length; i++) if (this.asked[lc(p.coins[i])] && this.asked[lc(p.coins[i])][k]) this.asked[lc(p.coins[i])][k].at = this.tip;   // asked when SENT
            this.send(p.order, p.coins, p.attest || []);
        }
        this.pend = {};
        if (Object.keys(this.sentAt).length > 4096) this.sentAt = {};
    };
    /** A {k:'proofs'} reply from `from`. Each proof is checked before anything reaches the node (asked of this maker, names
     *  the asked coin, at one of the order's script addresses); then: already visible → nothing imported; else
     *  `coinimport data:<proof> track:false` and the coin must then be visible under its own id. */
    Taker.prototype.reply = function (from, proofs, attest) {
        var self = this, maker = lc(from), keys = proofs && typeof proofs === 'object' ? Object.keys(proofs).slice(0, MAX_ASK) : [];
        // 0.0.129: attestations — only of addresses asked of THIS maker; the statement is rebuilt from the maker's OWN
        // signPk (the end of its publicId, which every order of it carries), so a signature made for another identity fails
        (attest && typeof attest === 'object' ? Object.keys(attest).slice(0, MAX_ASK) : []).forEach(function (ad) {
            var q = self.attAsked[maker + '|' + lc(ad)], sig = attest[ad], signPk = '0x' + maker.slice(-64);
            if (!q || typeof sig !== 'string' || !/^0x[0-9A-Fa-f]+$/.test(sig) || sig.length > MAX_PROOF_CHARS) return;
            if (self.attOk[signPk + '|' + lc(ad)] !== undefined) return;
            self.vjobs.push({ address: lc(ad), pk: q.pk, signPk: signPk, sig: sig, from: from });
        });
        this.verify();
        keys.forEach(function (id) {
            var a = self.asked[lc(id)] && self.asked[lc(id)][maker], d = proofs[id], n = named(d);
            if (!a) return;                                          // never asked this maker for it: ignored, no log (bounded)
            if (!n || lc(n.coinid) !== lc(id)) return self.log('Coin proof refused: the proof maker ' + from + ' sent for coin ' + id + ' is not a proof of that coin' + (n ? ' (it names ' + n.coinid + ')' : '') + '.');
            if (!a.addrs[lc(n.address)]) return self.log('Coin proof refused: coin ' + id + ' from maker ' + from + ' is at ' + n.address + ', not at the address of any script its order publishes.');
            self.jobs.push({ id: id, d: d, from: from, created: n.created });
        });
        this.run();
    };
    /** 0.0.129: check the attestations one at a time with `verify publickey:<the address's pk> data:<statement for the
     *  maker's signPk> signature:<sig>` (READ). Valid → attested(address, signPk, true); refused by the node ("Signature
     *  NOT valid", "Signature publickey is different") → false, logged; any other error → asked again later. */
    Taker.prototype.verify = function () {
        var self = this;
        if (this.vbusy) return;
        this.vbusy = true;
        (function next() {
            var j = self.vjobs.shift(), data;
            if (!j) { self.vbusy = false; return; }
            data = statement(j.signPk, '0x' + j.address.slice(2).toUpperCase());
            self.count(); self.cmd('verify publickey:' + j.pk + ' data:' + data + ' signature:' + j.sig, function (e) {
                var msg = e ? String(e.message || e) : '';
                if (e && !/NOT valid|publickey is different/i.test(msg)) { delete self.attAsked[lc(j.from) + '|' + j.address]; return next(); }
                var ok = !e, key = j.signPk + '|' + j.address;
                if (Object.keys(self.attOk).length > 8192) self.attOk = {};
                self.attOk[key] = ok;
                if (!ok) self.log('Coin-key attestation refused: maker ' + j.from + ' sent a signature for address ' + j.address + ' that is not its key\'s statement for that maker (' + msg.replace(/^cmd failed: verify .*? — /, '') + ').');
                self.attested(j.address, j.signPk, ok);
                next();
            });
        })();
    };
    /** 0.0.118: the height below which a coin is outside this node's tree, read once a height (`status`); cb(bound) with
     *  bound = chain.block - chain.length, or 0 when it could not be read. */
    Taker.prototype.bound = function (cb) {
        var self = this, tip = this.tip;
        if (this.boundAt && this.boundAt.tip === tip && tip > 0) return cb(this.boundAt.bound);
        this.count(); this.cmd('status', function (e, st) {
            var c = !e && st && st.chain, b = c ? parseInt(c.block, 10) - parseInt(c.length, 10) : 0;
            b = b > 0 ? b : 0;
            if (b) self.boundAt = { tip: tip, bound: b };
            cb(b);
        });
    };
    /**
     * Import the checked proofs, one at a time. Review 23 Nov (M3, phantom balance): `coinimport` of a coin the node already
     * holds in its tree takes its "already have it" branch and marks the coin RELEVANT whatever track:false says
     * (coinimport.java): the maker's coin then shows in this node's confirmed balance. So a coin is imported only when
     *   - `coins coinid:` answered (an error is not "not there": nothing is imported, the coin is asked again later), and
     *     did not return it; and
     *   - its created block, read from the proof's own bytes, is more than ROOT_MARGIN blocks under this node's tree root.
     *     A coin inside the window is never imported: it is either visible, or spent, or not here yet.
     * Imports run one at a time on this node (opts.lock, 0.0.137), so two pages never import the same coin together.
     */
    Taker.prototype.run = function () {
        var self = this, proven = [], by = {};
        function forget(j) { var a = self.asked[lc(j.id)]; if (a) { delete a[lc(j.from)]; if (!Object.keys(a).length) delete self.asked[lc(j.id)]; } }
        if (this.busy) return;
        this.busy = true;
        (function next() {
            var j = self.jobs.shift();
            if (!j || self.imports >= IMPORTS_PER_BLOCK) {   // M2: over this height's import cap, the proofs wait for the next height
                if (j) self.jobs.unshift(j);
                self.busy = false; if (proven.length) self.proven(proven, by); return;
            }
            // review 23 Nov (MINOR-4): one import at a time on this node (opts.lock: the page's SQL lease lock 'coinimport'),
            // so two pages can never both find a coin missing and both import it (the second import's "already have it"
            // branch marks it relevant). It used to untrack such a coin afterwards (`cointrack enable:false`), which could
            // untrack a coin ANOTHER app had started tracking meanwhile — that call is gone.
            self.lock(function (release) {
                function done() { release(function () { next(); }); }
                self.count(); self.cmd('coins coinid:' + j.id, function (e0, seen) {
                    if (e0) { forget(j); return done(); }                                            // unknown: never import blind
                    if (seen && seen.length) { proven.push(j.id); return done(); }                    // visible already
                    self.bound(function (bound) {
                        if (!bound) { forget(j); return done(); }                                     // the tree is unknown: asked again later
                        if (!(j.created > 0) || j.created >= bound - ROOT_MARGIN) return done();      // inside the window: never imported
                        self.imports++;
                        self.count(); self.cmd('coinimport data:' + j.d + ' track:false', function (e1) {
                            var why = e1 ? String(e1.message || e1).replace(/^cmd failed: coinimport data:\S+ track:false — /, '') : '';
                            // review 23 Nov (MINOR): a tree shorter than the makers' proof depth can NEVER import: said once, then
                            // nothing is asked for ASK_EVERY heights, doubling to 640, the orders hidden with that reason
                            if (e1 && /TreeNode at Blocktime not found|proof too old/i.test(why)) {
                                var mk = lc(j.from), was = self.short[mk], w = was ? Math.min(was.wait * 2, 640) : ASK_EVERY;
                                if (!was) self.log('This node cannot import the coin proofs of maker ' + j.from + ': its chain tree is shorter than the depth they are proved at (' + why + '). That maker\'s FAST orders on coins older than this node\'s window stay hidden; tried again from block ' + (self.tip + w) + ', backing off to every 640 blocks.');
                                self.short[mk] = { until: self.tip + w, wait: w };
                                return done();
                            }
                            if (e1) { self.log('Coin proof of ' + j.id + ' from maker ' + j.from + ' refused by this node: ' + why + ' — its order is not takeable now.'); return done(); }
                            delete self.short[lc(j.from)];
                            self.count(); self.cmd('coins coinid:' + j.id, function (e2, rows) {
                                // review 23 Nov (COPYCAT, partial): the maker whose proof made the coin visible is remembered
                                // (by: lc coin id → lc publicId); only that maker's orders can be judged takeable on it
                                // MAJOR-2: a coin asked of two or more makers is CONTESTED ('*'): no prover is recorded for it
                                // (the coin-key attestation decides; without one, the book's one-coin-one-order rule)
                                if (!e2 && rows && rows[0] && lc(rows[0].coinid) === lc(j.id)) { proven.push(j.id); by[lc(j.id)] = Object.keys(self.asked[lc(j.id)] || {}).length > 1 ? '*' : lc(j.from); }
                                else self.log('Coin proof of ' + j.id + ' from maker ' + j.from + ' imported, but this node still does not show the coin — its order is not takeable now.');
                                done();
                            });
                        });
                    });
                });
            }, function () { forget(j); next(); });   // the lock could not be had: asked again later
        })();
    };

    AX.proofs = { named: named, answer: answer, attestOn: attestOn, exportable: exportable, Taker: Taker, MAX_ASK: MAX_ASK, MAX_PROOF_CHARS: MAX_PROOF_CHARS, REPLY_MAX_CHARS: REPLY_MAX_CHARS, EXPORTS_PER_POLL: EXPORTS_PER_POLL, PROOF_OK_BLOCKS: PROOF_OK_BLOCKS,
                  ASKS_PER_BLOCK: ASKS_PER_BLOCK, IMPORTS_PER_BLOCK: IMPORTS_PER_BLOCK, ASK_EVERY: ASK_EVERY, ROOT_MARGIN: ROOT_MARGIN, REPLIES_PER_POLL: REPLIES_PER_POLL, SIGNS_PER_POLL: SIGNS_PER_POLL, statement: statement, scriptPk: scriptPk, ATTEST_TAG: ATTEST_TAG, REPLY_CHARS_PER_POLL: REPLY_CHARS_PER_POLL, TIME_BOX_MS: TIME_BOX_MS, pending: pending,
                  _clock: function (f) { clock = f || function () { return Date.now(); }; },
                  _reset: function () { EXP = {}; EXP_TIP = 0; OKAT = {}; QUEUE = []; SENT = {}; SEALED = {}; SEALED_TIP = 0; ATT = {}; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
