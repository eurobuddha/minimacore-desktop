/* export.js — trade export and reconciliation. Port of native TradeExport.java (0.3.9).
 *
 * Deliberately PURE: no DOM, no node commands, no clock. The same rows always produce the same
 * files, which is what makes it the one module that is trivially unit-testable — the shape
 * pandapools-mds/statement.js settled on for the same job.
 *
 * Only confirmed personal fills are exported. Money-in/money-out is what an accountant needs, so
 * the notional is always cut DOWN: an export must never overstate what was received.
 */
var PandaExport = PandaExport || {};
(function (X, P) {

  X.UNVERIFIED = "LOCAL_ONLY";

  function dec(v) { try { return P.d(v === undefined || v === null || v === "" ? 0 : v); } catch (error) { return P.d(0); } }
  /* Cut, never round up. */
  function down(v, dp) { return dec(v).toDecimalPlaces(dp, Decimal.ROUND_DOWN).toFixed(dp); }
  function iso(ms) { var n = Number(ms || 0); return n > 0 ? new Date(n).toISOString() : ""; }
  /* RFC4180: quote anything containing a comma, quote or newline, and double any inner quote.
     Then the part quoting does NOT solve: a field starting with = + - @ or a control character is
     executed as a formula by Excel, Sheets and LibreOffice. That matters here because an order's
     id is state port 4 — chosen by whoever created the order and never validated — so anyone can
     put `=HYPERLINK(...)` on the book and have it run inside your accounting export. Prefixing
     with an apostrophe is the standard neutralisation and is stripped on display. */
  function csv(v) {
    var s = v === undefined || v === null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function row(cells) { var i, out = []; for (i = 0; i < cells.length; i++) out.push(csv(cells[i])); return out.join(","); }

  X.clean = function (rows) {
    var out = [], i, r, price, size;
    rows = Array.isArray(rows) ? rows : [];
    for (i = 0; i < rows.length; i++) {
      r = rows[i] || {};
      price = dec(r.price !== undefined ? r.price : r.PRICE);
      size = dec(r.size !== undefined ? r.size : r.SIZE);
      if (!price.gt(0) || !size.gt(0)) continue;   /* an unpriced or zero row is not a trade */
      out.push({
        timems: Number(r.timems !== undefined ? r.timems : r.TIMEMS) || 0,
        block: Number(r.block !== undefined ? r.block : r.BLOCK) || 0,
        price: price, size: size,
        buy: !!(r.buy !== undefined ? r.buy : r.BUY),
        maker: !!(r.maker !== undefined ? r.maker : r.MAKER),
        orderid: r.orderid || r.ORDERID || "",
        spentcoin: r.spentcoin || r.SPENTCOIN || "",
        txpowid: r.txpowid || r.TXPOWID || "",
        sourceKind: r.source_kind || r.SOURCE_KIND || (r.maker || r.MAKER ? "BOOK" : ""),
        status: r.verification_status || r.VERIFICATION_STATUS || X.UNVERIFIED,
        note: r.verification_note || r.VERIFICATION_NOTE || ""
      });
    }
    out.sort(function (a, b) { return a.timems - b.timems; });
    return out;
  };

  /* Real money in and out. A buy pays MxUSD and receives MINIMA; a sell is the reverse. */
  X.totals = function (rows) {
    var t = {fills:0, minimaBought:P.d(0), minimaSold:P.d(0), usdtPaid:P.d(0), usdtReceived:P.d(0)}, i, r, notional;
    rows = X.clean(rows);
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      notional = P.down(r.size.mul(r.price), P.DP);
      t.fills++;
      if (r.buy) { t.minimaBought = t.minimaBought.add(r.size); t.usdtPaid = t.usdtPaid.add(notional); }
      else { t.minimaSold = t.minimaSold.add(r.size); t.usdtReceived = t.usdtReceived.add(notional); }
    }
    t.netMinima = t.minimaBought.sub(t.minimaSold);
    t.netUsdt = t.usdtReceived.sub(t.usdtPaid);
    t.volume = t.minimaBought.add(t.minimaSold);
    return t;
  };

  X.confirmedCsv = function (rows) {
    var out = [row(["timestamp","block","side","minima","price_usdt_per_minima","notional_usdt","role","order_id","txpowid"])], i, r;
    rows = X.clean(rows);
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      out.push(row([iso(r.timems), r.block, r.buy ? "BUY" : "SELL", down(r.size, 8),
        dec(r.price).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6),
        down(r.size.mul(r.price), 8), r.maker ? "MAKER" : "TAKER", r.orderid, r.txpowid]));
    }
    return out.join("\n") + "\n";
  };

  /* A running position, so the closing line can be tied against the wallet by hand. */
  X.reconciliationCsv = function (rows) {
    var out = [row(["timestamp","side","minima_delta","usdt_delta","minima_balance","usdt_balance"])],
      m = P.d(0), u = P.d(0), i, r, dm, du;
    rows = X.clean(rows);
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      dm = r.buy ? r.size : r.size.neg();
      du = P.down(r.size.mul(r.price), P.DP); du = r.buy ? du.neg() : du;
      m = m.add(dm); u = u.add(du);
      out.push(row([iso(r.timems), r.buy ? "BUY" : "SELL", down(dm, 8), down(du, 8), down(m, 8), down(u, 8)]));
    }
    return out.join("\n") + "\n";
  };

  X.verificationCsv = function (rows) {
    var out = [row(["timestamp","txpowid","spent_coinid","source","status","note"])], i, r;
    rows = X.clean(rows);
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      /* A row with no txpowid can only ever be locally observed — never claim more than that. */
      out.push(row([iso(r.timems), r.txpowid, r.spentcoin, r.sourceKind,
        r.txpowid ? r.status : X.UNVERIFIED, r.note]));
    }
    return out.join("\n") + "\n";
  };

  X.summaryText = function (rows, meta) {
    var t = X.totals(rows), c = X.clean(rows), lines = [];
    meta = meta || {};
    lines.push("PandaDEX trade reconciliation");
    lines.push("market            MINIMA / MxUSD");
    if (meta.version) lines.push("app version       " + meta.version);
    if (meta.address) lines.push("wallet address    " + meta.address);
    if (meta.block) lines.push("chain block       " + meta.block);
    lines.push("");
    lines.push("fills             " + t.fills);
    if (c.length) { lines.push("first fill        " + iso(c[0].timems)); lines.push("last fill         " + iso(c[c.length - 1].timems)); }
    lines.push("");
    lines.push("MINIMA bought     " + down(t.minimaBought, 8));
    lines.push("MINIMA sold       " + down(t.minimaSold, 8));
    lines.push("MINIMA net        " + down(t.netMinima, 8));
    lines.push("");
    lines.push("MxUSD paid       " + down(t.usdtPaid, 8));
    lines.push("MxUSD received   " + down(t.usdtReceived, 8));
    lines.push("MxUSD net        " + down(t.netUsdt, 8));
    lines.push("");
    lines.push("Every figure is derived from fills this node observed on-chain. Amounts are cut, never");
    lines.push("rounded up, so nothing here overstates what was received. Rows with no txpowid are");
    lines.push("marked " + X.UNVERIFIED + ": the fill was seen locally but not confirmed against an explorer.");
    return lines.join("\n") + "\n";
  };

  /* One call for the whole export. The caller only has to deliver the bytes. */
  /* native TradeExport.filename — one archive, dated in UTC so exports from two devices sort. */
  X.zipName = function (ms) {
    var d = new Date(Number(ms) || 0), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return "pandadex-trades-" + d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + ".zip";
  };

  /* native TradeExportWriter.describe — the confirmation line after a successful export. */
  X.describe = function (rows) {
    var t = X.totals(rows);
    return t.fills + " confirmed personal trade" + (t.fills === 1 ? "" : "s")
      + " · net " + t.netMinima.toFixed() + " MINIMA · net " + t.netUsdt.toFixed() + " MxUSD";
  };

  X.files = function (rows, meta) {
    return [
      {name:"summary.txt", text:X.summaryText(rows, meta)},
      {name:"confirmed_trades.csv", text:X.confirmedCsv(rows)},
      {name:"reconciliation.csv", text:X.reconciliationCsv(rows)},
      {name:"verification.csv", text:X.verificationCsv(rows)}
    ];
  };

})(PandaExport, PandaDEX);
