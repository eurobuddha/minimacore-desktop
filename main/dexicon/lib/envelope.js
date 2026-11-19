/**
 * envelope — the SPEC §3 order/msg envelope: canonical JSON subset, Ed25519 sign (AX.identity signSk) and verify,
 * with EXACTLY the shape rules the Java relay (maxima/dexrelay Envelope.java) enforces, so a client never
 * publishes what a relay will refuse and never accepts what a relay would have refused.
 * Rhino-safe (ES5, no BigInt). Requires AX.hex, AX.sodium. Attaches to AX.envelope.
 *
 * Canonical = keys sorted by code unit, no whitespace, "sig" omitted, strings printable ASCII without " or \.
 * Reference vector: spec/vectors/order-v1-vector.json (identical bytes/sig under Node, Rhino and the Java relay).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var H = AX.hex, S = AX.sodium;

    var MAX_ORDER_BYTES = 16 * 1024, MAX_MSG_BYTES = 256 * 1024, MAX_AHEAD_ORDER = 86400, MAX_AHEAD_MSG = 600, MAX_COINS = 32;
    var ORDER_KEYS = ['address', 'amount', 'coins', 'expiry', 'market', 'orderId', 'price', 'pubId', 'scripts', 'seq', 'side', 'sig', 'signPk', 't', 'v'];
    var SIMPLE_SCRIPT = /^RETURN SIGNEDBY\(0x[0-9A-Fa-f]{64}\)$/;   // v1 backs orders with simple-address coins only (txnsign auto signs those)
    var MSG_KEYS = ['blob', 'expiry', 'from', 'sig', 't', 'to', 'v'];
    var DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/;
    var MARKET = /^[A-Za-z0-9\/_-]{1,32}$/;
    var MAX_SAFE = 9007199254740991;

    function safeString(s) {
        if (typeof s !== 'string') return false;
        for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c < 0x20 || c > 0x7E || c === 0x22 || c === 0x5C) return false; }
        return true;
    }
    function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && Math.abs(n) <= MAX_SAFE; }
    function is0x(s, bytes) { return typeof s === 'string' && s.length === 2 + bytes * 2 && /^0x[0-9a-fA-F]+$/.test(s); }
    function isBareHex(s, maxBytes) { return typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && s.length <= maxBytes * 2 && /^[0-9a-fA-F]+$/.test(s); }

    /** Canonical JSON of a flat object (sig omitted). Throws on anything outside the subset. */
    function canonical(obj) {
        var keys = Object.keys(obj).filter(function (k) { return k !== 'sig'; }).sort();
        var parts = [];
        for (var i = 0; i < keys.length; i++) {
            if (!safeString(keys[i])) throw new Error('unsafe key');
            parts.push('"' + keys[i] + '":' + value(obj[keys[i]]));
        }
        return '{' + parts.join(',') + '}';
    }
    function value(v) {
        if (v === null) return 'null';
        if (typeof v === 'string') { if (!safeString(v)) throw new Error('unsafe string'); return '"' + v + '"'; }
        if (typeof v === 'number') { if (!isInt(v)) throw new Error('non-integer number'); return String(v); }
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (Object.prototype.toString.call(v) === '[object Array]') {
            var out = [];
            for (var i = 0; i < v.length; i++) {
                var e = v[i];
                if (e !== null && (typeof e === 'object')) throw new Error('nested container');
                out.push(value(e));
            }
            return '[' + out.join(',') + ']';
        }
        throw new Error('unsupported value');
    }

    function sameKeys(obj, want) {
        var ks = Object.keys(obj).sort();
        if (ks.length !== want.length) return false;
        for (var i = 0; i < ks.length; i++) if (ks[i] !== want[i]) return false;
        return true;
    }
    function isCancelAmount(a) { return /^[0.]+$/.test(a); }

    /**
     * verify(rawJsonString, nowSeconds) → { ok:true, kind:'order'|'msg', env, raw, key } | { ok:false, error }.
     * Shape errors come first (cheap), 'bad signature' last — mirrors Envelope.java.
     */
    function verify(raw, now) {
        var env;
        try { env = JSON.parse(raw); } catch (e) { return bad('bad json'); }
        if (!env || typeof env !== 'object' || Object.prototype.toString.call(env) === '[object Array]') return bad('bad json');
        if (env.v !== 1) return bad('v must be 1');
        var kind = env.t === 'order' ? 'order' : env.t === 'msg' ? 'msg' : null;
        if (!kind) return bad('t must be order or msg');
        if (!sameKeys(env, kind === 'order' ? ORDER_KEYS : MSG_KEYS)) return bad('keys must be exactly the spec set');
        if (raw.length > (kind === 'order' ? MAX_ORDER_BYTES : MAX_MSG_BYTES)) return bad('too big');
        if (!isInt(env.expiry)) return bad('expiry must be an integer');
        if (env.expiry <= now) return bad('expired');
        if (env.expiry > now + (kind === 'order' ? MAX_AHEAD_ORDER : MAX_AHEAD_MSG)) return bad('expiry too far ahead');
        if (!is0x(env.sig, 64)) return bad('sig must be 0x + 64 bytes');
        var pkHex;
        if (kind === 'order') {
            if (typeof env.market !== 'string' || !MARKET.test(env.market)) return bad('bad market');
            if (env.side !== 'buy' && env.side !== 'sell') return bad('side must be buy or sell');
            if (typeof env.price !== 'string' || !DECIMAL.test(env.price) || isCancelAmount(env.price)) return bad('bad price');
            if (typeof env.amount !== 'string' || !DECIMAL.test(env.amount)) return bad('bad amount');
            if (Object.prototype.toString.call(env.coins) !== '[object Array]' || env.coins.length > MAX_COINS) return bad('bad coins');
            for (var i = 0; i < env.coins.length; i++) if (!is0x(env.coins[i], 32)) return bad('bad coinid');
            if (Object.prototype.toString.call(env.scripts) !== '[object Array]' || env.scripts.length > MAX_COINS) return bad('bad scripts');
            for (var j = 0; j < env.scripts.length; j++) if (typeof env.scripts[j] !== 'string' || !SIMPLE_SCRIPT.test(env.scripts[j])) return bad('bad script (simple RETURN SIGNEDBY only)');
            if (!is0x(env.address, 32)) return bad('bad address');
            if (!is0x(env.orderId, 8)) return bad('bad orderId');
            if (!isInt(env.seq) || env.seq < 0) return bad('seq must be a non-negative integer');
            if (!is0x(env.signPk, 32)) return bad('bad signPk');
            if (!is0x(env.pubId, 64)) return bad('bad pubId (publicId = 0x + 64 bytes)');
            if (env.pubId.slice(2 + 64).toLowerCase() !== env.signPk.slice(2).toLowerCase()) return bad('pubId must end with signPk');
            pkHex = env.signPk.slice(2);
        } else {
            if (!is0x(env.to, 64)) return bad('bad to (publicId = 0x + 64 bytes)');
            if (!is0x(env.from, 64)) return bad('bad from (publicId = 0x + 64 bytes)');
            if (!isBareHex(env.blob, MAX_MSG_BYTES / 2)) return bad('bad blob hex');
            pkHex = env.from.slice(2 + 64);
        }
        var canon;
        try { canon = canonical(env); } catch (e) { return bad('bad json: ' + e.message); }
        var okSig = false;
        try { okSig = S.signVerify(H.from(env.sig), H.utf8(canon), H.from('0x' + pkHex)); } catch (e) { okSig = false; }
        if (!okSig) return bad('bad signature');
        return { ok: true, kind: kind, env: env, raw: raw, key: kind === 'order' ? (env.signPk.toLowerCase() + '|' + env.orderId.toLowerCase()) : null };
    }
    function bad(why) { return { ok: false, error: why }; }

    /** Sign a flat object with the identity's Ed25519 key; returns the final JSON string (canonical fields + sig). */
    function sign(me, fields) {
        var canon = canonical(fields);
        var sig = S.signDetached(H.utf8(canon), me.signSk);
        var withSig = {};
        var ks = Object.keys(fields);
        for (var i = 0; i < ks.length; i++) if (ks[i] !== 'sig') withSig[ks[i]] = fields[ks[i]];
        withSig.sig = '0x' + H.to(sig);
        // Emit canonical order WITH sig appended in sorted position (so raw bytes are deterministic too).
        var keys = Object.keys(withSig).sort(), parts = [];
        for (var j = 0; j < keys.length; j++) parts.push('"' + keys[j] + '":' + value(withSig[keys[j]]));
        return '{' + parts.join(',') + '}';
    }

    /** Build + sign an order envelope. o = {market, side, price, amount, coins, address, orderId, seq, expiry}. */
    function order(me, o) {
        return sign(me, { v: 1, t: 'order', market: o.market, side: o.side, price: o.price, amount: o.amount, coins: o.coins, scripts: o.scripts || [],
                          address: o.address, orderId: o.orderId, seq: o.seq, expiry: o.expiry, pubId: me.publicId(), signPk: '0x' + H.to(me.signPk) });
    }
    /** Build + sign a msg envelope carrying a sealed blob (hex, no 0x) to a publicId. */
    function msg(me, toPublicId, blobHex, expiry) {
        return sign(me, { v: 1, t: 'msg', to: toPublicId, from: me.publicId(), blob: blobHex, expiry: expiry });
    }

    AX.envelope = { canonical: canonical, verify: verify, sign: sign, order: order, msg: msg, isCancelAmount: isCancelAmount,
                    MAX_ORDER_BYTES: MAX_ORDER_BYTES, MAX_MSG_BYTES: MAX_MSG_BYTES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
