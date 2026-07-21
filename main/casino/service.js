/**
 * Zero Edge Casino — Background Service
 * Runs persistently in MiniHub. Handles auto-reveal and auto-resolve
 * so users can close the casino tab after placing/taking a bet.
 *
 * Secrets are shared via MDS.keypair (same MiniDapp UID as index.html).
 * Only processes in WRITE mode to avoid pending action spam.
 */

var SCRIPT='LET hpk=PREVSTATE(0) LET ha=PREVSTATE(1) LET hc=PREVSTATE(2) LET rng=PREVSTATE(3) LET po=PREVSTATE(4) LET bt=PREVSTATE(5) LET ph=PREVSTATE(6) LET to=PREVSTATE(7) IF ph EQ 0 AND SIGNEDBY(hpk) THEN RETURN TRUE ENDIF IF ph EQ 0 THEN ASSERT SAMESTATE(0 5) ASSERT STATE(6) EQ 1 ASSERT STATE(7) EQ to ASSERT STATE(11) GTE 0 AND STATE(11) LT rng ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT+bt @TOKENID TRUE) RETURN TRUE ENDIF LET qk=PREVSTATE(8) LET pk=PREVSTATE(11) IF ph EQ 1 AND SIGNEDBY(hpk) THEN ASSERT SAMESTATE(0 5) ASSERT STATE(6) EQ 2 ASSERT SAMESTATE(7 11) LET hs=STATE(12) ASSERT SHA3(hs) EQ hc ASSERT VERIFYOUT(@INPUT @ADDRESS @AMOUNT @TOKENID TRUE) RETURN TRUE ENDIF IF ph EQ 1 AND @COINAGE GT to AND SIGNEDBY(qk) THEN RETURN TRUE ENDIF IF ph EQ 2 AND SIGNEDBY(qk) THEN LET ps=STATE(13) ASSERT SHA3(ps) EQ PREVSTATE(10) LET hs=PREVSTATE(12) LET h=SHA3(CONCAT(hs ps)) LET r=NUMBER(SUBSET(0 4 h))%rng IF r EQ pk THEN LET w=bt*po ASSERT VERIFYOUT(@INPUT PREVSTATE(9) w @TOKENID FALSE) IF @AMOUNT GT w THEN ASSERT VERIFYOUT(@INPUT+1 ha @AMOUNT-w @TOKENID FALSE) ENDIF ELSE ASSERT VERIFYOUT(@INPUT ha @AMOUNT @TOKENID FALSE) ENDIF RETURN TRUE ENDIF IF ph EQ 2 AND @COINAGE GT to AND SIGNEDBY(hpk) THEN RETURN TRUE ENDIF RETURN FALSE';

var SCRIPT_ADDR='0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F';
var MY_KEYS={};
var BUSY={};
var POSTED={},REPOST_AFTER=8;
var WRITE_MODE=false;
var SCRIPT_OK=false;   // covenant script registered + VERIFIED on this node (else reveals/resolves are rejected)

