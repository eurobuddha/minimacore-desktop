/* Shared MDS/Desktop counterpart of Android ActivityLog, ActivityTimeline and PoolHistorySync.
 * Public history is separate from pp_history (wallet accounting). Original receipts are never rewritten.
 * Only node txpow-onchain replies supply confirmations; neither time nor reserve snapshots are proof. */
var ActivityChain = (function () {
    var ready = false, initializing = false, waiters = [], verifying = false, fetching = false;
    var lastVerify = 0, cursors = {}, checkedAddresses = {}, visible = [], message = "", publicMessage = "";
    var change = function () {}, stopped = false, lastSnapshot = null;
    function esc(v) { return String(v).replace(/'/g, "''"); }
    function key(v) { return String(v || "").toLowerCase(); }
    function hex(v) { return /^0x[0-9a-fA-F]{64}$/.test(String(v || "")); }
    function truth(v) { return v === true || v === "true"; }
    function status() { return [message || (verifying ? "Checking confirmations with the node…" : ""), publicMessage || (fetching ? "Checking public pool transactions…" : "")].filter(function (s) { return s; }).join(" · "); }
    function sql(q, cb) { MDS.sql(q, function (r) { cb(r && r.status === true ? r : null); }); }
    function command(q, cb) {
        var ended = false, timer = setTimeout(function () { finish(null); }, 30000);
        function finish(r) { if (ended) return; ended = true; clearTimeout(timer); if (!stopped) cb(r); }
        try { MDS.cmd(q, finish); } catch (e) { finish(null); }
    }
    function init(cb) {
        if (ready) { cb(true); return; }
        waiters.push(cb); if (initializing) return; initializing = true;
        var tables = [
            ["pp_txids", "txpowid varchar(80) PRIMARY KEY, transactionid varchar(80), submittedid varchar(80), timemilli bigint"],
            ["pp_txproof", "txpowid varchar(80) PRIMARY KEY, depth bigint, checked bigint, inclusionblock bigint, tip bigint"],
            ["pp_submissions", "postedid varchar(80) PRIMARY KEY, transactionid varchar(80)"],
            ["pp_publichistory", "txpowid varchar(80) PRIMARY KEY, payload text"]
        ];
        function next(i) {
            if (i === tables.length) { finish(true); return; }
            sql("SELECT 1 FROM " + tables[i][0] + " LIMIT 1", function (r) {
                if (r) { next(i + 1); return; }
                sql("CREATE TABLE IF NOT EXISTS " + tables[i][0] + " (" + tables[i][1] + ")", function (created) { if (created) next(i + 1); else finish(false); });
            });
        }
        function finish(ok) { ready = ok; initializing = false; if (!ok) message = "Transaction storage unavailable"; var cbs = waiters; waiters = []; cbs.forEach(function (f) { f(ok); }); }
        next(0);
    }
    function txObject(reply) { var r = reply && reply.response; return r && (r.txpow || r); }
    function transactionId(tx) { var txn = tx && tx.body && tx.body.txn; return txn && hex(txn.transactionid) ? key(txn.transactionid) : ""; }
    function rememberSubmission(reply, posted, cb) {
        var id = transactionId(txObject(reply));
        if (!hex(posted) || !id) { cb(); return; }
        init(function (ok) {
            if (!ok) { cb(); return; }
            sql("MERGE INTO pp_submissions (postedid,transactionid) KEY(postedid) VALUES ('" + key(posted) + "','" + id + "')", function (r) {
                if (!r) message = "Submitted, but transaction identity could not be saved";
                cb(); // Posting already happened. Never turn a bookkeeping error into a retryable spend failure.
            });
        });
    }
    function observe(tx, cb) {
        if (!tx || !hex(tx.txpowid) || !transactionId(tx)) { cb(true); return; }
        init(function (ok) {
            if (!ok) { cb(false); return; }
            var id = key(tx.txpowid), tid = transactionId(tx), time = Number(tx.header && tx.header.timemilli || 0);
            sql("SELECT submittedid FROM pp_txids WHERE txpowid='" + id + "'", function (previous) {
                if (!previous) { cb(false); return; }
                var saved = previous.rows && previous.rows[0] && previous.rows[0].SUBMITTEDID;
                if (saved) { persist(saved); return; }
                Store.actList(-1, function (receipts, readOk) {
                    if (readOk === false) { cb(false); return; }
                    var candidate = receipts.some(function (r) { return hex(r.txpowid) && key(r.txpowid) !== id && time > 0 && Math.abs(r.ts - time) <= 300000; });
                    // Time narrows work only. The complete mined SHA3 hash must reproduce before any match.
                    setTimeout(function () { persist(candidate ? ReceiptRecovery.submittedId(tx) : ""); }, 0);
                });
                function persist(original) {
                    sql("MERGE INTO pp_txids (txpowid,transactionid,submittedid,timemilli) KEY(txpowid) VALUES ('" + id + "','" + tid + "','" + esc(original || "") + "'," + time + ")", function (r) { cb(!!r); });
                }
            });
        });
    }
    function read(cb) {
        init(function (ok) {
            if (!ok) { cb(null); return; }
            var out = {}, queries = [["ids", "pp_txids"], ["proofs", "pp_txproof"], ["posts", "pp_submissions"], ["publicRows", "pp_publichistory"]];
            function next(i) {
                if (i < queries.length) {
                    sql("SELECT * FROM " + queries[i][1], function (r) { if (!r) { message = "Transaction storage read failed"; cb(null); return; } out[queries[i][0]] = r.rows || []; next(i + 1); }); return;
                }
                Store.actList(-1, function (a, ok) {
                    if (ok === false) { failed(); return; } out.receipts = a;
                    Store.histAll(function (h, ok) {
                        if (ok === false) { failed(); return; } out.history = h;
                        Store.knownAddrsGet(function (k, ok) { if (ok === false) { failed(); return; } out.known = k; cb(out); });
                    });
                });
                function failed() { message = "Transaction storage read failed"; cb(null); }
            }
            next(0);
        });
    }
    function proofMap(data) { var p = {}; data.proofs.forEach(function (r) { p[key(r.TXPOWID)] = { verifiedDepth: Number(r.DEPTH), verifiedAt: Number(r.CHECKED), inclusionBlock: Number(r.INCLUSIONBLOCK), tip: Number(r.TIP) }; }); return p; }
    function decorate(row, proofs) {
        var p = proofs[key(row.txpowid)] || { verifiedDepth: -1, verifiedAt: 0 };
        Object.keys(p).forEach(function (k) { row[k] = p[k]; });
        row.confirmed = !row.failed && row.verifiedDepth >= 3;
        row.statusText = statusText(row); return row;
    }
    function statusText(row) {
        if (row.failed) return "Failed";
        if (row.verifiedAt && row.verifiedDepth >= 0) return row.verifiedDepth + (row.verifiedDepth === 1 ? " confirmation" : " confirmations") + " · on-chain";
        if (!hex(row.txpowid)) return "No transaction ID saved";
        return row.verifiedAt ? "Not found on this node" : "Waiting for node check";
    }
    function allHistory(data) {
        var all = {};
        data.publicRows.forEach(function (r) { try { var h = JSON.parse(r.PAYLOAD); if (hex(h.txpowid)) all[key(h.txpowid)] = h; } catch (e) {} });
        data.history.forEach(function (h) { all[key(h.txpowid)] = h; });
        return Object.keys(all).map(function (k) { return all[k]; });
    }
    function resolveReceipts(data, proofs) {
        var byTxn = {}, byPosted = {}, posts = {}, times = {};
        data.posts.forEach(function (p) { posts[key(p.POSTEDID)] = key(p.TRANSACTIONID); });
        data.ids.forEach(function (r) {
            var id = key(r.TXPOWID), t = key(r.TRANSACTIONID), prior = byTxn[t]; times[id] = Number(r.TIMEMILLI);
            if (t && (!prior || (proofs[id] && proofs[id].verifiedDepth >= 0 && (!proofs[prior] || proofs[id].verifiedAt >= proofs[prior].verifiedAt)))) byTxn[t] = id;
            if (hex(r.SUBMITTEDID)) byPosted[key(r.SUBMITTEDID)] = t;
        });
        return data.receipts.map(function (r) {
            var original = r.txpowid, t = posts[key(original)] || byPosted[key(original)], id = t && byTxn[t];
            r.originalTxpowid = original; if (id) r.txpowid = id;
            r.transactionTime = times[key(r.txpowid)] || 0;
            // Earlier versions inferred CREATE failure from missing reserves. Exact inclusion overrides that inference.
            if (proofs[key(r.txpowid)] && proofs[key(r.txpowid)].verifiedDepth >= 0) r.failed = false;
            return decorate(r, proofs);
        });
    }
    function parsed(s) { try { return JSON.parse(s || "[]"); } catch (e) { return []; } }
    function isPersonal(h, known) {
        var ins = parsed(h.inputs), outs = parsed(h.outputs), diff = parsed(h.deltas || "{}");
        var moved = Object.keys(diff).some(function (k) { return !PP.decOr(diff[k], 0).isZero(); });
        if (!moved && ins.length > outs.length && ins.length > 1 && !Object.keys(Statement.poolFlows(h, known)).length) return true;
        return moved && Object.keys(Statement.poolFlows(h, known)).length > 0;
    }
    function timeline(receipts, history, known) {
        var by = {}, shown = {}, rows = [];
        history.forEach(function (h) { by[key(h.txpowid)] = h; });
        receipts.forEach(function (r) {
            var h = by[key(r.txpowid)]; if (h) shown[key(h.txpowid)] = true;
            rows.push({ receipt: r, history: h || null, time: (h && h.timemilli) || r.transactionTime || r.ts });
        });
        history.forEach(function (h) { if (!shown[key(h.txpowid)] && isPersonal(h, known)) rows.push({ receipt: null, history: h, time: h.timemilli }); });
        rows.sort(function (a, b) { return b.time - a.time; }); return rows;
    }
    function poolEvents(h, known) {
        var flows = Statement.poolFlows(h, known), out = [], ins = parsed(h.inputs), outs = parsed(h.outputs);
        function matches(c, pool) { return key(c.address) === pool || key(c.miniaddress || c.addr) === pool; }
        Object.keys(flows).forEach(function (pool) {
            var m = flows[pool][0], t = flows[pool][1]; if (m.isZero() && t.isZero()) return;
            var input = ins.some(function (c) { return matches(c, pool); }), output = outs.some(function (c) { return matches(c, pool); });
            var token = outs.concat(ins).filter(function (c) { return matches(c, pool) && !PP.isMinima(c.tokenid); })[0];
            var kind = !input && output ? "CREATE" : input && !output ? "WITHDRAW" : m.lt(0) && t.lt(0) ? "ADD" : m.gt(0) && t.gt(0) ? "WITHDRAW" : m.times(t).lt(0) ? "SWAP" : "CHANGE";
            out.push({ pool: pool, kind: kind, minimaIn: m.lt(0), minimaAmt: m.abs().toFixed(), tokenAmt: t.abs().toFixed(), tokenid: token ? token.tokenid : "", transaction: h, txpowid: h.txpowid, ts: h.timemilli });
        });
        return out;
    }
    function snapshot(cb) {
        read(function (data) {
            if (!data) { var previous = lastSnapshot || { rows: [], receipts: [], events: [] }; previous.error = status(); cb(previous); return; }
            var proofs = proofMap(data), receipts = resolveReceipts(data, proofs);
            data.history.forEach(function (h) { decorate(h, proofs); });
            var events = [];
            allHistory(data).forEach(function (h) { decorate(h, proofs); events = events.concat(poolEvents(h, data.known)); });
            events.sort(function (a, b) { return b.ts - a.ts; });
            lastSnapshot = { rows: timeline(receipts, data.history, data.known), receipts: receipts, events: events, error: status() }; cb(lastSnapshot);
        });
    }
    function rowModel(row, labels) {
        labels = labels || {};
        var h = row.history, r = row.receipt, model = {};
        if (r) Object.keys(r).forEach(function (k) { model[k] = r[k]; });
        else {
            model.txpowid = h.txpowid; model.failed = false;
            model.verifiedDepth = h.verifiedDepth; model.verifiedAt = h.verifiedAt;
            model.confirmed = h.confirmed; model.statusText = h.statusText;
            var diff = parsed(h.deltas || "{}"), parts = [];
            Object.keys(diff).forEach(function (tid) {
                var amount = PP.decOr(diff[tid], 0); if (amount.isZero()) return;
                parts.push((amount.gt(0) ? "+" : "") + amount.toFixed() + " " + (PP.isMinima(tid) ? "MINIMA" : labels[key(tid)] || PP.shorten(tid)));
            });
            model.type = "Pool transaction";
            if (!parts.length) {
                model.type = "Consolidation";
                var coins = parsed(h.outputs), totals = {};
                coins.forEach(function (c) { var tid = c.tokenid || "0x00"; totals[tid] = PP.decOr(totals[tid], 0).plus(PP.decOr(c.amount, 0)); });
                Object.keys(totals).forEach(function (tid) { parts.push(totals[tid].toFixed() + " " + (PP.isMinima(tid) ? "MINIMA" : labels[key(tid)] || PP.shorten(tid))); });
            }
            model.summary = parts.join(" · ");
        }
        model.ts = row.time;
        model.timeLabel = (h && h.timemilli) || model.transactionTime ? "Transaction" : "Submitted";
        return model;
    }
    function verify(cb) {
        cb = cb || function () {};
        if (stopped || verifying || Date.now() - lastVerify < 10000) { cb(); return; }
        verifying = true; lastVerify = Date.now(); message = ""; change();
        read(function (data) {
            if (!data) { finish(); return; }
            var proofs = proofMap(data), receipts = resolveReceipts(data, proofs), ids = [], seen = {};
            function add(id) { if (hex(id) && !seen[key(id)]) { seen[key(id)] = true; ids.push(key(id)); } }
            function rotate(name, rows, size) { var start = (cursors[name] || 0) % Math.max(rows.length, 1); for (var i = 0; i < Math.min(size, rows.length); i++) add(rows[(start + i) % rows.length]); cursors[name] = start + size; }
            rotate("visible", visible, 8);
            var local = receipts.filter(function (r) { return !r.failed || hex(r.txpowid); }).map(function (r) { return r.txpowid; });
            local.slice(0, 3).forEach(add); rotate("local", local, 8);
            var history = allHistory(data).sort(function (a, b) { return b.timemilli - a.timemilli; }).map(function (h) { return h.txpowid; });
            history.slice(0, 3).forEach(add); rotate("history", history, 12);
            next(0);
            function next(i) {
                if (i === ids.length) { finish(); return; }
                command("txpow onchain:" + ids[i], function (reply) {
                    var r = reply && reply.response, found = r && truth(r.found), absent = r && (r.found === false || r.found === "false");
                    var depth = found ? Number(r.confirmations) : -1;
                    if (!reply || !truth(reply.status) || (!found && !absent) || (found && (r.confirmations === undefined || r.confirmations === null || r.confirmations === "" || !isFinite(depth) || depth < 0 || Math.floor(depth) !== depth))) {
                        message = "Node confirmation check failed; retrying on the next refresh"; finish(); return;
                    }
                    sql("MERGE INTO pp_txproof (txpowid,depth,checked,inclusionblock,tip) KEY(txpowid) VALUES ('" + ids[i] + "'," + depth + "," + Date.now() + "," + (Number(r.block) || 0) + "," + (Number(r.tip) || 0) + ")", function (saved) {
                        if (!saved) { message = "Could not save confirmation evidence"; finish(); return; }
                        setTimeout(function () { next(i + 1); }, 50);
                    });
                });
            }
        });
        function finish() { verifying = false; change(); cb(); }
    }
    function touches(tx, address) {
        var txn = tx && tx.body && tx.body.txn;
        return !!txn && [txn.inputs, txn.outputs].some(function (coins) { return Array.isArray(coins) && coins.some(function (c) { return c && key(c.address) === key(address); }); });
    }
    function syncPublic(force) {
        if (fetching || stopped) return; fetching = true; publicMessage = ""; change();
        read(function (data) {
            if (!data) { finish(); return; }
            Store.feedList(-1, function (feed) { Store.ownAll(function (own) {
                var addresses = [], seen = {}, now = Date.now();
                function add(a) { if (hex(a) && !seen[key(a)]) { seen[key(a)] = true; addresses.push(key(a)); } }
                own.forEach(function (p) { add(p.address); }); feed.forEach(function (e) { add(e.pool); }); Object.keys(data.known).forEach(add);
                var batch = addresses.filter(function (a) { return force || !checkedAddresses[a] || now - checkedAddresses[a] >= 120000; }).slice(0, 4);
                next(0);
                function next(i) {
                    if (i === batch.length) { finish(); verify(); return; }
                    var address = batch[i]; checkedAddresses[address] = Date.now();
                    command("txpow address:" + address, function (r) {
                        if (!r || !truth(r.status) || !Array.isArray(r.response)) { publicMessage = "Public pool lookup failed; retrying on the next refresh"; finish(); return; }
                        var rows = r.response.filter(function (tx) { return tx && hex(tx.txpowid) && touches(tx, address); });
                        function save(j) {
                            if (j === rows.length) { change(); setTimeout(function () { next(i + 1); }, 450); return; }
                            var tx = rows[j], h = History.entryFrom(tx, null), aliases = [address], txn = tx.body.txn;
                            (txn.inputs || []).concat(txn.outputs || []).forEach(function (c) { if (key(c.address) === address && c.miniaddress) aliases.push(c.miniaddress); });
                            Store.knownAddrsAdd(aliases, function () {
                                sql("MERGE INTO pp_publichistory (txpowid,payload) KEY(txpowid) VALUES ('" + key(h.txpowid) + "','" + esc(JSON.stringify(h)) + "')", function (saved) {
                                    if (!saved) { publicMessage = "Could not save public pool history"; finish(); return; }
                                    observe(tx, function (ok) { if (!ok) { publicMessage = "Could not save transaction identity"; finish(); } else save(j + 1); });
                                });
                            });
                        }
                        save(0);
                    });
                }
            }); });
        });
        function finish() { fetching = false; change(); }
    }
    return { init: init, observe: observe, rememberSubmission: rememberSubmission, snapshot: snapshot, verify: verify,
        syncPublic: syncPublic, status: status, statusText: statusText, timeline: timeline, poolEvents: poolEvents,
        readCommand: command, touches: touches, rowModel: rowModel, onChange: function (cb) { change = cb; }, visible: function (ids) { visible = ids || []; },
        stop: function () { stopped = true; change = function () {}; } };
})();
