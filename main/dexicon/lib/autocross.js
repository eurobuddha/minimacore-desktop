/**
 * autocross — mirror of Dexicon Android 0.1.47 maker/AutoCross.java (owner 2026-10-29): when PandaPools moves past my
 * own FAST ladder — its selling price above my best ask, or its buying price below my best bid — this node trades the
 * pool back to that rung, sized to the rungs it moved past. One pool-only composite transaction (PandaComposite +
 * PandaTxn.fillComposite, the BOOK/POOL route minus the book): it pins the new reserves, so a pool that moved first
 * rejects it whole. Recorded like any POOL trade (PDService.fillMeta → ACTIVITY, TRADES). Only while the MEXC price is
 * fresh, only when it beats the rung after the 0.5 % fee, at most crossPerHour (default 3) an hour.
 * Rhino-safe (ES5). Requires AX.maker and the vendored resting/ engine (PandaDEX, PandaPool, PandaComposite).
 *
 * kv 'mm_cross' = JSON array of cross times (ms) · 'mm_pool' = the market-maker card's pool line
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var HOUR_MS = 3600000, FAIL_GAP_MS = 60000;
    var state = { inFlight: false, failedMs: 0, crossed: false };   // crossed: the last run() posted (service.js re-backs the ladder at once)

    /** Pure. The cross my live rungs call for against these pools, or null when the pool is in line (or it would not pay). */
    function decide(pools, rungs, mexcMid) {
        var P = g.PandaDEX, PP = g.PandaPool, hi = null, lo = null, i, p, s;
        if (!(mexcMid > 0) || !pools || !rungs) return null;
        for (i = 0; i < pools.length; i++) {
            p = pools[i];
            if (!PP.funded(p) || String(p.tok).toLowerCase() !== P.USDT.toLowerCase()) continue;
            s = PP.spotPrice(p);
            if (hi === null || s.gt(hi)) hi = s;
            if (lo === null || s.lt(lo)) lo = s;
        }
        if (hi === null) return null;
        var sellAt = hi.mul('0.995'), buyAt = lo.div('0.995');   // what the pool pays / charges after its 0.5 % fee
        var bestAsk = null, bestBid = null, askWant = P.d(0), bidCash = P.d(0), asks = [], bids = [], o, px, rem;
        for (i = 0; i < rungs.length; i++) {
            o = rungs[i];
            if (!o || o.status !== 'live' || !(o.coins || []).length) continue;   // an unbacked rung is not on offer: never cross what the ladder does not hold
            px = P.d(o.price); rem = P.d(o.remaining);
            if (o.side === 'sell' && px.lt(sellAt)) { askWant = askWant.add(rem); asks.push(o); if (bestAsk === null || px.lt(bestAsk)) bestAsk = px; }
            if (o.side === 'buy' && px.gt(buyAt)) { bidCash = bidCash.add(px.mul(rem)); bids.push(o); if (bestBid === null || px.gt(bestBid)) bestBid = px; }
        }
        var sellGap = bestAsk === null ? null : sellAt.div(bestAsk).sub(1), buyGap = bestBid === null ? null : bestBid.div(buyAt).sub(1);
        if (sellGap === null && buyGap === null) return null;
        var sell = buyGap === null || (sellGap !== null && sellGap.gte(buyGap));   // the side further out of line
        // a buy pays at most bestBid per MINIMA, and the crossed bids' coins hold Σ price × remaining: size it so they always cover it
        var limit = sell ? bestAsk : bestBid, want = sell ? askWant : P.down(bidCash.div(bestBid), 8);
        var plan = g.PandaComposite.plan([], pools, !sell, want, limit, 0);
        if (g.PandaComposite.isEmpty(plan) || plan.poolMinima.lt(1)) return null;
        var eff = plan.effectivePrice, mexc = P.d(String(mexcMid));
        if (sell ? (eff.lt(limit) || eff.lte(mexc)) : (eff.gt(limit) || eff.gte(mexc))) return null;
        // the crossed rungs' backing coins, best price first — the cross spends these (they are what fills), nothing else
        var crossed = (sell ? asks : bids).slice().sort(function (a, b) { return sell ? P.d(a.price).cmp(P.d(b.price)) : P.d(b.price).cmp(P.d(a.price)); }), coins = [];
        crossed.forEach(function (r) { r.coins.forEach(function (id) { if (coins.indexOf(id) < 0) coins.push(id); }); });
        return { sell: sell, limit: limit, want: want, gapPct: (sell ? sellGap : buyGap).mul(100), plan: plan, coins: coins };
    }

    // Durable pre-post marker. Never release on elapsed time, a failed callback, or an empty lookup.
    function savePending(ctx,record,cb) {
        var value=JSON.stringify(record);
        ctx.mds.kvSet('mm_cross_pending',value,function(err){
            if(err)return cb(false);
            ctx.mds.sql("SELECT v FROM ax_kv WHERE k='mm_cross_pending'",function(r){
                cb(!!r&&r.status===true&&r.rows&&r.rows.length===1&&(r.rows[0].V||r.rows[0].v)===value);
            });
        });
    }
    function confirmedOutput(reply,id,tip) {
        var rows=reply&&reply.status===true&&!reply.pending&&reply.response;
        if(!Array.isArray(rows)||rows.length!==1)return false;
        var c=rows[0],created=String(c.created),height=String(tip);
        return String(c.coinid).toLowerCase()===id.toLowerCase()&&c.spent!==true&&c.spent!=='true'
            &&/^[0-9]+$/.test(created)&&/^[0-9]+$/.test(height)&&Number(created)>0&&Number(height)-Number(created)>=3;
    }
    function previousSettled(ctx,cb) {
        ctx.mds.sql("SELECT v FROM ax_kv WHERE k='mm_cross_pending'",function(r){
            if(!r||r.status!==true||!Array.isArray(r.rows))return cb(false);
            if(!r.rows.length)return cb(true);
            var record;try{record=JSON.parse(r.rows[0].V||r.rows[0].v);}catch(e){return cb(false);}
            if(record===null)return cb(true);
            /* 'building' is overwritten (durably) by 'posting' before txnpost, and run() only gets here with no cross in
             * flight, so a 'building' record is a cross interrupted before posting. 'refused' = the node answered status:false.
             * Neither reached the network. */
            if(record&&(record.phase==='building'||record.phase==='refused'))return savePending(ctx,null,cb);
            var outs=record&&record.outs,i=0;
            if(!Array.isArray(outs)||!outs.length)return cb(false);
            function next(){
                if(i>=outs.length)return cb(false);
                var id=outs[i++];if(!/^0x[0-9a-fA-F]{64}$/.test(id))return cb(false);
                ctx.svc.cmd('coins coinid:'+id,function(reply){
                    if(confirmedOutput(reply,id,ctx.svc.block))savePending(ctx,null,cb);else next();
                });
            }next();
        });
    }
    /** review 7 Nov (R3-5): auto-cross keeps its OWN jump guard (the ladder's runs only while pegged, so a manual ladder
     *  read 0 / a frozen mid). 0 while a >3 % move is unconfirmed. */
    var crossFeed = { mid: 0, suspect: 0 };
    function crossMid(ctx) { var m = AX.ladder.guard(crossFeed, ctx.price.mid()); return crossFeed.suspect > 0 ? 0 : m; }
    function stillEnabled(ctx,d,cb) {
        ctx.mds.kvGet('mm_config','',function(cs){
            var cfg=AX.ladder.fromJson(cs);
            if(!cfg.enabled||!cfg.autoCross||!ctx.price.fresh()||!(crossMid(ctx)>0))return cb(false);   // review 7 Nov: never while a MEXC jump is unconfirmed
            AX.maker.load(ctx.mds,function(err,orders){
                if(err)return cb(false);
                var live={};(orders||[]).forEach(function(o){if(o.status==='live')(o.coins||[]).forEach(function(id){live[String(id).toLowerCase()]=true;});});
                cb(d.coins.every(function(id){return !!live[String(id).toLowerCase()];}));
            });
        });
    }

    /* ---- REVIEW: the owner's way out of a cross, or a PandaDEX fill, whose outcome is unknown. Never automatic.
     * Each coin is looked up twice: `coins checkmempool:true` returns it only while it is unspent AND in no pending
     * transaction; plain `coins` also returns it while a mempool transaction spends it; neither returns a spent coin. */
    function coinState(cmd,id,cb){
        if(!/^0x[0-9a-fA-F]{64}$/.test(id))return cb('unknown');
        function one(r){var rows=r&&r.status===true&&!r.pending&&Array.isArray(r.response)?r.response:null;if(!rows)return null;
            return rows.length===1&&String(rows[0].coinid).toLowerCase()===id.toLowerCase()&&rows[0].spent===false?'live':'none';}
        cmd('coins checkmempool:true coinid:'+id,function(a){var x=one(a);if(!x)return cb('unknown');if(x==='live')return cb('unspent');
            cmd('coins coinid:'+id,function(b){var y=one(b);cb(!y?'unknown':y==='live'?'mempool':'spent');});});
    }
    function coinStates(cmd,ids,cb){var out=[],i=0;(function next(){if(i>=ids.length)return cb(out);var id=ids[i++];coinState(cmd,id,function(st){out.push({coinid:id,state:st});next();});})();}
    function verdictOf(rows){
        if(!rows.length)return {safe:true,unchecked:true,text:'No coins were recorded for it, so your node cannot check it. Release only after checking TRADES and ASSETS.'};
        if(rows.some(function(r){return r.state==='unknown';}))return {safe:false,text:'Your node could not answer for every coin. Try again in a minute.'};
        if(rows.some(function(r){return r.state==='mempool';}))return {safe:false,text:'It is still in the mempool. Wait for a block; it settles by itself.'};
        if(rows.every(function(r){return r.state==='unspent';}))return {safe:true,unspent:true,text:'None of its coins were spent and none are pending: it never went through. Releasing frees them for trading again.'};
        return {safe:true,text:'Its coins were spent, so it went through or was replaced. Releasing lets auto-cross continue; check TRADES for the result.'};
    }
    /** cb({cross, fill}): each null, or {coins:[{coinid,state}], verdict:{safe,text}, txpowid, ...}. */
    function review(ctx,cb){
        var svc=ctx.svc,cmd=svc.cmd;
        ctx.mds.sql("SELECT v FROM ax_kv WHERE k='mm_cross_pending'",function(r){
            var rec=null;try{rec=r&&r.status===true&&r.rows&&r.rows.length===1?JSON.parse(r.rows[0].V||r.rows[0].v):null;}catch(e){rec=null;}
            function fillPart(cross){
                if(!fillStuck(svc))return cb({cross:cross,fill:null});
                coinStates(cmd,svc.fillCoins.slice(),function(rows){cb({cross:cross,fill:{coins:rows,verdict:verdictOf(rows),txpowid:svc.fillMeta.txpowid||''}});});
            }
            if(!rec||typeof rec!=='object')return fillPart(null);
            var own=Array.isArray(rec.own)&&rec.own.length?rec.own:Array.isArray(rec.ins)?rec.ins:[];
            coinStates(cmd,own,function(rows){fillPart({coins:rows,verdict:verdictOf(rows),handle:rec.handle||'',txpowid:rec.txpowid||'',phase:rec.phase||'',
                inputs:(Array.isArray(rec.ins)?rec.ins:[]).concat(Array.isArray(rec.own)?rec.own:[])});});
        });
    }
    function fillStuck(svc){return !!(svc&&svc.fillMeta&&svc.fillBlock>0&&svc.block-svc.fillBlock>svc.SWEEP_DEADLINE_BLOCKS&&Array.isArray(svc.fillCoins));}
    /** The owner pressed RELEASE after reading review(). Re-checks first; cb(error|null). which: 'cross' | 'fill'. */
    function release(ctx,which,cb){
        review(ctx,function(st){
            var part=st[which],svc=ctx.svc;
            if(!part)return cb('Nothing is waiting there any more.');
            if(!part.verdict.safe)return cb(part.verdict.text);
            if(which==='cross')return savePending(ctx,null,function(ok){
                if(!ok)return cb('Could not clear the record. Nothing changed.');
                ctx.log('auto-cross released by the owner after review: '+part.verdict.text+' txpowid '+(part.txpowid||'none'));
                // Only when every own coin is unspent and in no pending transaction, and only that transaction's claims.
                if(part.verdict.unspent&&part.handle&&g.PoolInputClaims)return g.PoolInputClaims.release(part.inputs,part.handle,function(){cb(null);});
                cb(null);
            });
            if(part.verdict.unspent){svc.fillCoins=null;svc.fillBlock=0;svc.filling={};svc.fillMeta=null;svc.saveFill();
                svc.setStage('Released after review: that trade never confirmed and nothing was spent.');return cb(null);}
            svc.fillCoins=null;svc.fillBlock=0;svc.filling={};
            svc.recordFill('LOCAL_ONLY','Released by the owner after review: source coins spent; proceeds not matched on this node');
            svc.setStage('Released after review: the coins were spent; check TRADES and ASSETS for the result.');cb(null);
        });
    }

    function line(d) {
        var P = g.PandaDEX;
        return 'pool ' + d.gapPct.toFixed(2) + '% ' + (d.sell ? 'above your best ask' : 'below your best bid') + ' — ' + (d.sell ? 'sell ' : 'buy ')
            + P.plain(d.plan.totalMinima) + ' MINIMA @ avg ' + P.plain(d.plan.effectivePrice);
    }

    /** One look at the pool after a ladder pass; crosses when switched on and every guard passes. ctx = { mds, price,
     *  svc (PDService), log, changed }. cb() always. */
    function run(ctx, cb) {
        var mds = ctx.mds, svc = ctx.svc;
        state.crossed = false;
        mds.kvGet('mm_config', '', function (cs) {
            var c = AX.ladder.fromJson(cs);
            if (!c.enabled) return mds.kvSet('mm_pool', '', function () { cb(); });
            if (!svc || !svc.poolHaveLive || !svc.identity) return cb();
            mds.kvGet('mm_ids', '{}', function (is) {
                var ids = {}; try { ids = JSON.parse(is || '{}') || {}; } catch (e) { }
                AX.maker.load(mds, function (e0, list) {
                    var rungs = [], k, o, now = Date.now();
                    for (k in ids) { o = AX.maker.find(list || [], ids[k]); if (o) rungs.push(o); }
                    var mid = crossMid(ctx), d = mid > 0 ? decide(svc.pools, rungs, mid) : null;   // review 7 Nov: a jump-guarded mid, never the raw feed
                    mds.kvGet('mm_cross', '[]', function (rs) {
                        var recent = [], cap = parseInt(String(c.crossPerHour === undefined ? '3' : c.crossPerHour), 10), a, i;
                        try { a = JSON.parse(rs || '[]') || []; for (i = 0; i < a.length; i++) if (now - a[i] < HOUR_MS) recent.push(a[i]); } catch (e) { }
                        if (!(cap >= 0)) cap = 3;
                        var why = !c.autoCross ? ' (auto-cross off)' : !ctx.price.fresh() ? ' (waiting: MEXC price not fresh)'
                            : recent.length >= cap ? ' (waiting: ' + cap + ' crosses this hour)' : now - state.failedMs < FAIL_GAP_MS ? ' (retrying shortly)' : '';
                        var st = !(mid > 0) ? 'waiting for the MEXC price' : !d ? 'pool in line with your ladder' : line(d) + why;
                        mds.kvSet('mm_pool', st, function () {
                            if (state.inFlight || svc.busy) return cb();
                            /* mm_review = '1' shows the REVIEW button: something is waiting on an outcome only the owner can settle. */
                            function flag(on, msg, next) { mds.kvSet('mm_review', on ? '1' : '', function () { if (!msg) return next(); mds.kvSet('mm_pool', msg, function () { next(); }); }); }
                            if (fillStuck(svc)) return flag(true, 'A PandaDEX trade has not confirmed in ' + svc.SWEEP_DEADLINE_BLOCKS + ' blocks. Auto-cross waits; tap REVIEW to check it.', cb);
                            previousSettled(ctx,function(settled){
                                if(!settled)return flag(true,'Waiting for the previous cross to confirm. Its outcome is unknown; tap REVIEW to check it.',cb);
                                flag(false,null,function(){
                                    if (!d || why || svc.fillMeta) return cb();   // one PandaDEX trade at a time
                                    stillEnabled(ctx,d,function(enabled){if(enabled)execute(ctx,d,recent,cb);else cb();});
                                });
                            });
                        });
                    });
                });
            });
        });
    }

    function execute(ctx, d, recent, cb) {
        var svc = ctx.svc, plan = d.plan, P = g.PandaDEX, i;
        state.inFlight = true;
        svc.filling = {};
        for (i = 0; i < plan.sourceCoinIds.length; i++) svc.filling[plan.sourceCoinIds[i]] = true;
        svc.setBusy(true); svc.setStage('Auto-cross: ' + line(d));
        ctx.log('auto-cross: ' + line(d));
        var attempted=false, pending={phase:'building',handle:'',own:d.coins.slice(),ins:[],outs:[],txpowid:''};
        savePending(ctx,pending,function(saved){
        if(!saved){state.inFlight=false;svc.setBusy(false);svc.setStage('Auto-cross paused: could not save its recovery record.');cb();return;}
        function guarded(command,reply){
            /* Re-check before every signature too: a cross switched off while it waited for the signing lock must not
             * spend a key use. */
            if(command.indexOf('txnsign ')===0)return stillEnabled(ctx,d,function(enabled){
                if(!enabled)return reply({status:false,error:'Auto-cross was disabled or its orders were cancelled. Nothing was signed.'});
                svc.cmd(command,reply);
            });
            if(command.indexOf('txnpost ')!==0)return svc.cmd(command,reply);
            var handle=/^txnpost id:([A-Za-z0-9_-]{1,150})(?:\s|$)/.exec(command);pending.handle=handle?handle[1]:'';
            stillEnabled(ctx,d,function(enabled){
                if(!enabled)return reply({status:false,error:'Auto-cross was disabled or its orders were cancelled. Nothing was posted.'});
                pending.phase='posting';
                savePending(ctx,pending,function(durable){
                    if(!durable)return reply({status:false,error:'Could not save the pre-post receipt. Nothing was posted.'});
                    attempted=true;
                    svc.cmd(command,function(r){
                        var response=r&&r.response,txpow=response&&(response.txpow||response),txn=txpow&&txpow.body&&txpow.body.txn,hex=function(id){return /^0x[0-9a-fA-F]{64}$/.test(id);};
                        pending.outs=txn&&Array.isArray(txn.outputs)?txn.outputs.map(function(c){return c.coinid;}).filter(hex):[];
                        pending.ins=txn&&Array.isArray(txn.inputs)?txn.inputs.map(function(c){return c.coinid;}).filter(hex):[];
                        pending.txpowid=response&&typeof response.txpowid==='string'?response.txpowid:'';
                        /* status:false and not pending = the node refused it: nothing was broadcast. */
                        pending.phase=r&&r.status===false&&!r.pending?'refused':'submitted';
                        savePending(ctx,pending,function(ok){reply(ok?r:{status:false,error:'Submission outcome needs review: receipt storage failed.'});});
                    });
                });
            });
        }
        fill(guarded, svc.identity, d, function (error, tx) {
            svc.setBusy(false);
            state.inFlight = false;
            if (error) {
                svc.filling = {}; state.failedMs = Date.now();
                svc.setStage('Auto-cross failed — ' + error); ctx.log('auto-cross failed: ' + error);
                if (ctx.changed) ctx.changed();
                if(!attempted||pending.phase==='refused')return savePending(ctx,null,function(){cb();});
                return cb();
            }
            svc.setStage('Auto-cross posted — ' + (d.sell ? 'sold ' : 'bought ') + P.plain(plan.totalMinima) + ' MINIMA into PandaPools');
            svc.fillCoins = plan.sourceCoinIds.slice(); svc.fillBlock = svc.block;
            svc.fillMeta = { spentcoin: plan.sourceCoinIds[0], price: P.plain(plan.effectivePrice), size: P.plain(plan.totalMinima), buy: !d.sell, txpowid: tx || '',
                proceeds: P.plain(d.sell ? plan.totalUsdt : plan.totalMinima), postBlock: svc.block, sourceKind: 'POOL', autoCross: true,
                sourceCoinids: plan.sourceCoinIds.slice() };
            svc.saveFill();
            state.crossed = true;
            recent.push(Date.now());
            ctx.mds.kvSet('mm_cross', JSON.stringify(recent), function () { if (ctx.changed) ctx.changed(); svc.refresh(); cb(); });
        });
        });
    }

    /** PandaTxn.fillComposite funded ONLY by my crossed rungs' own coins (29 Oct: the wallet scan could not reach the
     *  ladder's split coins, and a fallback to the wider wallet oversold the ladder by 9000 MINIMA). */
    function fill(cmd, identity, d, done) {
        var T = g.PandaTxn, prep = T.prepareComposite(d.plan, !d.sell);
        ownCoins(cmd, prep.payTok, prep.needed, d.coins, function (err, coins, sum) {
            if (err) return done(err);
            T.ensurePools(cmd, prep.route && prep.route.ok ? prep.route.allocs : [], 0, function (perr) {
                if (perr) { g.PandaCoinLock.release(coins); return done(perr); }
                T.buildComposite(cmd, identity, d.plan, prep, !d.sell, coins, sum, done);
            });
        });
    }

    /** My unspent, stateless coins of `token` named by `ids` (at most 8), reserved, if they cover `need`. */
    function ownCoins(cmd, token, need, ids, cb) {
        var F = g.PandaFunding, L = g.PandaCoinLock, P = g.PandaDEX, got = [], sum = P.d(0), i = 0;
        (function next() {
            if (sum.gte(need) || i >= ids.length || got.length >= 8) {
                if (sum.lt(need)) return cb("the crossed rungs' own coins no longer cover it. Nothing was posted.");
                L.reserve(got); return cb(null, got, sum);
            }
            var id = ids[i++];
            if (L.isReserved(id)) return next();
            cmd('coins relevant:true sendable:true checkmempool:true coinid:' + id, function (r) {   // checkmempool: never a coin a pending txn already spends
                var rows = F.rows(r), c = rows && rows.length === 1 ? rows[0] : null, v = c ? F.value(c) : null;
                if (c && P.eqTok(c.tokenid, token) && String(c.coinid).toLowerCase() === String(id).toLowerCase() && !c.spent
                    && !(c.state && Object.keys(c.state).length) && v && v.gt(0)) { got.push(c); sum = sum.add(v); }
                next();
            });
        })();
    }

    /** The switch-on warning (owner 29 Oct): what auto-cross does, what would cross right now, what the owner agrees to.
     *  Same text as the APK's MarketMaker.crossWarning. */
    function warning(poolLine, perHour) {
        var now = String(poolLine || '').replace(/ \(auto-cross off\)$/, ''), hold = null, m = /^(.*) \(([^)]*)\)$/.exec(now);
        if (m) { now = m[1]; hold = m[2]; }   // e.g. "waiting: 3 crosses this hour" — it would NOT trade on SAVE
        var cap = parseInt(String(perHour || '').trim(), 10); cap = cap >= 0 ? String(cap) : '3';   // as run() reads it
        var right = !now || /^waiting/.test(now) ? 'Not known yet — the pool position shows once the ladder is running.'
            : /^pool in line/.test(now) ? 'Nothing. The pool is in line with your ladder, so nothing would cross.'
            : 'YES — ' + now + '.\n' + (hold === null ? 'This trade is made as soon as you SAVE (if the MEXC price is fresh).'
                : 'Not straight away (' + hold + ') — it is made once that clears, if the pool is still out of line.');
        return 'Auto-cross trades your own funds against PandaPools, automatically, with no further confirmation.\n\n'
            + 'WHAT IT DOES\nWhen the pool\'s price rises past your best ask, your node SELLS MINIMA into the pool until it is back at that ask. '
            + 'When it falls past your best bid, your node BUYS. Each trade is the size of your rungs the pool moved past — the coins behind those '
            + 'rungs are spent, exactly as if a taker had filled them.\n\n'
            + 'WHAT WOULD CROSS RIGHT NOW (your live ladder)\n' + right + '\n\n'
            + 'WHAT YOU ARE AGREEING TO\n'
            + '• Up to ' + cap + ' trades an hour. If someone keeps pushing the pool back, it crosses again each time and your inventory moves '
            + 'one way: selling turns MINIMA into MxUSD, buying the reverse. A side of your ladder can empty until you top it up.\n'
            + '• Trades are on-chain and final. Each one beats your rung price after the pool\'s 0.5 % fee and the MEXC price at that moment, '
            + 'but MEXC can move afterwards.\n'
            + '• It never trades more than your backed rungs hold, never while the MEXC price is stale, and the whole trade is rejected if the pool '
            + 'moves first.\n\n'
            + 'Every cross appears in ACTIVITY and TRADES. Untick it here and SAVE to stop.';
    }

    AX.autocross = { decide: decide, line: line, run: run, warning: warning, _state: state, confirmedOutput: confirmedOutput, previousSettled: previousSettled, stillEnabled: stillEnabled, review: review, release: release, verdictOf: verdictOf, coinState: coinState };
})(typeof globalThis !== 'undefined' ? globalThis : this);
