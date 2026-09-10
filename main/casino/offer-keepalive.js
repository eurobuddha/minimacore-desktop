/* Canonical phase-0 keepalive. ES5 for Rhino; identical browser/service/desktop copy.
 * Renew the existing collateral in ONE owner-signed transaction, without revealing its secret.
 * RENEW_AT matches Limit GTC's 500-block safety window; txns reuse the casino reveal sequence. */
var CasinoOffers = (function () {
  var RENEW_AT = 500, serial = 0;
  var ADDRESS = '0xD65ADBBB7AB5032D794B02CF5E8814C720BE3C9562CC6C07081DE41CCA665A6F';
  var USD = '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90';
  function state(c,p) { return CasinoTimeouts.state(c,p); }
  function token(c) { return c.tokenid || '0x00'; }
  function amount(c) { return String(c.tokenamount != null && c.tokenamount !== '' ? c.tokenamount : c.amount); }
  function hex(v) { return typeof v === 'string' && /^0x(?:[a-fA-F0-9]{2})+$/.test(v); }
  function decimal(v) { return /^[0-9]+(?:\.[0-9]+)?$/.test(v); }
  function tidy(v) { return String(v).replace(/^0+(?=\d)/,'').replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''); }
  function valid(c) {
    if (!c.state || c.state.length !== 8 || Number(state(c,6)) !== 0 || !hex(c.coinid) || !hex(token(c))) return false;
    if (token(c) !== '0x00' && token(c).toUpperCase() !== USD.toUpperCase()) return false;
    for (var p=0;p<=2;p++) if (!hex(state(c,p))) return false;
    var ports=[3,4,6,7];
    for (var i=0;i<ports.length;i++) if (!/^[0-9]+$/.test(state(c,ports[i]))) return false;
    var range=Number(state(c,3));
    return (range===2 || range===6 || range===36) && Number(state(c,4))===range &&
      decimal(state(c,5)) && /[1-9]/.test(state(c,5)) && decimal(amount(c)) && /[1-9]/.test(amount(c));
  }
  function due(c) { return valid(c) && CasinoTimeouts.age(c)>=RENEW_AT; }
  function cancelKey(c) { return 'casino_cancel_for_'+state(c,2); }
  // Verified durable marker, reused by both manual Cancel and background maintenance.
  function requestCancel(mds,c,done) {
    mds.keypair.set(cancelKey(c),'1',function(r){
      if (!r || !r.status) return done('Could not save cancellation intent');
      mds.keypair.get(cancelKey(c),function(saved){done(saved && saved.value==='1' ? null : 'Could not verify cancellation intent');});
    });
  }
  function maintain(mds,c,owns,payAddress,done) {
    if (!valid(c) || !owns(state(c,0))) return done('Invalid or foreign open offer');
    var finished=false, id='svc_offer_'+Date.now()+'_'+(++serial), cancelled=false;
    function finish(err) {
      if (finished) return; finished=true;
      mds.cmd('txndelete id:'+id,function(){});
      done(err,{cancelled:cancelled});
    }
    mds.cmd('checkmode',function(mode){
      if (!mode || !mode.status || !mode.response || mode.response.mode!=='WRITE') return done('Offer keepalive requires WRITE mode');
      mds.keypair.get(cancelKey(c),function(flag){
        cancelled=!!(flag && flag.value==='1');
        if (!cancelled && !due(c)) return done(null);
        if (cancelled) {
          return mds.keypair.get('casino_hexaddr',function(wallet){
            payAddress=payAddress || (wallet && wallet.value);
            if (!hex(payAddress)) return done('Wallet address unavailable');
            build();
          });
        }
        mds.keypair.get('casino_secret_for_'+state(c,2),function(secret){
          if (!secret || !secret.value) return done('Offer keepalive blocked: house secret missing');
          // Use the node's exact MiniNumber math, not JS floating point (Rhino has no BigInt).
          mds.cmd('maths calculate:'+state(c,5)+'*'+(Number(state(c,4))-1),function(r){
            if (!r || !r.status || !r.response || tidy(r.response.result)!==tidy(amount(c))) return done('Invalid offer collateral: keepalive skipped');
            build();
          });
        });
      });
    });
    function build() {
      var commands=['txncreate id:'+id,'txninput id:'+id+' coinid:'+c.coinid,
        'txnoutput id:'+id+' amount:'+amount(c)+' address:'+(cancelled?payAddress:ADDRESS)+' tokenid:'+token(c)+' storestate:'+(!cancelled)];
      if (!cancelled) for (var p=0;p<=7;p++) commands.push('txnstate id:'+id+' port:'+p+' value:'+state(c,p));
      commands.push('txnsign id:'+id+' publickey:'+state(c,0),'txnbasics id:'+id);
      function step(i) {
        if (finished) return;
        if (i<commands.length) return mds.cmd(commands[i],function(r){if (!r || !r.status) return finish('Offer maintenance failed: '+commands[i].split(' ')[0]);step(i+1);});
        mds.keypair.get(cancelKey(c),function(flag){
          if (!cancelled && flag && flag.value==='1') return finish('Renewal stopped: cancellation requested');
          mds.cmd('txnpost id:'+id,function(r){finish(r && r.status ? null : 'Offer maintenance post failed');});
        });
      }
      step(0);
    }
  }
  return {RENEW_AT:RENEW_AT,valid:valid,due:due,cancelKey:cancelKey,requestCancel:requestCancel,maintain:maintain};
}());
