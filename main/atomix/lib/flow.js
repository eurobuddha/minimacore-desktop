/**
 * flow — a tiny callback-flow helper so the engine reads top-to-bottom without promise microtasks (Rhino has
 * NativePromise but no event loop to drain reactions reliably between MDS events; the proven donor uses pure
 * callbacks). Attaches to AX.flow. No dependencies.
 *
 *   AX.flow.waterfall([ fn(next), fn(a, next), ... ], done)  — each step calls next(err, ...values); the values
 *   become the next step's leading args; a truthy err short-circuits to done(err). done(err, lastValues...).
 *   AX.flow.each(items, fn(item, i, next), done) — sequential over a list.
 *   AX.flow.map(items, fn(item, i, next(err, val)), done(err, results)) — sequential map.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    /** once(fn) → a callback that runs fn at most once (a double-fired MDS callback after a txnpost step must NOT
     *  double-execute the pipeline; this is the foundation of the settlement engine, so it fails safe here). */
    function once(fn) { var called = false; return function () { if (called) return; called = true; return fn.apply(null, arguments); }; }

    function waterfall(steps, done) {
        var fin = once(done || function () {});
        var i = 0, guard = 0;
        function makeNext(myGuard) {
            return once(function (err) {
                if (myGuard !== guard) return;        // a stale next from an earlier step is a no-op
                if (err) return fin(err);
                var args = Array.prototype.slice.call(arguments, 1);
                var step = steps[i++];
                if (!step) return fin.apply(null, [null].concat(args));
                guard++;
                args.push(makeNext(guard));
                try { step.apply(null, args); } catch (e) { fin(e); }
            });
        }
        makeNext(0)(null);
    }

    function each(items, fn, done) {
        var fin = once(done || function () {});
        var i = 0;
        function step() {
            if (i >= items.length) return fin(null);
            var idx = i++;
            var n = once(function (err) { if (err) return fin(err); step(); });
            try { fn(items[idx], idx, n); } catch (e) { fin(e); }
        }
        step();
    }

    function map(items, fn, done) {
        var fin = once(done || function () {});
        var out = [], i = 0;
        function step() {
            if (i >= items.length) return fin(null, out);
            var idx = i++;
            var n = once(function (err, val) { if (err) return fin(err); out[idx] = val; step(); });
            try { fn(items[idx], idx, n); } catch (e) { fin(e); }
        }
        step();
    }

    AX.flow = { waterfall: waterfall, each: each, map: map, once: once };
})(typeof globalThis !== 'undefined' ? globalThis : this);
