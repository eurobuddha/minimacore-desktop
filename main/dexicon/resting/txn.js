var PandaTxn = PandaTxn || {};
(function (T, P) {
  T.run = function(cmd, steps, fail, done, n) {
    var i, invalid, called=false; n=n||0;
    if (n===0) for(i=0;i<steps.length;i++) { invalid=PandaSafety.commandFailure(steps[i]); if(invalid)return done(invalid); }
    if(n>=steps.length)return done(null);
    T.progress(steps[n].indexOf("txnsign ")===0 ? "Signing transaction" : "Building transaction");
    cmd(steps[n],function(r){
      if(called)return;called=true;
      if(!r || !PandaSafety.truthy(r.status) || PandaSafety.truthy(r.pending)) {
        if(fail)cmd("txndelete id:"+fail,function(){});
        return done(PandaSafety.truthy(r&&r.pending)?"Command queued for approval; it has not completed. Check Pending in MiniHub before retrying.":(r&&r.error)||("Failed: "+steps[n]));
      }
      T.run(cmd,steps,fail,done,n+1);
    });
  };
  T.id = function (prefix) { return prefix+"_"+Date.now()+"_"+Math.floor(Math.random()*1000000000); };
  /* Narration hook. The service points this at PDService.setStage so a trade reports what it is
     actually doing instead of showing one frozen line for minutes. No-op by default. */
  T.stage = function () {};
  T.progress = function(message) { try { T.stage(message); } catch(ignore) {} };
  T.MAX_FUNDING_INPUTS = 8;
  /* Limit/service.js checks the sign error for LOCK and says what to do about it. A locked vault
     fails EVERY signature, and on a node left locked that is an ordinary state — reporting the raw
     node error just tells the user something broke. minima-skills.md also records the other common
     one: keys materialise asynchronously, so signing too soon gives "Public Key not found". */
  T.signError = function (raw) {
    var e = String(raw || "");
    if (e.toUpperCase().indexOf("LOCK") >= 0)
      return "Your node vault is LOCKED — unlock it in Minima, then try again. Nothing was sent.";
    if (e.toUpperCase().indexOf("PUBLIC KEY NOT FOUND") >= 0)
      return "The node has not finished preparing that order's key yet — wait for the next block and try again. Nothing was sent.";
    return "";
  };
  /* An order can belong to an older wallet key. Refuse before we reach the node if that key is not
     one this wallet holds, so the failure names itself instead of arriving as a raw node error. */
  T.holdsKey = null;   /* service sets this to a function(publickey) -> boolean */
  T.ownerKeyMissing = function (keys) {
    var i;
    if (typeof T.holdsKey !== "function") { for(i=0;i<keys.length;i++)if(keys[i]!=="auto")return keys[i]; return null; }
    for (i = 0; i < keys.length; i++) if (keys[i] !== "auto" && !T.holdsKey(keys[i])) return keys[i];
    return null;
  };
  /* `signKey` may be one key, an array of keys (a batch cancel needs one signature per distinct
     owner), or nothing at all — which means `auto`. Every build->sign->post chain in this file
     funnels through here, so this is where the serial signing gate is held. See signlock.js: two
     concurrent signs of one Winternitz key reuse a leaf and leak it. */
  T.checkPost = function (cmd,id,steps,done,signKey) {
    var keys = signKey ? (Array.isArray(signKey)?signKey:[signKey]) : ["auto"], missing;
    missing = T.ownerKeyMissing(keys);
    if (missing) return done("This wallet does not hold the key that owns that order (" + missing + "). Nothing was sent.");
    var inputIds=[],i,match,invalid;
    for(i=0;i<steps.length;i++) {
      invalid=PandaSafety.commandFailure(steps[i]);if(invalid)return done(invalid);
      if(steps[i].indexOf("txninput ")===0){match=/(?:^|\s)coinid:(\S+)/.exec(steps[i]);if(!match||!PandaSafety.hex(match[1]))return done("Invalid transaction input. Nothing was signed.");inputIds.push(match[1]);}
    }
    if(!inputIds.length||inputIds.length>PandaFunding.MAX_INPUTS)return done("Too many transaction inputs. Consolidate funding or use fewer orders/pools.");
    if(!PandaCoinLock.claimInputs(inputIds))return done("An input is already in another queued transaction or appears twice. Wait and refresh.");
    PoolInputClaims.check(inputIds,cmd,function(available){
    if(!available){PandaCoinLock.finishInputs(inputIds);done("An input is already submitted or reservation storage is unavailable. Wait for confirmation and refresh.");return;}
    T.progress("Waiting for the signing lock…");
    PandaSignLock.gate("dex", function (release) {
      /* Release exactly once, on every exit path — success, validation failure, post rejection
         and build error alike. Only the operation callback releases the signing slot. */
      var finished=false;
      function finish(err, tx) { if(finished)return;finished=true;PandaCoinLock.finishInputs(inputIds);try { done(err,tx); } finally { release.free(); } }
      var k;
      for (k = 0; k < keys.length; k++) steps.push("txnsign id:"+id+" publickey:"+keys[k]);
      steps.push("txnbasics id:"+id);
      /* txncheck is the only command whose response is the validation verdict. Do not infer
       * validity from txnlist or txnpost: the latter merely means mempool acceptance. */
      T.progress("Signing " + steps.length + " step" + (steps.length===1?"":"s") + "…");
      T.run(cmd,steps,id,function(err){ if(err)return finish(T.signError(err) || err);
        T.progress("Checking the transaction before it is sent…");
        /* txnexport is not serialized TxPoW. The stock node enforces its actual limit at txnpost. */
        cmd("txncheck id:"+id,function(check){
          var failure=PandaSafety.checkFailure(check);
          if(failure) { cmd("txndelete id:"+id,function(){}); return finish(failure); }
          T.progress("Posting to the network…");
          PoolInputClaims.post(inputIds,id,function(saved){if(!saved){cmd("txndelete id:"+id,function(){});return PoolInputClaims.release(inputIds,id,function(){finish("Could not persist input claims. Nothing was posted.");});}
          cmd("txnpost id:"+id,function(post){if(!post||post.status!==true||post.pending===true){cmd("txndelete id:"+id,function(){});
            /* The node said no (status:false, not pending): nothing was broadcast, so free these inputs. */
            if(post&&post.status===false&&post.pending!==true)return PoolInputClaims.release(inputIds,id,function(){finish(PandaSafety.postError(post));});
            return finish(PandaSafety.postError(post));}cmd("txndelete id:"+id,function(){});finish(null,post.response&&post.response.txpowid||id);});
          });
        });
      });
    }, function (blocked) { PandaCoinLock.finishInputs(inputIds);done(blocked); });
    });
  };
  /* Orders can belong to an older wallet key. `auto` may choose the current receive key,
     but the V5 owner branch requires SIGNEDBY(port 0), so cancel must name that exact key. */
  T.cancel = function(cmd,o,done){if(!P.safeOrder(o))return done("Invalid order. Nothing was signed.");var id=T.id("cancel"),s=["txncreate id:"+id,"txninput id:"+id+" coinid:"+o.coinid,"txnoutput id:"+id+" amount:"+P.plain(o.locked)+" address:"+o.wantAddr+(P.eqTok(o.lockedTok,"0x00")?"":" tokenid:"+o.lockedTok)+" storestate:false"];T.checkPost(cmd,id,s,done,o.ownerPk);};
  /* Android DexTxn.cancelBatch port: order inputs first, index-matched full refunds. */
  T.cancelBatch = function(cmd,orders,done){var id=T.id("cancelb"),s=["txncreate id:"+id],keys=[],seen={},i,o;if(!orders||!orders.length)return done("Nothing to cancel");if(orders.length>P.MAX_ORDERS)return done("Too many orders for one transaction");for(i=0;i<orders.length;i++)if(!P.safeOrder(orders[i]))return done("Invalid order. Nothing was signed.");if(orders.length===1)return T.cancel(cmd,orders[0],done);for(i=0;i<orders.length;i++){o=orders[i];s.push("txninput id:"+id+" coinid:"+o.coinid);}for(i=0;i<orders.length;i++){o=orders[i];s.push("txnoutput id:"+id+" amount:"+P.plain(o.locked)+" address:"+o.wantAddr+(P.eqTok(o.lockedTok,"0x00")?"":" tokenid:"+o.lockedTok)+" storestate:false");}for(i=0;i<orders.length;i++){o=orders[i];if(o.ownerPk&&!seen[o.ownerPk]){seen[o.ownerPk]=true;keys.push(o.ownerPk);}}T.checkPost(cmd,id,s,done,keys);};
  /* Android DexTxn.relock port: owner branch keeps the same funds on the covenant address,
     optionally changing port 2 / price. */
  T.relock = function(cmd,o,newWant,done){if(!P.safeOrder(o))return done("Invalid order. Nothing was signed.");if(newWant!==null&&newWant!==undefined&&!P.amountOk(PandaSafety.decimal(String(newWant))))return done("Invalid new amount. Nothing was signed.");var id=T.id("relock"),want=newWant===null||newWant===undefined?o.wantAmt:P.d(newWant),price=P.portPrice(want,o.locked),s=["txncreate id:"+id,"txninput id:"+id+" coinid:"+o.coinid,"txnoutput id:"+id+" amount:"+P.plain(o.locked)+" address:"+o.addr+(P.eqTok(o.lockedTok,"0x00")?"":" tokenid:"+o.lockedTok)+" storestate:true","txnstate id:"+id+" port:0 value:"+o.ownerPk,"txnstate id:"+id+" port:1 value:"+o.wantAddr,"txnstate id:"+id+" port:2 value:"+P.plain(want),"txnstate id:"+id+" port:3 value:"+o.wantTok,"txnstate id:"+id+" port:4 value:"+o.orderId,"txnstate id:"+id+" port:5 value:"+(o.sell?"1":"0"),"txnstate id:"+id+" port:6 value:"+P.plain(price),"txnstate id:"+id+" port:7 value:"+(o.gtc?"1":"0"),"txnstate id:"+id+" port:8 value:"+P.plain(o.minRem)];T.checkPost(cmd,id,s,done,o.ownerPk);};
  T.newWantForPrice = function(o, price){price=P.d(price);return o.sell?P.up(P.d(o.locked).mul(price),P.DP):P.down(P.d(o.locked).div(price),P.DP);};
  T.collectExpired = function(cmd,o,done){if(!P.safeOrder(o))return done("Invalid order. Nothing was signed.");var id=T.id("collect"),s=["txncreate id:"+id,"txninput id:"+id+" coinid:"+o.coinid,"txnoutput id:"+id+" amount:"+P.plain(o.locked)+" address:"+o.wantAddr+(P.eqTok(o.lockedTok,"0x00")?"":" tokenid:"+o.lockedTok)+" storestate:false"];T.checkPost(cmd,id,s,done);};
  /* A funding coin carrying state brings its own script into our transaction. Native drops these
     and we did not — one of the few remaining differences in the coin selector. */
  T.hasState = function(c){var st=c&&c.state;if(!st)return false;if(Array.isArray(st))return st.length>0;return typeof st==="object"?Object.keys(st).length>0:!!st;};
  T.coinValue = function(c){return PandaFunding.value(c);};
  /* `sendable:true checkmempool:true` is what `send` itself uses — without it we can pick a coin
     already spent by an unconfirmed transaction. Filtering by tokenid server-side also keeps the
     reply small, which matters because an over-cap MDS reply comes back empty rather than erroring
     and would read here as "insufficient funds". */
  T.coinQuery = function(tok){return PandaFunding.query(tok,"");};
  T.findCoins = function(cmd,payTok,needed,exclude,maxCoins,done){PandaFunding.select(cmd,payTok,needed,exclude,maxCoins||8,done);};
  /* ---- composite (order book + PandaPools reserves in one transaction) ----
     `trackall:false` is load-bearing and was WRONG here before: with trackall:true every coin at
     a pool address reads as wallet-relevant, so every stranger's liquidity looked like the user's
     own. Native lists that exact bug ("trackall:true ownership pollution") as a fixed critical
     issue, and DexTxnCompositeLayoutTest asserts the false. */
  T.ensurePools = function(cmd,allocs,idx,done){var p,script;if(idx>=(allocs||[]).length)return done(null);p=allocs[idx].pool;script=p.covenantScript||PandaPool.script(p.opk,p.oadr,p.tok,p.kmin);cmd("newscript trackall:false script:"+PandaPool.scriptArg(script),function(r){if(!r||!r.status)return done("Could not register the pool covenant"+((r&&r.error)?": "+r.error:"")); T.ensurePools(cmd,allocs,idx+1,done);});};
  T.prepareComposite = function(plan,takerBuys){var prep={route:plan.poolRoute,payTok:takerBuys?P.USDT:"0x00",needed:P.d(0),payments:[],partial:null,partialRem:null,partialNewWant:null},i,t,o,lockedTake,pay;for(i=0;i<(plan.orderTakes||[]).length;i++){t=plan.orderTakes[i];o=t.order;lockedTake=!t.partial?P.d(o.locked):(o.sell?P.d(t.minima):P.up(P.d(t.minima).mul(o.price),P.DP));pay=t.partial?P.up(P.d(o.wantAmt).mul(lockedTake).div(o.locked),P.DP):P.d(o.wantAmt);prep.payments.push([P.plain(pay),o.wantAddr,o.wantTok]);prep.needed=prep.needed.add(pay);if(t.partial){prep.partial=t;prep.partialRem=P.d(o.locked).sub(lockedTake);prep.partialNewWant=P.up(P.d(o.wantAmt).mul(prep.partialRem).div(o.locked),P.DP);if(prep.partialNewWant.gt(o.wantAmt))prep.partialNewWant=P.d(o.wantAmt);}}if(prep.route&&prep.route.ok)prep.needed=prep.needed.add(prep.route.totalIn);return prep;};
  T.fillComposite = function(cmd,identity,plan,takerBuys,done){var prep,exclude={},i,a;if(!plan||PandaComposite.isEmpty(plan))return done("Nothing to fill");prep=T.prepareComposite(plan,!!takerBuys);exclude[String(P.ADDR).toLowerCase()]=true;exclude[String(P.ADDR_V5).toLowerCase()]=true;if(prep.route){for(i=0;i<(prep.route.pairAddresses||[]).length;i++)exclude[String(prep.route.pairAddresses[i]||"").toLowerCase()]=true;for(i=0;i<(prep.route.allocs||[]).length;i++){a=prep.route.allocs[i];exclude[String(a.pool.address||"").toLowerCase()]=true;exclude[String(a.pool.oadr||"").toLowerCase()]=true;}}T.progress("Selecting funding coins…");T.findCoins(cmd,prep.payTok,prep.needed,exclude,8,function(err,coins,sum){if(err)return done(err);T.progress("Registering pool scripts…");T.ensurePools(cmd,prep.route&&prep.route.ok?prep.route.allocs:[],0,function(perr){if(perr)return done(perr);T.buildComposite(cmd,identity,plan,prep,!!takerBuys,coins,sum,done);});});};
  /* Pure so the covenant's index rules are directly testable: pool reserve PAIRS first (even leg
     MINIMA, odd leg token), then whole order coins, then funding; outputs recreate each pool, then
     index-matched order payments, then the single partial remainder, then proceeds, then change. */
  T.buildCompositeSteps = function(id,identity,plan,prep,takerBuys,coins,fundTotal){var s=["txncreate id:"+id],route=prep.route,i,a,o,p,partial,proceedsTok,proceeds,change,nw;if(route&&route.ok){for(i=0;i<route.allocs.length;i++){a=route.allocs[i];s.push("txninput id:"+id+" coinid:"+a.pool.coinidM,"txninput id:"+id+" coinid:"+a.pool.coinidT);}}for(i=0;i<(plan.orderTakes||[]).length;i++)s.push("txninput id:"+id+" coinid:"+plan.orderTakes[i].order.coinid);for(i=0;i<coins.length;i++)s.push("txninput id:"+id+" coinid:"+coins[i].coinid);if(route&&route.ok){for(i=0;i<route.allocs.length;i++){a=route.allocs[i];s.push("txnoutput id:"+id+" amount:"+P.plain(a.quote.newX)+" address:"+a.pool.address+" storestate:false","txnoutput id:"+id+" amount:"+P.plain(a.quote.newY)+" address:"+a.pool.address+" tokenid:"+a.pool.tok+" storestate:false");}}for(i=0;i<prep.payments.length;i++){p=prep.payments[i];s.push("txnoutput id:"+id+" amount:"+p[0]+" address:"+p[1]+(P.eqTok(p[2],"0x00")?"":" tokenid:"+p[2])+" storestate:false");}partial=prep.partial;if(partial){o=partial.order;s.push("txnoutput id:"+id+" amount:"+P.plain(prep.partialRem)+" address:"+o.addr+(P.eqTok(o.lockedTok,"0x00")?"":" tokenid:"+o.lockedTok)+" storestate:true");}proceedsTok=takerBuys?"0x00":P.USDT;proceeds=takerBuys?P.d(plan.totalMinima):P.d(plan.totalUsdt);s.push("txnoutput id:"+id+" amount:"+P.plain(proceeds)+" address:"+identity.address+(P.eqTok(proceedsTok,"0x00")?"":" tokenid:"+proceedsTok)+" storestate:false");change=P.d(fundTotal).sub(prep.needed);if(change.gt(0))s.push("txnoutput id:"+id+" amount:"+P.plain(change)+" address:"+identity.address+(P.eqTok(prep.payTok,"0x00")?"":" tokenid:"+prep.payTok)+" storestate:false");if(partial){o=partial.order;nw=prep.partialNewWant;s.push("txnstate id:"+id+" port:0 value:"+o.ownerPk,"txnstate id:"+id+" port:1 value:"+o.wantAddr,"txnstate id:"+id+" port:2 value:"+P.plain(nw),"txnstate id:"+id+" port:3 value:"+o.wantTok,"txnstate id:"+id+" port:4 value:"+o.orderId,"txnstate id:"+id+" port:5 value:"+(o.sell?"1":"0"),"txnstate id:"+id+" port:6 value:"+P.plain(P.portPrice(nw,prep.partialRem)),"txnstate id:"+id+" port:7 value:"+(o.gtc?"1":"0"),"txnstate id:"+id+" port:8 value:"+P.plain(o.minRem));}return s;};
  T.buildComposite = function(cmd,identity,plan,prep,takerBuys,coins,fundTotal,done){var id=T.id("combo");T.checkPost(cmd,id,T.buildCompositeSteps(id,identity,plan,prep,takerBuys,coins,fundTotal),done);};
  /* Direct port of Android DexTxn.createOrder: port 8 is denominated in the LOCKED asset,
     so a buy converts the user's MINIMA remainder through its own limit price. */
  /* What an order actually LOCKS: MINIMA for a sell, MxUSD for a buy (native DexTxn.orderLockedAmount).
     Unlike the want side, this does not change when the order is repriced. */
  T.lockedAmount = function(buy,minima,price){return buy?P.up(P.d(minima).mul(P.d(price)),P.DP):P.down(P.d(minima),P.DP);};
  T.create = function(cmd,identity,input,done){var minima=P.down(input.minima,P.DP),price=P.d(input.price),usdt=P.up(minima.mul(price),P.DP),buy=!!input.buy,lock=buy?usdt:minima,want=buy?minima:usdt,minimaRem=P.down(input.minRem||0,P.DP),minRem=buy?P.up(minimaRem.mul(price),P.DP):minimaRem;if(minima.lt(P.MIN_ORDER)||lock.gt(P.MAX_ORDER)||want.gt(P.MAX_ORDER))return done("Order size is outside the permitted range");if(minRem.gt(lock))return done("Minimum remainder is larger than the order itself");/* `send` signs internally, so it needs the gate exactly as much as a txnsign chain does —
     this is the case SignGate.java's javadoc singles out. The `random` call below is read-only
     and deliberately stays outside it. */
  function sendOrder(oid){var state={"0":identity.publickey,"1":identity.address,"2":P.plain(want),"3":buy?"0x00":P.USDT,"4":oid,"5":buy?"0":"1","6":P.plain(price),"7":input.gtc===false?"0":"1","8":P.plain(minRem)};T.progress("Waiting for the signing lock…");PandaSignLock.gate("send",function(release){T.progress("Signing and sending the order…");cmd("send amount:"+P.plain(lock)+" address:"+P.ADDR+(buy?" tokenid:"+P.USDT:"")+" state:"+JSON.stringify(state),function(r){release.free();done((!r||(!r.status&&!r.pending))&&(T.signError(r&&r.error)||(r&&r.error)||"Order was not accepted"),r&&r.response&&r.response.txpowid,oid);});},function(blocked){done(blocked);});}if(input.orderId)return sendOrder(input.orderId);cmd("random",function(rand){var oid=rand&&rand.status&&rand.response&&rand.response.random;if(!oid)return done("Could not create a safe order id");sendOrder(oid);});};
  T.fill = function(cmd,identity,plan,done){
    if(!plan||!plan.takes||!plan.takes.length)return done("Nothing to fill");
    var buy=plan.takes[0].order.sell,payTok=buy?P.USDT:"0x00",needed=P.d(0),i,t,o,partial=null,proceeds=P.d(0),steps=[],id=T.id("sweep"),exclude={};
    exclude[String(P.ADDR).toLowerCase()]=true;exclude[String(P.ADDR_V5).toLowerCase()]=true;
    for(i=0;i<plan.takes.length;i++){t=plan.takes[i];needed=needed.add(t.pay);proceeds=proceeds.add(t.lockedTake);if(t.partial)partial=t;}
    /* Native funding selection counts and bounds reply slices before listing; postGated also
       caps and claims all transaction inputs before signing. */
    T.findCoins(cmd,payTok,needed,exclude,T.MAX_FUNDING_INPUTS,function(err,chosen,sum){
      if(err)return done(err==="Insufficient confirmed funds for trade"?"Insufficient confirmed funds for this sweep":err);
      steps.push("txncreate id:"+id);for(i=0;i<plan.takes.length;i++)steps.push("txninput id:"+id+" coinid:"+plan.takes[i].order.coinid);for(i=0;i<chosen.length;i++)steps.push("txninput id:"+id+" coinid:"+chosen[i].coinid);
      for(i=0;i<plan.takes.length;i++){t=plan.takes[i];o=t.order;steps.push("txnoutput id:"+id+" amount:"+P.plain(t.pay)+" address:"+o.wantAddr+(P.eqTok(o.wantTok,"0x00")?"":" tokenid:"+o.wantTok)+" storestate:false");}
      if(partial){o=partial.order;steps.push("txnoutput id:"+id+" amount:"+P.plain(partial.remainder)+" address:"+o.addr+(P.eqTok(o.lockedTok,"0x00")?"":" tokenid:"+o.lockedTok)+" storestate:true");}
      steps.push("txnoutput id:"+id+" amount:"+P.plain(proceeds)+" address:"+identity.address+(buy?"":" tokenid:"+P.USDT)+" storestate:false");var change=sum.sub(needed);if(change.gt(0))steps.push("txnoutput id:"+id+" amount:"+P.plain(change)+" address:"+identity.address+(P.eqTok(payTok,"0x00")?"":" tokenid:"+payTok)+" storestate:false");
      if(partial){o=partial.order;var nw=P.up(o.wantAmt.mul(partial.remainder).div(o.locked),P.DP);steps.push("txnstate id:"+id+" port:0 value:"+o.ownerPk,"txnstate id:"+id+" port:1 value:"+o.wantAddr,"txnstate id:"+id+" port:2 value:"+P.plain(nw),"txnstate id:"+id+" port:3 value:"+o.wantTok,"txnstate id:"+id+" port:4 value:"+o.orderId,"txnstate id:"+id+" port:5 value:"+(o.sell?"1":"0"),"txnstate id:"+id+" port:6 value:"+P.plain(P.portPrice(nw,partial.remainder)),"txnstate id:"+id+" port:7 value:"+(o.gtc?"1":"0"),"txnstate id:"+id+" port:8 value:"+P.plain(o.minRem));}
      T.checkPost(cmd,id,steps,done);
    });
  };
})(PandaTxn,PandaDEX);