// ===== Helpers (duplicated from index.html — small, no MDS.load needed) =====
function getState(coin,port){
  if(!coin.state)return'';
  for(var i=0;i<coin.state.length;i++){if(coin.state[i].port===port||coin.state[i].port==port)return coin.state[i].data}
  return'';
}
function isMyKey(pk){return MY_KEYS[pk]===true}
function extractResponse(res){
  if(!res||!res.response)return null;
  var r=res.response;
  if(typeof r==='string')return r;
  if(r.random)return r.random;if(r.hash)return r.hash;if(r.output)return r.output;if(r.value)return r.value;
  return null;
}
function miniNum(v){return parseFloat(parseFloat(v).toFixed(8))}
function setStates(txid,states,idx,callback){
  if(idx>=states.length){callback();return}
  MDS.cmd("txnstate id:"+txid+" port:"+states[idx][0]+" value:"+states[idx][1],function(){setStates(txid,states,idx+1,callback)});
}
function gameTypeName(range){if(range==2)return'Coin Flip';if(range==6)return'Dice';if(range==36)return'Roulette';return'Custom ('+range+')'}
function pickLbl(range,pick){if(range==2)return parseInt(pick)===0?'Heads':'Tails';return''+(parseInt(pick)+1)}
// Record the EXACT resolved result (player perspective) to the shared casino_history, so index.html
// shows the right outcome for a bet the service resolved while the tab was closed — no lossy guess.
function recordServiceResult(coinid,range,playerpick,result,playerWins,bet,payout,totalAmt){
  var profit=playerWins?miniNum(parseFloat(bet)*payout-parseFloat(bet)):parseFloat(bet);
  var entry={coinid:coinid,role:'Player',game:gameTypeName(range),range:range,pickLabel:pickLbl(range,playerpick),resultLabel:pickLbl(range,result),profit:profit,won:playerWins,bet:bet,amount:totalAmt,txid:coinid,time:Date.now()};
  MDS.keypair.get("casino_history",function(h){
    var hist=[];try{if(h&&h.value)hist=JSON.parse(h.value)}catch(e){}
    if(hist.some(function(rb){return rb.coinid===coinid}))return;
    hist.unshift(entry);if(hist.length>50)hist.pop();
    MDS.keypair.set("casino_history",JSON.stringify(hist));
  });
}

// RELIABILITY (root-cause fix): register the covenant script and VERIFY it took. The old code did a
// fire-and-forget `newscript` with no check; on some nodes it silently never registered, so every
// reveal/resolve built a transaction with NO script attached (txncheck scripts:0) → rejected by
// consensus → bets stuck forever, plus a pile of leaked half-built txns. We now confirm the returned
// address matches SCRIPT_ADDR and retry every block until confirmed.
function ensureScript(cb){
  if(SCRIPT_OK){if(cb)cb();return}
  MDS.cmd('newscript script:"'+SCRIPT+'" trackall:true',function(res){
    var addr=(res&&res.response)?(res.response.address||''):'';
    if(res&&res.status&&addr&&addr.toUpperCase()===SCRIPT_ADDR.toUpperCase()){
      SCRIPT_OK=true;
      MDS.log("Casino service: covenant script registered + verified");
    }else{
      MDS.log("Casino service: script registration not confirmed — retrying next block");
    }
    if(cb)cb();
  });
}
// Delete stale half-built svc_ txns left by earlier failed attempts (they otherwise accumulate in
// txnlist and bloat the node). Safe: a posted reveal/resolve lives in the mempool, not in this workspace.
function purgeStaleTxns(){
  MDS.cmd("txnlist",function(res){
    try{
      var arr=(res&&res.response)||[];
      for(var i=0;i<arr.length;i++){
        var tid=arr[i].txnid||arr[i].id||'';
        if(typeof tid==='string'&&(tid.indexOf('svc_reveal_')===0||tid.indexOf('svc_resolve_')===0))MDS.cmd("txndelete id:"+tid);
      }
    }catch(e){}
  });
}

// ===== Init =====
MDS.init(function(msg){

  if(msg.event==='inited'){
    // Check write mode — only auto-process if write
    MDS.cmd("checkmode",function(res){
      if(res.status&&res.response&&res.response.mode==="WRITE"){
        WRITE_MODE=true;
        MDS.log("Casino service: WRITE mode — auto-processing enabled");
      }else{
        MDS.log("Casino service: READ mode — auto-processing disabled");
      }
    });
    // Register the covenant script (verified + retried) — REQUIRED or reveals/resolves are rejected.
    ensureScript();
    // Clear any leaked half-built txns from prior failed attempts.
    purgeStaleTxns();
    // Load wallet keys
    MDS.cmd("keys",function(res){
      try{
        var list=res.response.keys||res.response;
        if(Array.isArray(list)){for(var i=0;i<list.length;i++){var pk=list[i].publickey||list[i];if(pk&&typeof pk==='string')MY_KEYS[pk]=true}}
      }catch(e){}
      MDS.log("Casino service: loaded "+Object.keys(MY_KEYS).length+" keys");
    });
  }

  if(msg.event==='NEWBLOCK'){
    // Ensure the covenant script is registered before processing; only process once confirmed.
    if(WRITE_MODE)ensureScript(function(){if(SCRIPT_OK)processCoins()});
  }
});

