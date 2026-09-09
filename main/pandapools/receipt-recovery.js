/* Read-only port of Android ReceiptRecovery + Maxima TxHeader/Magic/MiniNumber wire codecs.
 * SHA3 is the unchanged KeyUses phrase/sha3.js. A mined hash MUST reproduce exactly before
 * reconstructing its pre-mining ID. This never establishes inclusion; txpow onchain does that. */
var ReceiptRecovery = (function () {
    var D = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_DOWN });
    function number(value, scale) {
        if (value === null || value === undefined || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(String(value))) throw Error("Invalid number");
        var n = new D(value), places = String(value).split(".")[1];
        var dp = Math.max(scale || 0, places ? places.length : 0);
        if (dp > 44 || n.abs().gt("18446744073709551615")) throw Error("Number outside limits");
        var integer = new D(n.abs().toFixed(dp).replace(".", "")), bytes = [];
        do { bytes.unshift(integer.mod(256).toNumber()); integer = integer.dividedToIntegerBy(256); } while (!integer.isZero());
        if (bytes[0] & 128) bytes.unshift(0);
        if (n.lt(0)) {
            var carry = 1;
            for (var i = bytes.length - 1; i >= 0; i--) { var v = (255 - bytes[i]) + carry; bytes[i] = v & 255; carry = v >>> 8; }
            while (bytes.length > 1 && bytes[0] === 255 && (bytes[1] & 128)) bytes.shift();
        }
        if (bytes.length > 32) throw Error("Number too long");
        return [dp, bytes.length].concat(bytes);
    }
    function data(value) {
        if (!/^0x[0-9a-fA-F]{1,128}$/.test(String(value))) throw Error("Invalid hash");
        var hex = value.slice(2); if (hex.length % 2) hex = "0" + hex;
        var bytes = []; for (var i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
        // KeyUses derive.js serMiniData: int32 BE length followed by raw bytes.
        var n = bytes.length;
        return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].concat(bytes);
    }
    function header(j, scale, ns, ts, submitted) {
        var out = number(submitted ? "0" : j.nonce, submitted ? 0 : ns)
            .concat(data(j.chainid), number(j.timemilli), number(j.block), data(j.blkdiff));
        var parents = j.superparents, count = 0, runs = [];
        if (!Array.isArray(parents) || parents.length > 32) throw Error("Invalid parents");
        parents.forEach(function (p) {
            var n = Number(p.count); if (n !== Math.floor(n) || n <= 0 || n > 32 - count) throw Error("Invalid parent count");
            var bytes = data(p.parent), key = bytes.join(","); count += n;
            if (runs.length && runs[runs.length - 1].key === key) runs[runs.length - 1].n += n;
            else runs.push({ n: n, key: key, bytes: bytes });
        });
        if (count !== 32) throw Error("Incomplete parents");
        runs.forEach(function (p) { out = out.concat([p.n], p.bytes); });
        out = out.concat(data(j.mmr), number(j.total, ts));
        var m = j.magic;
        out = out.concat(number(m.currentmaxtxpowsize, scale), number(m.currentmaxkissvmops, scale),
            number(m.currentmaxtxn, scale), data(m.currentmintxpowwork), number(m.desiredmaxtxpowsize),
            number(m.desiredmaxkissvmops), number(m.desiredmaxtxn), data(m.desiredmintxpowwork),
            data(j.customhash), data(submitted ? "0x00" : j.txbodyhash));
        return out;
    }
    function submittedId(tx) {
        try {
            if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx.txpowid)) return "";
            var j = tx.header, hashes = 0;
            var nscale = String(j.nonce).split(".")[1], tscale = String(j.total).split(".")[1];
            for (var attempt = 0; attempt < 45; attempt++) {
                var scale = attempt === 0 ? 44 : attempt - 1;
                for (var ns = nscale ? nscale.length : 0; ns <= 44; ns++) {
                    for (var ts = tscale ? tscale.length : 0; ts <= 44; ts++) {
                        if (++hashes > 4096) return "";
                        if ("0x" + sha3_256(header(j, scale, ns, ts, false)) !== tx.txpowid.toLowerCase()) continue;
                        return "0x" + sha3_256(header(j, scale, 0, ts, true));
                    }
                }
            }
        } catch (malformed) { /* Unsupported/incomplete headers remain unresolved. */ }
        return "";
    }
    return { submittedId: submittedId, number: number };
})();
