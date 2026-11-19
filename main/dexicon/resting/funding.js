/* Native FundingCoins + CoinLock port. Service-owned; no browser globals or detached host calls. */
var PandaCoinLock = {};
(function(L){
  var reserved={}, queued={}, ttl=180000;
  function key(id){return String(id||"").toLowerCase();}
  L.isReserved=function(id){var k=key(id);return !!queued[k] || (reserved[k]!==undefined && Date.now()-reserved[k]<ttl);};
  L.reserve=function(coins){coins.forEach(function(c){reserved[key(c.coinid)]=Date.now();});};
  L.release=function(coins){coins.forEach(function(c){delete reserved[key(c.coinid)];});};
  L.claimInputs=function(ids){var unique={},i,k;for(i=0;i<ids.length;i++){k=key(ids[i]);if(!PandaSafety.hex(ids[i])||unique[k]||queued[k])return false;unique[k]=true;}for(k in unique)if(unique.hasOwnProperty(k))queued[k]=true;return true;};
  L.finishInputs=function(ids){ids.forEach(function(id){var k=key(id);delete queued[k];reserved[k]=Date.now();});};
  L.prune=function(){var k;for(k in reserved)if(Date.now()-reserved[k]>=ttl)delete reserved[k];};
})(PandaCoinLock);
var PandaFunding = {};
(function(F,P,S,L){
  F.SAFE_COINS=8;F.MAX_INPUTS=20;
  F.rows=function(r){return r&&S.truthy(r.status)&&Array.isArray(r.response)?r.response:null;};
  F.count=function(reply,token){var rows=F.rows(reply),i,row,n;if(!rows)return -1;for(i=0;i<rows.length;i++){row=rows[i];if(!row||typeof row!=="object")return -1;if(P.eqTok(row.tokenid,token)){n=S.decimal(row.coins);return n&&n.gte(0)&&n.isInteger()&&n.lte(2147483647)?n.toNumber():-1;}}return 0;};
  /* Node-reported coin amounts carry stock MiniNumber precision, not the stricter order limit. */
  F.value=function(c){return S.balanceDecimal(c&&(P.eqTok(c.tokenid,"0x00")?c.amount:c.tokenamount));};
  F.query=function(token,address){return "coins relevant:true sendable:true checkmempool:true coinage:3 tokenid:"+token+(address?" address:"+address:"");};
  F.select=function(cmd,token,needed,exclude,maxInputs,done){
    var need=S.decimal(needed instanceof Decimal ? needed.toString() : needed), candidates=[], ids={}, slices=[], skipped=0,expected=0,finished=false,excluded={};
    maxInputs=Math.min(F.MAX_INPUTS,maxInputs);exclude=exclude||{};Object.keys(exclude).forEach(function(k){excluded[k.toLowerCase()]=true;});
    function fail(message){if(finished)return;finished=true;done(message+" Nothing was posted by this request.");}
    function call(command,cb){var called=false;cmd(command,function(r){if(called||finished)return;called=true;cb(r);});}
    function pick(){var sum=P.d(0),chosen=[],i;candidates.sort(function(a,b){return F.value(b).cmp(F.value(a));});for(i=0;i<candidates.length&&chosen.length<maxInputs;i++){if(L.isReserved(candidates[i].coinid))continue;chosen.push(candidates[i]);sum=sum.add(F.value(candidates[i]));if(sum.gte(need))return {coins:chosen,sum:sum};}return null;}
    function finish(){if(finished)return;L.prune();var chosen=pick();if(chosen){L.reserve(chosen.coins);finished=true;return done(null,chosen.coins,chosen.sum);}fail("Wallet has "+expected+" coins of this token. Could not select "+need.toFixed()+" from at most "+maxInputs+" available, stateless coins"+(skipped?" ("+skipped+" coins in large address groups were not scanned)":"")+". Wait for pending transactions, or consolidate this token in MinimaCore and retry.");}
    function fetch(address,next){call(F.query(token,address),function(r){var rows=F.rows(r),i,c,state,value,k;if(!rows)return fail("The node could not return wallet coins.");for(i=0;i<rows.length;i++){c=rows[i];if(!c||!S.hex(c.tokenid)||!S.hex(c.coinid)||!S.hex(c.address)||!P.eqTok(c.tokenid,token)||(address&&address.toLowerCase()!==c.address.toLowerCase()))return fail("Unexpected wallet coin reply.");state=c.state;if(state!==undefined&&state!==null&&(!Array.isArray(state)&&(typeof state!=="object")))return fail("Invalid coin state.");value=F.value(c);if(!value||!value.gt(0))return fail("Missing or invalid human coin amount.");if(S.truthy(c.spent)||excluded[c.address.toLowerCase()]||(state&&Object.keys(state).length))continue;k=c.coinid.toLowerCase();if(!ids[k]&&!L.isReserved(k)){ids[k]=true;candidates.push(c);}}next();});}
    function nextSlice(i){if(pick()||i>=slices.length)return finish();var address=slices[i].address;call("balance tokenid:"+token+" address:"+address,function(r){var count=F.count(r,token);if(count<0)return fail("Could not recheck wallet coins.");if(count>F.SAFE_COINS){skipped+=count;return nextSlice(i+1);}fetch(address,function(){nextSlice(i+1);});});}
    function nextKey(keys,i){if(i>=keys.length){slices.sort(function(a,b){return b.amount.cmp(a.amount);});return nextSlice(0);}call('runscript script:"RETURN SIGNEDBY('+keys[i]+')"',function(r){var response=r&&r.response,address=response&&response.script&&response.script.address;if(!S.truthy(r&&r.status)||!S.truthy(response&&response.parseok)||!S.hex(address))return fail("Could not derive a wallet address.");if(excluded[address.toLowerCase()])return nextKey(keys,i+1);call("balance tokenid:"+token+" address:"+address,function(b){var n=F.count(b,token),rows,j,amount;if(n<0)return fail("Could not count coins at a wallet address.");if(n>F.SAFE_COINS)skipped+=n;else if(n>0){rows=F.rows(b);for(j=0;j<rows.length;j++)if(P.eqTok(rows[j].tokenid,token)){amount=S.balanceDecimal(rows[j].sendable);if(!amount)return fail("Could not read the available balance.");if(amount.gt(0))slices.push({address:address,amount:amount});}}nextKey(keys,i+1);});});}
    function addresses(){call("keys",function(r){var raw=r&&r.response,keys=Array.isArray(raw)?raw:raw&&raw.keys,pks=[],seen={},i,pk;if(!S.truthy(r&&r.status)||!Array.isArray(keys))return fail("Could not read wallet addresses.");for(i=0;i<keys.length;i++){pk=keys[i]&&keys[i].publickey;if(!S.hex(pk))return fail("Invalid wallet key reply.");if(!seen[pk.toLowerCase()]){seen[pk.toLowerCase()]=true;pks.push(pk);}}nextKey(pks,0);});}
    if(!S.hex(token)||!need||need.lt(0)||!isFinite(maxInputs)||maxInputs<1||Math.floor(maxInputs)!==maxInputs)return fail("Invalid funding request.");
    if(need.eq(0)){finished=true;return done(null,[],P.d(0));}
    call("balance tokenid:"+token,function(r){expected=F.count(r,token);if(expected<0)return fail("Could not read the wallet coin count.");if(expected===0)return finish();if(expected<=F.SAFE_COINS)fetch("",finish);else addresses();});
  };
})(PandaFunding,PandaDEX,PandaSafety,PandaCoinLock);
