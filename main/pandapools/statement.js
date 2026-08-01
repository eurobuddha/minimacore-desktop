/*
 * statement.js — the per-pool statement: what you put in, your trades, what is in the pool now, the profit.
 *
 * A port of the native app's TxClassifier + PoolStatement, reading the permanent pp_history mirror. Pure
 * logic: no DOM, no node calls, so the same inputs always produce the same file.
 *
 * NOTHING HERE IS ESTIMATED. Every figure traces to stored on-chain history or the live pool scan. Where a
 * value cannot be obtained the file says so rather than printing something that merely looks derived.
 *
 * TWO PROFIT FIGURES, because they answer different questions:
 *   Pool profit (vs holding) — the pool's value today against what the same coins would be worth had you
 *                              simply held them. MINIMA's own price move cancels, leaving fees minus
 *                              impermanent loss: what providing liquidity actually earned.
 *   Change in market value   — the pool's value today against what it cost going in. Includes MINIMA's own
 *                              price movement, which you were exposed to either way.
 *
 * SCOPE: trade rows are YOUR transactions only, and the file says so. The node's relevant-history does not
 * reliably retain other people's trades against a pool, and a silently-incomplete accounting file is the
 * worst possible failure. The profit figures are unaffected — reserves are read LIVE, so everyone else's
 * trading is already in what is in the pool now.
 */