// ===== Process coins on each block =====
function processCoins(){
  // Stand down while the casino tab is open & active (its heartbeat is fresh) — otherwise the page
  // and this service would both post reveal/resolve for the same coin (competing txns / stalls).
  MDS.keypair.get("casino_tab_hb",function(hb){
    var ts=(hb&&hb.value)?parseInt(hb.value):0;
    if(Date.now()-ts<12000)return;
  MDS.cmd("coins address:"+SCRIPT_ADDR,function(res){
    if(!res.status||!res.response)return;
    // Prune cooldown/busy entries for coins that have advanced or been spent.
    var present={};res.response.forEach(function(c){present[c.coinid]=true});
    Object.keys(POSTED).forEach(function(id){if(!present[id])delete POSTED[id]});
    Object.keys(BUSY).forEach(function(id){if(!present[id])delete BUSY[id]});
    res.response.forEach(function(coin){
      var phase=getState(coin,6);
      var coinid=coin.coinid;
      var age=parseInt(coin.age)||0;
      if(BUSY[coinid])return;
      // Cooldown: txnpost mines async, so don't re-post the same transition every block while it
      // confirms (that races competing txns and stalls). Wait REPOST_AFTER blocks per coin.
      if(POSTED[coinid]!==undefined&&(age-POSTED[coinid])<REPOST_AFTER)return;

      // Phase 1 + I'm house → auto-reveal
      if(phase==='1'&&isMyKey(getState(coin,0))){
        BUSY[coinid]=true;POSTED[coinid]=age;
        doReveal(coin);
      }

      // Phase 2 + I'm player → auto-resolve
      if(phase==='2'&&isMyKey(getState(coin,8))){
        BUSY[coinid]=true;POSTED[coinid]=age;
        doResolve(coin);
      }
    });
  });
  });
}

// ===== Auto-Reveal (house: phase 1→2) =====
function doReveal(coin){
  var coinid=coin.coinid;
  var betCommit=getState(coin,2);
  MDS.keypair.get("casino_secret_for_"+betCommit,function(sres){
    if(!sres||!sres.value){delete BUSY[coinid];return}
    var housesecret=sres.value;
    var txid="svc_reveal_"+Date.now();
    MDS.cmd("txncreate id:"+txid,function(r0){
      if(!r0.status){delete BUSY[coinid];return}
      MDS.cmd("txninput id:"+txid+" coinid:"+coinid,function(r1){
        if(!r1.status){MDS.cmd("txndelete id:"+txid);delete BUSY[coinid];return}
        MDS.cmd("txnoutput id:"+txid+" amount:"+coin.amount+" address:"+SCRIPT_ADDR+" storestate:true",function(r2){
          if(!r2.status){MDS.cmd("txndelete id:"+txid);delete BUSY[coinid];return}
          var states=[
            [0,getState(coin,0)],[1,getState(coin,1)],[2,getState(coin,2)],
            [3,getState(coin,3)],[4,getState(coin,4)],[5,getState(coin,5)],
            [6,"2"],[7,getState(coin,7)],
            [8,getState(coin,8)],[9,getState(coin,9)],[10,getState(coin,10)],[11,getState(coin,11)],
            [12,housesecret]
          ];
          setStates(txid,states,0,function(){
            MDS.cmd("txnsign id:"+txid+" publickey:"+getState(coin,0),function(rs){
              if(!rs.status){MDS.cmd("txndelete id:"+txid);delete BUSY[coinid];return}
              MDS.cmd("txnbasics id:"+txid+";txnpost id:"+txid,function(resArr){
                var rp=Array.isArray(resArr)?resArr[resArr.length-1]:resArr;
                if(rp&&rp.status){
                  MDS.log("Casino service: revealed secret for "+coinid.substring(0,16)+"...");
                }else{
                  MDS.log("Casino service: reveal FAILED for "+coinid.substring(0,16)+"...");
                }
                MDS.cmd("txndelete id:"+txid);   // always clear the build workspace (avoids the txnlist leak)
                delete BUSY[coinid];
              });
            });
          });
        });
      });
    });
  });
}

