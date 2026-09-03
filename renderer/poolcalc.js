/*
 * calc.js — PoolCalc: the what-if pool calculator's maths. DISPLAY-ONLY — nothing here builds a transaction,
 * so plain JS numbers are fine (the fund-critical quoting stays in curve.js on Decimal). The JS port of the
 * native PoolCalc.java; byte-identical copy in minimaCore Desktop (renderer/poolcalc.js) — keep the three in step.
 *
 * A PandaPool is a full-range constant-product pool: the covenant enforces MINIMA × token ≥ K and nothing else,
 * so at any price P the reserves are fixed by K alone:  x = √(K / P),  y = √(K · P). The count ratio x / y is
 * always 1 / P, the pool is always half MINIMA / half token by value, and neither side ever reaches zero.
 *
 * Fees: every swap leaves 0.5 % of its input in the pool, which only ever raises K. The calculator values the
 * fees kept (rate × volume) at the CURRENT price, which gives the clean identity
 *   pool value with fees = fee-free value + fees kept   ⇔   √K' = √K + fees / (2 √P).
 * Volume that traded at other prices lands slightly differently; the dialog says so.
 */
var PoolCalc = (function () {

    /**
     * x0: MINIMA added at creation (> 0) · y0: token added (> 0) · price: token per MINIMA (> 0)
     * feePct: swap fee in percent (PandaPools: 0.5) · volume: total traded through the pool, token value, ≥ 0.
     * Returns null for a non-positive pool or price.
     */
    function compute(x0, y0, price, feePct, volume) {
        x0 = Number(x0); y0 = Number(y0); price = Number(price); feePct = Number(feePct); volume = Number(volume);
        if (!(x0 > 0) || !(y0 > 0) || !(price > 0) || !isFinite(x0) || !isFinite(y0) || !isFinite(price)) return null;
        if (!(feePct >= 0) || feePct >= 100) feePct = 0;
        if (!(volume >= 0)) volume = 0;
        var r = {};
        r.k = x0 * y0;                                   // entry invariant (== the KMIN floor at creation)
        r.entryPrice = y0 / x0;
        r.move = price / r.entryPrice;
        r.feesKept = feePct / 100 * volume;              // token value
        var sqrtK2 = Math.sqrt(r.k) + r.feesKept / (2 * Math.sqrt(price));
        r.kWithFees = sqrtK2 * sqrtK2;
        r.kGrowthPct = (r.kWithFees / r.k - 1) * 100;    // the app's "fee growth" figure (K / KMIN − 1)
        r.minima = Math.sqrt(r.kWithFees / price);
        r.token = Math.sqrt(r.kWithFees * price);
        r.ratio = r.minima / r.token;                    // == 1 / price
        r.value = 2 * r.token;                           // pool value in token units
        r.hold = x0 * price + y0;                        // just holding the two amounts
        r.vsHoldPct = (r.value / r.hold - 1) * 100;      // divergence loss, fees included
        var loss = Math.max(0, r.hold - 2 * Math.sqrt(r.k * price));
        r.breakEvenVolume = feePct > 0 ? loss / (feePct / 100) : NaN;   // volume whose fees offset the loss
        return r;
    }

    /** Whole numbers past 1,000, else enough decimals to keep a small value meaningful. Thousands-grouped,
     *  never scientific notation, never truncated to nothing. */
    function fmt(v) {
        v = Number(v);
        if (isNaN(v) || !isFinite(v)) return "—";
        var a = Math.abs(v);
        var dp = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8;
        var s = v.toFixed(dp);
        if (dp > 0) s = s.replace(/\.?0+$/, "");   // 500.00 → 500, 52.50 → 52.5; never an exponent, never nothing
        var neg = s.charAt(0) === "-"; if (neg) s = s.substring(1);
        var dot = s.indexOf("."); var ip = dot < 0 ? s : s.substring(0, dot), fp = dot < 0 ? "" : s.substring(dot);
        return (neg ? "-" : "") + ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + fp;
    }

    /** A price: plain decimal, no exponent, trailing zeros stripped (0.005 stays "0.005", 50 stays "50"). */
    function fmtPrice(p) {
        p = Number(p);
        if (isNaN(p) || !isFinite(p) || p <= 0) return "—";
        if (p >= 1000) return fmt(p);
        var s = p.toFixed(p >= 1 ? 4 : 12);
        return s.replace(/\.?0+$/, "");
    }

    /** "×4", "÷10", "×1" — the price move from entry, in the direction that reads naturally. */
    function fmtMove(m) {
        m = Number(m);
        if (isNaN(m) || !isFinite(m) || m <= 0) return "—";
        if (Math.abs(Math.log(m) / Math.LN10) < 1e-9) return "×1";
        var s = fmt(m >= 1 ? m : 1 / m);
        if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
        return (m >= 1 ? "×" : "÷") + s;
    }

    /**
     * Draw MINIMA × token = K (with fees) on a canvas with the entry point and the current pool state; the
     * entry-K curve dashed underneath once fees have lifted the pool off its floor. Axes auto-scale to 4× entry,
     * stretching to keep the current point in view up to 40×. `c` = { accent, ink, dim, grid, surface, font }.
     */
    function draw(canvas, r, x0, y0, price, tok, c) {
        var ctx = canvas.getContext("2d");
        var dpr = window.devicePixelRatio || 1;
        var W = canvas.clientWidth || 360, H = canvas.clientHeight || 220;
        if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (!r) return;
        var L = 54, R = 14, T = 16, B = 30, pw = W - L - R, ph = H - T - B;
        var xmax = Math.max(4 * x0, Math.min(r.minima * 1.15, 40 * x0));
        var ymax = Math.max(4 * y0, Math.min(r.token * 1.15, 40 * y0));
        function sx(v) { return L + v / xmax * pw; }
        function sy(v) { return T + (1 - v / ymax) * ph; }
        ctx.font = "10px " + (c.font || "sans-serif");
        ctx.lineWidth = 1; ctx.strokeStyle = c.grid; ctx.fillStyle = c.dim;
        for (var i = 0; i <= 4; i++) {
            var gx = L + pw * i / 4, gy = T + ph * (4 - i) / 4;
            ctx.beginPath(); ctx.moveTo(gx, T); ctx.lineTo(gx, T + ph); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(L, gy); ctx.lineTo(L + pw, gy); ctx.stroke();
            ctx.textAlign = "center"; ctx.fillText(fmt(xmax * i / 4), gx, T + ph + 14);
            ctx.textAlign = "right"; ctx.fillText(fmt(ymax * i / 4), L - 6, gy + 4);
        }
        ctx.textAlign = "right"; ctx.fillText("MINIMA in pool →", L + pw, T + ph + 26);
        ctx.textAlign = "left"; ctx.fillText(tok + " in pool ↑", L + 4, T - 4);
        function curve(k) {
            var xs = k / ymax, n = 120; ctx.beginPath();
            for (var j = 0; j <= n; j++) { var xx = xs + (xmax - xs) * j / n; var px = sx(xx), py = sy(k / xx); if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
            return xs;
        }
        var xs2 = curve(r.kWithFees);
        ctx.lineTo(L + pw, T + ph); ctx.lineTo(sx(xs2), T + ph); ctx.closePath();
        ctx.fillStyle = c.accent; ctx.globalAlpha = 0.11; ctx.fill(); ctx.globalAlpha = 1;
        if (r.kWithFees > r.k * 1.0005) { curve(r.k); ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = c.dim; ctx.stroke(); ctx.setLineDash([]); }
        curve(r.kWithFees); ctx.lineWidth = 2; ctx.strokeStyle = c.dim; ctx.stroke();
        var nx = sx(r.minima), ny = sy(r.token), ex = sx(x0), ey = sy(y0);
        ctx.setLineDash([3, 4]); ctx.lineWidth = 1; ctx.strokeStyle = c.accent;
        ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(nx, T + ph); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(L, ny); ctx.lineTo(nx, ny); ctx.stroke();
        ctx.setLineDash([]);
        function dot(x, y, rad, col) { ctx.beginPath(); ctx.arc(x, y, rad + 2, 0, Math.PI * 2); ctx.fillStyle = c.surface; ctx.fill(); ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
        dot(ex, ey, 5, c.ink);
        dot(nx, ny, 7, c.accent);
        ctx.fillStyle = c.ink;
        var right = nx < L + pw * 0.55;
        ctx.textAlign = right ? "left" : "right";
        var ly = ny < T + 20 ? ny + 20 : ny - 12;
        ctx.fillText("now " + fmtPrice(price) + ": " + fmt(r.minima) + " · " + fmt(r.token), nx + (right ? 13 : -13), ly);
    }

    var CHIPS = [0.01, 0.1, 0.25, 0.5, 1, 2, 4, 10, 100];

    /**
     * Build the calculator form (inputs → live results → curve) as a DOM subtree the host drops into its own modal.
     * opts: { x0, y0, tok, colors: {accent, ink, dim, grid, surface, font} }. Uses the shared PandaPools CSS classes
     * (.field / .kv / .chip / .modal__note / .view__sub) so it looks native in the MiniDapp and Desktop alike.
     * Returns { el, render } — call render() once the element is in the document (the canvas needs its size).
     */
    function form(opts) {
        var tok = opts.tok || "token";
        var root = document.createElement("div");
        root.className = "pc";
        function h(html) { var d = document.createElement("div"); d.innerHTML = html; return d.firstChild; }
        function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
        function field(label, key, value, isText) {
            var lab = document.createElement("label"); lab.className = "field";
            var sp = document.createElement("span"); sp.className = "field__label"; sp.setAttribute("data-pc-label", key); sp.innerText = label; lab.appendChild(sp);
            var inp = document.createElement("input"); inp.className = "field__input"; inp.setAttribute("data-pc", key);
            inp.type = "text"; inp.setAttribute("inputmode", isText ? "text" : "decimal"); inp.value = value; if (isText) inp.maxLength = 12;
            lab.appendChild(inp); root.appendChild(lab); return inp;
        }
        function sub(t) { var d = document.createElement("div"); d.className = "view__sub"; d.innerText = t; root.appendChild(d); return d; }
        function note(t, cls) { var d = document.createElement("div"); d.className = cls || "modal__note"; d.innerText = t; root.appendChild(d); return d; }
        function kv(label, key) {
            var row = document.createElement("div"); row.className = "kv";
            var k = document.createElement("span"); k.className = "kv__k"; k.setAttribute("data-pc-label", key); k.innerText = label;
            var v = document.createElement("span"); v.className = "kv__v"; v.setAttribute("data-pc", key); v.innerText = "—";
            row.appendChild(k); row.appendChild(v); root.appendChild(row); return v;
        }

        note("A PandaPool sits on MINIMA × token = K at every price, so the reserves, their ratio and the pool's value follow from the price alone. Enter a starting pool, then move the price. Nothing here touches your funds.", "modal__desc");
        sub("Starting pool");
        var inX = field("MINIMA you add", "x0", opts.x0 || "100000");
        var inY = field(tok + " you add", "y0", opts.y0 || "500");
        var inTok = field("Token symbol", "tok", tok, true);
        var derived = note("");
        sub("Price now");
        var p0seed = Number(inY.value) / Number(inX.value);
        var inP = field("MINIMA price in " + tok, "p", fmtPrice(p0seed));
        inP.style.fontSize = "20px";
        var slider = h('<input type="range" class="pc-range" min="-4" max="4" step="0.01" value="0" aria-label="Price as a multiple of entry, logarithmic">');
        root.appendChild(slider);
        root.appendChild(h('<div class="pc-range__lbl"><span>÷10,000</span><span>÷100</span><span>entry</span><span>×100</span><span>×10,000</span></div>'));
        var chips = document.createElement("div"); chips.className = "chip-row pc-chips"; root.appendChild(chips);
        var chipEls = [];
        CHIPS.forEach(function (m) {
            var b = document.createElement("button"); b.type = "button"; b.className = "chip" + (m === 1 ? " chip--active" : "");
            b.innerText = m === 1 ? "entry" : fmtMove(m);
            b.onclick = function () { setPriceFromMultiple(m); };
            chips.appendChild(b); chipEls.push({ m: m, el: b });
        });
        sub("Fees earned");
        var inFee = field("Swap fee rate (%)", "fee", "0.5");
        var inVol = field("Volume traded through the pool, in " + tok + " value", "vol", "0");
        note("PandaPools keeps 0.5 % of every swap's input inside the pool. Both directions count as volume. Fees are valued at the current price, so pool value with fees is exactly the fee-free value plus the fees kept.");
        sub("The pool at this price");
        var oMin = kv("MINIMA in pool", "minima"), oTok = kv(tok + " in pool", "token"), oRatio = kv("Ratio MINIMA : " + tok, "ratio"),
            oVal = kv("Pool value, fees included", "value"), oHold = kv("Versus holding both amounts", "hold"), oMove = kv("Price move from entry", "move"),
            oFees = kv("Fees kept by the pool", "fees"), oK = kv("K with fees", "k"), oBE = kv("Volume to break even with holding", "be");
        sub("Where the pool sits on its curve");
        var canvas = h('<canvas class="pc-canvas"></canvas>'); root.appendChild(canvas);
        note("Small dot = entry · large accent dot = now · dashed = K at entry (the KMIN floor) once fees lift the curve. The slope of the curve at the pool's point is the price.");
        note("MINIMA in pool = √(K ÷ price); token in pool = √(K × price). Each 4× move in price moves each reserve 2×. The pool is 50 % MINIMA and 50 % token by value at every price — only the counts change. Neither side ever reaches zero: 90 % of one side is gone at ×100 or ÷100, 99 % at ×10,000 or ÷10,000.");

        var syncing = false;
        function num(inp) { var v = parseFloat(String(inp.value).replace(/[,\s]/g, "")); return isFinite(v) ? v : NaN; }
        function entryPrice() { var x0 = num(inX), y0 = num(inY); return (x0 > 0 && y0 > 0) ? y0 / x0 : NaN; }
        function setPriceFromMultiple(m) { var p0 = entryPrice(); if (isNaN(p0)) return; syncing = true; inP.value = fmtPrice(p0 * m); syncing = false; render(); }
        function setTok(t) { tok = t; root.querySelectorAll("[data-pc-label]").forEach(function (e) {
            var k = e.getAttribute("data-pc-label");
            if (k === "y0") e.innerText = t + " you add"; else if (k === "p") e.innerText = "MINIMA price in " + t;
            else if (k === "vol") e.innerText = "Volume traded through the pool, in " + t + " value";
            else if (k === "token") e.innerText = t + " in pool"; else if (k === "ratio") e.innerText = "Ratio MINIMA : " + t; }); }

        function render() {
            var x0 = num(inX), y0 = num(inY), p = num(inP), fee = num(inFee), vol = num(inVol);
            if (isNaN(fee)) fee = 0; if (isNaN(vol)) vol = 0;
            var r = compute(x0, y0, p, fee, vol);
            var outs = [oMin, oTok, oRatio, oVal, oHold, oMove, oFees, oK, oBE];
            if (!r) {
                derived.innerText = "Enter a MINIMA amount, a " + tok + " amount and a price above zero.";
                outs.forEach(function (o) { o.innerText = "—"; }); oHold.style.color = "";
                draw(canvas, null, 0, 0, 0, tok, opts.colors); return;
            }
            derived.innerText = "Entry price " + fmtPrice(r.entryPrice) + " " + tok + " per MINIMA  ·  K " + fmt(r.k) + "  ·  " + fmt(x0 / y0) + " : 1 MINIMA per " + tok + "  ·  entry value " + fmt(2 * y0) + " " + tok;
            oMin.innerText = fmt(r.minima) + "  (" + fmt(r.minima / x0 * 100) + " % of what you added)";
            oTok.innerText = fmt(r.token) + "  (" + fmt(r.token / y0 * 100) + " % of what you added)";
            oRatio.innerText = fmt(r.ratio) + " : 1  (always 1 ÷ price)";
            oVal.innerText = fmt(r.value) + " " + tok + "  =  " + fmt(r.token) + " in MINIMA + " + fmt(r.token) + " in " + tok;
            oHold.innerText = (r.vsHoldPct > 0.005 ? "+" : "") + fmt(r.vsHoldPct) + " %  (holding would be worth " + fmt(r.hold) + " " + tok + ")";
            oHold.style.color = r.vsHoldPct < -0.005 ? "var(--red)" : r.vsHoldPct > 0.005 ? "var(--green)" : "";
            oMove.innerText = fmtMove(r.move) + "  (" + fmtPrice(r.entryPrice) + " → " + fmtPrice(p) + ")";
            oFees.innerText = fmt(r.feesKept) + " " + tok;
            oK.innerText = fmt(r.kWithFees) + "  (+" + fmt(r.kGrowthPct) + " %)";
            oBE.innerText = isNaN(r.breakEvenVolume) ? "— (fee is 0)" : fmt(r.breakEvenVolume) + " " + tok;
            var lm = Math.max(-4, Math.min(4, Math.log(r.move) / Math.LN10));
            if (Math.abs(parseFloat(slider.value) - lm) > 0.005) slider.value = lm;
            chipEls.forEach(function (c) { c.el.className = "chip" + (Math.abs(Math.log(c.m) / Math.LN10 - lm) < 0.005 ? " chip--active" : ""); });
            draw(canvas, r, x0, y0, p, tok, opts.colors);
        }
        function onStartChanged() {   // a new starting pool keeps the same RELATIVE move
            var p0 = entryPrice(); if (isNaN(p0)) { render(); return; }
            syncing = true; inP.value = fmtPrice(p0 * Math.pow(10, parseFloat(slider.value))); syncing = false; render();
        }
        inX.addEventListener("input", onStartChanged); inY.addEventListener("input", onStartChanged);
        inTok.addEventListener("input", function () { setTok(inTok.value.trim() || "token"); render(); });
        inP.addEventListener("input", function () { if (!syncing) render(); });
        inFee.addEventListener("input", render); inVol.addEventListener("input", render);
        slider.addEventListener("input", function () { setPriceFromMultiple(Math.pow(10, parseFloat(slider.value))); });
        return { el: root, render: render };
    }

    return { compute: compute, fmt: fmt, fmtPrice: fmtPrice, fmtMove: fmtMove, draw: draw, form: form };
})();