var Statement = (function () {
    var D = Decimal;
    var MONEY_DP = 6, PRICE_DP = 12;
    var EOL = "\r\n";

    var CREATE = "POOL_CREATE", DEPOSIT = "POOL_DEPOSIT", WITHDRAW = "POOL_WITHDRAW",
        MIGRATE = "POOL_MIGRATE", KEEPALIVE = "POOL_KEEPALIVE", SWAP = "SWAP", OTHER = "OTHER_PARTY_SWAP";

    var ANNOUNCE_DUST = new D("0.000000001");

    function d(v) { return PP.decOr(v, 0); }

    // ---------------------------------------------------------------- classification

    /** MINIMA + the largest non-MINIMA leg of this transaction's net effect on the wallet. */
    function legs(deltas) {
        var m = d(deltas["0x00"] || 0), tokenid = null, t = new D(0);
        for (var k in deltas) {
            if (!deltas.hasOwnProperty(k) || PP.isMinima(k)) continue;
            var v = d(deltas[k]);
            if (v.abs().cmp(t.abs()) > 0) { t = v; tokenid = k; }
        }
        return { m: m, t: t, tokenid: tokenid };
    }

    /**
     * OUR share of this transaction, split across EVERY pool it touched.
     *
     * A routed swap is ONE transaction spanning several pools. Booking the whole thing against the first
     * pool address that matches credits one pool with a trade split across three. Each pool's reserve change
     * is measurable directly — Σ(outputs at it) − Σ(inputs at it) — and for OUR transactions the wallet is
     * the counterparty to every pool touched, so our flow into a pool is exactly minus its reserve change.
     * That holds uniformly for create, deposit, swap, withdraw and routed multi-pool trades.
     *
     * Must NOT be applied to a stranger's trade: their swap moves reserves while our flow is zero.
     */
    function poolFlows(row, known) {
        var by = {};
        function acc(json, sign) {
            var arr;
            try { arr = JSON.parse(json || "[]"); } catch (e) { return; }
            arr.forEach(function (c) {
                if (!c) return;
                var a = String(c.address || "").toLowerCase(), mx = String(c.miniaddress || c.addr || "").toLowerCase();
                var key = known[a] ? a : (known[mx] ? mx : null);
                if (!key) return;
                if (!by[key]) by[key] = [new D(0), new D(0)];
                var amt = d(c.amount).times(sign);
                if (PP.isMinima(c.tokenid || "0x00")) by[key][0] = by[key][0].plus(amt);
                else by[key][1] = by[key][1].plus(amt);
            });
        }
        acc(row.outputs, 1);     // outputs ADD to a pool's reserves
        acc(row.inputs, -1);     // inputs REMOVE from them
        for (var k in by) if (by.hasOwnProperty(k)) { by[k][0] = by[k][0].neg(); by[k][1] = by[k][1].neg(); }
        return by;
    }

    /** Does the per-pool split account for the whole transaction? An equation, so it is checked rather than
     *  assumed — a row that fails it is reported and left out of the totals instead of being mis-booked. */
    function splitReconciles(flows, dm, dt) {
        var m = new D(0), t = new D(0);
        for (var k in flows) if (flows.hasOwnProperty(k)) { m = m.plus(flows[k][0]); t = t.plus(flows[k][1]); }
        if (t.cmp(dt) !== 0) return false;
        return m.minus(dm).abs().cmp(ANNOUNCE_DUST) <= 0;
    }

    /** True if any output is a MINIMA coin of exactly the beacon dust amount — how a keep-fresh / re-announce
     *  is identified, since the sentinel is stored in its Mx form and only the hex is a known constant. */
    function hasBeacon(row) {
        try {
            return JSON.parse(row.outputs || "[]").some(function (c) {
                return c && PP.isMinima(c.tokenid || "0x00") && d(c.amount).cmp(ANNOUNCE_DUST) === 0;
            });
        } catch (e) { return false; }
    }

    function classify(row, flows, dm, dt) {
        var addrs = Object.keys(flows);
        var inPool = null, outPool = null;
        // a pool spent AND recreated at a DIFFERENT address is a migrate — only the owner can do that, and it
        // is checked first because a same-size migrate nets to zero and would look like a stranger's trade
        try {
            var ins = JSON.parse(row.inputs || "[]"), outs = JSON.parse(row.outputs || "[]");
            addrs.forEach(function (a) {
                if (ins.some(function (c) { return matches(c, a); })) inPool = inPool || a;
                if (outs.some(function (c) { return matches(c, a); })) outPool = outPool || a;
            });
        } catch (e) {}
        if (inPool && outPool && inPool !== outPool) return MIGRATE;
        if (addrs.length && dm.cmp(0) === 0 && dt.cmp(0) === 0) return OTHER;
        if (inPool && outPool) {
            if (dt.cmp(0) === 0 && dm.cmp(0) <= 0 && hasBeacon(row) && dm.abs().cmp(ANNOUNCE_DUST) <= 0) return KEEPALIVE;
            if (dm.cmp(0) < 0 && dt.cmp(0) < 0) return DEPOSIT;
            if (dm.cmp(0) > 0 && dt.cmp(0) > 0) return WITHDRAW;
            return SWAP;
        }
        if (outPool) return CREATE;
        if (inPool) return WITHDRAW;
        return null;                              // not a PandaPools transaction
    }

    function matches(c, addrLower) {
        if (!c) return false;
        return String(c.address || "").toLowerCase() === addrLower
            || String(c.miniaddress || c.addr || "").toLowerCase() === addrLower;
    }

    // ---------------------------------------------------------------- the statement

    /**
     * @param rows   pp_history rows, oldest first
     * @param pools  [{address, label, reserveM, reserveT}] — the pools you own, reserves from the live scan
     *               (reserveM/reserveT null when the pool wasn't in the latest scan)
     * @param known  lowercased set of every known pool covenant address
     */
    function build(rows, pools, known, meta) {
        meta = meta || {};
        var out = "";
        out += cells(["PandaPools statement", isoDate(meta.at || Date.now()), "v" + (meta.version || "?")]);
        out += cells(["Trades listed are YOUR transactions only — not every trade against the pool."]);
        if (!meta.backfilled) out += cells(["History is still syncing — older transactions of yours may be missing."]);
        out += EOL;

        pools.forEach(function (p) { out += block(p, rows, known) + EOL; });
        if (!pools.length) out += cells(["You don't own any pools."]);
        return out;
    }

    function block(pool, rows, known) {
        var addr = String(pool.address || "").toLowerCase();
        var sym = pool.label || "token";
        var createM = new D(0), createT = new D(0), addM = new D(0), addT = new D(0),
            wdM = new D(0), wdT = new D(0), trM = new D(0), trT = new D(0);
        var maintCount = 0, maintM = new D(0);
        var opening = new D(0), openedMs = 0, unreconciled = 0;
        var lines = [];

        rows.forEach(function (row) {
            var deltas;
            try { deltas = JSON.parse(row.deltas || "{}"); } catch (e) { return; }
            var lg = legs(deltas), dm = lg.m, dt = lg.t;
            var flows = poolFlows(row, known);
            var mineFlow = flows[addr];
            if (!mineFlow) return;                                  // this trade didn't touch this pool
            var type = classify(row, flows, dm, dt);
            if (!type || type === OTHER) return;                    // not ours
            if (dm.cmp(0) === 0 && dt.cmp(0) === 0) return;

            var ties = splitReconciles(flows, dm, dt);
            if (!ties) unreconciled++;
            var fM = mineFlow[0], fT = mineFlow[1];
            if (!openedMs) openedMs = row.timemilli;

            if (type === CREATE) { createM = createM.plus(fM); createT = createT.plus(fT); }
            else if (type === DEPOSIT) { addM = addM.plus(fM); addT = addT.plus(fT); }
            else if (type === WITHDRAW || type === MIGRATE) { wdM = wdM.plus(fM); wdT = wdT.plus(fT); }
            else if (type === KEEPALIVE) { maintCount++; maintM = maintM.plus(fM); return; }
            else { trM = trM.plus(fM); trT = trT.plus(fT); }

            // What this leg cost at the price the transaction ITSELF implies. A create costs the value put in;
            // a swap contributes zero, because equal value was exchanged at the pool price of that moment.
            var price = (fM.cmp(0) !== 0 && fT.cmp(0) !== 0) ? fT.abs().div(fM.abs()) : null;
            if (price && ties) opening = opening.minus(fM.times(price).plus(fT));
            lines.push([isoDay(row.timemilli), ties ? type : type + " (does not reconcile — excluded)",
                        num(fM), num(fT), price ? fixed(price, PRICE_DP) : "", String(Object.keys(flows).length),
                        row.txpowid || ""]);
        });

        var netM = createM.plus(addM).plus(wdM).plus(trM).plus(maintM).neg();
        var netT = createT.plus(addT).plus(wdT).plus(trT).neg();

        var s = "";
        s += cells(["POOL", "MINIMA / " + sym, pool.address]);
        if (openedMs) s += cells(["Opened", isoDay(openedMs)]);
        s += EOL;
        s += cells(["Created with", num(createM.neg()), "MINIMA", num(createT.neg()), sym]);
        s += cells(["Added later", num(addM.neg()), "MINIMA", num(addT.neg()), sym]);
        s += cells(["Withdrawn", num(wdM), "MINIMA", num(wdT), sym]);
        s += cells(["Your trades (net)", num(trM), "MINIMA", num(trT), sym]);
        if (maintCount) s += cells(["Maintenance", maintCount + " txns", "keep-alive — pays the registry, not this pool"]);
        s += cells(["Net put in", num(netM), "MINIMA", num(netT), sym]);
        s += EOL;

        if (pool.reserveM === null || pool.reserveM === undefined) {
            s += cells(["Now in pool", "reserves unavailable — pool not in the latest scan"]);
            s += cells(["No profit figures: they need the pool's current reserves."]);
        } else {
            var nowM = d(pool.reserveM), nowT = d(pool.reserveT);
            s += cells(["Now in pool", num(nowM), "MINIMA", num(nowT), sym]);
            if (nowM.cmp(0) > 0) {
                var price = nowT.div(nowM);
                s += cells(["Pool price", fixed(price, PRICE_DP), sym + " per MINIMA"]);
                s += EOL;
                var today = nowM.times(price).plus(nowT);
                var held = netM.times(price).plus(netT);
                s += cells(["Value at opening price", fixed(opening, MONEY_DP), sym]);
                s += cells(["Value if you'd simply held those coins", fixed(held, MONEY_DP), sym]);
                s += cells(["Value of the pool today", fixed(today, MONEY_DP), sym]);
                s += pnl("Pool profit (vs holding)", today.minus(held), held, sym);
                s += pnl("Change in market value", today.minus(opening), opening, sym);
            } else {
                s += cells(["Pool price", "pool is empty — no price"]);
            }
        }

        if (unreconciled) s += cells([unreconciled + " transaction(s) did not reconcile and are excluded from the totals."]);
        if (lines.length) {
            s += EOL + cells(["date", "type", "minima", sym.toLowerCase(), "price", "pools_in_trade", "txpowid"]);
            lines.forEach(function (l) { s += cells(l); });
        }
        return s;
    }

    function pnl(label, value, base, sym) {
        var pct = "";
        if (base && base.cmp(0) !== 0) {
            var p = value.times(100).div(base.abs()).toDP(2, D.ROUND_HALF_UP);
            pct = (p.cmp(0) > 0 ? "+" : "") + p.toFixed(2) + "%";   // toFixed, not toString: keep "-6.00%"
        }
        return cells([label, fixed(value, MONEY_DP), sym, ours(pct)]);
    }

    // ---------------------------------------------------------------- CSV

    /**
     * A quoted cell. A leading =, +, - or @ in ATTACKER-CONTROLLED text (a token name comes from on-chain
     * metadata) would be evaluated as a formula when the sheet opens, so it is defused with an apostrophe —
     * but NEVER for a number, because "-250" must stay a negative number, not become the text '-250.
     *
     * Numeric cells are therefore tagged at the point they are created, by num()/fixed() wrapping them in
     * {n: …}, rather than guessed at from their contents here.
     */
    function cell(v) {
        var isNum = v !== null && typeof v === "object" && v.n !== undefined;
        var s = isNum ? String(v.n) : (v === null || v === undefined ? "" : String(v));
        if (!isNum && s.length) {
            var c0 = s.charAt(0);
            if (c0 === "=" || c0 === "+" || c0 === "-" || c0 === "@") s = "'" + s;
        }
        return '"' + s.replace(/"/g, '""') + '"';
    }
    function cells(arr) { return arr.map(cell).join(",") + EOL; }

    /** An on-chain amount, exactly as it moved — trailing zeros trimmed, never rounded. */
    function num(v) { return { n: (v === null || v === undefined) ? "" : d(v).toString() }; }

    /** A string WE generated (a percentage). Not defused: it can't carry attacker content, and a percentage
     *  legitimately starts with + or − — defusing it would render "+0.21%" as "'+0.21%". */
    function ours(s) { return { n: s === null || s === undefined ? "" : String(s) }; }

    /** A DERIVED figure (a price, a profit): a division, so rounded to a scale a human can read. */
    function fixed(v, dp) {
        if (v === null || v === undefined) return { n: "" };
        return { n: d(v).toDP(dp, D.ROUND_HALF_UP).toString() };
    }

    function isoDate(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z"); }
    function isoDay(ms) { return ms ? new Date(Number(ms)).toISOString().slice(0, 10) : ""; }

    return { build: build, poolFlows: poolFlows, splitReconciles: splitReconciles, classify: classify, legs: legs };
})();