// ===== Auto-Resolve (player: phase 2→payout) =====
function doResolve(coin){
  var coinid=coin.coinid;
  var playerCommit=getState(coin,10);
  MDS.keypair.get("casino_psecret_for_"+playerCommit,function(sres){
    if(!sres||!sres.value){delete BUSY[coinid];return}
    var playersecret=sres.value;
    var housesecret=getState(coin,12);
    var bet=getState(coin,5),payout=parseInt(getState(coin,4)),range=parseInt(getState(coin,3)),playerpick=parseInt(getState(coin,11));
    var winnings=miniNum(parseFloat(bet)*payout),totalAmt=parseFloat(coin.amount);
    var houseaddr=getState(coin,1),playeraddr=getState(coin,9);
    var combined=housesecret+playersecret.substring(2);

    MDS.cmd("hash data:"+combined,function(hres){
      var hash=extractResponse(hres);
      if(!hash){delete BUSY[coinid];return}
      var num=parseInt(hash.substring(2,10),16),result=num%range,playerWins=(result===playerpick);

      var txid="svc_resolve_"+Date.now();
      MDS.cmd("txncreate id:"+txid,function(r0){
        if(!r0.status){delete BUSY[coinid];return}
        MDS.cmd("txninput id:"+txid+" coinid:"+coinid,function(r1){
          if(!r1.status){MDS.cmd("txndelete id:"+txid);delete BUSY[coinid];return}

          // Build outputs based on winner
          var afterOutputs=function(){
            MDS.cmd("txnstate id:"+txid+" port:13 value:"+playersecret,function(){
              MDS.cmd("txnsign id:"+txid+" publickey:"+getState(coin,8),function(rs){
                if(!rs.status){MDS.cmd("txndelete id:"+txid);delete BUSY[coinid];return}
                MDS.cmd("txnbasics id:"+txid+";txnpost id:"+txid,function(resArr){
                  var rp=Array.isArray(resArr)?resArr[resArr.length-1]:resArr;
                  if(rp&&rp.status){
                    MDS.log("Casino service: resolved "+coinid.substring(0,16)+"... "+(playerWins?"PLAYER WINS":"HOUSE WINS"));
                    recordServiceResult(coinid,range,playerpick,result,playerWins,bet,payout,totalAmt);
                  }else{
                    MDS.log("Casino service: resolve FAILED for "+coinid.substring(0,16)+"...");
                  }
                  MDS.cmd("txndelete id:"+txid);   // always clear the build workspace (avoids the txnlist leak)
                  delete BUSY[coinid];
                });
              });
            });
          };

          if(playerWins){
            // Player wins: payout winnings to player, remainder to house
            MDS.cmd("txnoutput id:"+txid+" amount:"+winnings+" address:"+playeraddr+" storestate:false",function(r2){
              if(!r2.status){MDS.cmd("txndelete id:"+txid);delete BUSY[coinid];return}
              if(totalAmt>winnings){
                var remainder=miniNum(totalAmt-winnings);
                MDS.cmd("txnoutput id:"+txid+" amount:"+remainder+" address:"+houseaddr+" storestate:false",function(r3){
                  if(!r3.status){MDS.cmd("txndelete id:"+txid);delete BUSY[coinid];return}
                  afterOutputs();
                });
              }else{
                afterOutputs();
              }
            });
          }else{
            // House wins: all to house
            MDS.cmd("txnoutput id:"+txid+" amount:"+totalAmt+" address:"+houseaddr+" storestate:false",function(r2){
              if(!r2.status){MDS.cmd("txndelete id:"+txid);delete BUSY[coinid];return}
              afterOutputs();
            });
          }
        });
      });
    });
  });
}
