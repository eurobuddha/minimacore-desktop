/* Guided existing-wallet rescue. Uses ReserveRecovery and PoolMgr's existing signing,
 * mempool, transaction-check and durable input-claim boundaries. Seed-only restores
 * are deliberately excluded: the user must attest preserved current signing state.
 * One close + one collection attempt per pool; unknown outcomes never re-sign. */
var PoolRescue = (function () {
    var busy=false;
    function id(v){return typeof v==='string'&&/^0x[0-9a-fA-F]{64}$/.test(v)&&!/^0x0{64}$/.test(v);}
    function esc(v){return String(v).replace(/'/g,"''");}
    function command(q,cb){var ended=false,t=setTimeout(function(){done(null);},120000);function done(r){if(ended)return;ended=true;clearTimeout(t);cb(r&&r.status===true&&!r.pending?r:null);}try{MDS.cmd(q,done);}catch(e){done(null);}}
    function table(cb){MDS.sql('CREATE TABLE IF NOT EXISTS pp_rescue (address varchar(80) PRIMARY KEY,payload text)',function(r){if(!r||r.status!==true){cb(false);return;}MDS.sql('CREATE TABLE IF NOT EXISTS pp_rescue_attempts (attempt varchar(100) PRIMARY KEY)',function(x){cb(!!x&&x.status===true);});});}
    function durable(cb){if(MDS.persistRecovery)MDS.persistRecovery(cb);else cb(true);}
    function read(address,cb){MDS.sql("SELECT payload FROM pp_rescue WHERE address='"+address.toLowerCase()+"'",function(r){
        if(!r||r.status!==true||!Array.isArray(r.rows)){cb(null,false);return;}
        if(!r.rows.length){cb(null,true);return;}
        try{var raw=r.rows[0].PAYLOAD;var j=JSON.parse(raw);
            if(!j||!id(j.address)||j.address.toLowerCase()!==address.toLowerCase()||!id(j.opk)||!id(j.oadr)||!id(j.tok)
                    ||['CLOSE_STARTED','CLOSE_POSTED','FORWARD_STARTED','FORWARD_POSTED','DONE'].indexOf(j.state)<0
                    || !ReserveRecovery.integer(j.offset,2147483640))throw Error('Invalid journal');
            for(var k of ['close','forward','closeMined','forwardMined'])if(j[k]!==''&&!id(j[k]))throw Error('Invalid receipt');
            j._raw=raw;
        }catch(e){cb(null,false);return;}cb(j,true);
    });}
    function save(j,cb){
        var before=j._raw,out={};Object.keys(j).forEach(function(k){if(k!=='_raw')out[k]=j[k];});var raw=JSON.stringify(out);
        MDS.sql("UPDATE pp_rescue SET payload='"+esc(raw)+"' WHERE address='"+j.address.toLowerCase()+"' AND payload='"+esc(before)+"'",function(r){
            if(!r||r.status!==true){cb(false);return;}durable(function(ok){if(!ok){cb(false);return;}read(j.address,function(now,ok){if(ok&&now&&now._raw===raw){j._raw=raw;cb(true);}else cb(false);});});
        });
    }
    function claim(p,cb){
        var j={address:p.address,opk:p.opk,oadr:p.oadr,tok:p.tok,state:'CLOSE_STARTED',close:'',forward:'',closeMined:'',forwardMined:'',offset:0};
        var raw=JSON.stringify(j);j._raw=raw;
        MDS.sql("INSERT INTO pp_rescue (address,payload) VALUES ('"+p.address.toLowerCase()+"','"+esc(raw)+"')",function(r){
            if(!r||r.status!==true){cb(null);return;}durable(function(ok){cb(ok?j:null);});
        });
    }
    function draft(j,stage,handle,post,fail){
        command('txnlist id:'+handle+' transactiononly:true',function(r){
            var row=r&&r.response,tid=row&&row.transaction&&row.transaction.transactionid;
            if(!row||row.id!==handle||!id(tid)){fail('Could not record the recovery transaction identity; nothing posted.');return;}
            j[stage]=tid.toLowerCase();save(j,function(ok){if(ok)post();else fail('Could not save recovery evidence; nothing posted.');});
        });
    }
    function confirmed(r){
        var v=r&&r.response;
        if(!r||r.status!==true||r.pending||!v||v.found!==true||!id(v.blockid))return false;
        for(var k of ['block','tip','confirmations'])if(typeof v[k]!=='string'||!/^\d{1,15}$/.test(v[k]))return false;
        return Number(v.block)>0&&Number(v.confirmations)>=3&&Number(v.tip)-Number(v.block)===Number(v.confirmations);
    }
    function discover(j,cb){
        command('history relevant:true max:8 offset:'+(j.offset||0),function(r){
            var rows=r&&r.response&&r.response.txpows;if(!Array.isArray(rows)||rows.length>8){cb(false);return;}
            rows.forEach(function(tx){var tid=tx&&tx.body&&tx.body.txn&&tx.body.txn.transactionid;if(!tx||tx.istransaction!==true||!id(tx.txpowid)||!id(tid))return;
                if(j.close&&tid.toLowerCase()===j.close)j.closeMined=tx.txpowid;
                if(j.forward&&tid.toLowerCase()===j.forward)j.forwardMined=tx.txpowid;
            });
            j.offset=rows.length<8?0:Math.min(2147483640,(j.offset||0)+rows.length);save(j,cb);
        });
    }
    function verify(j,stage,cb){if(!id(j[stage])||!id(j[stage+'Mined'])){cb(false);return;}command('txpow onchain:'+j[stage+'Mined'],function(r){cb(confirmed(r));});}
    function balance(address,cb){command('balance address:'+address,function(r){var rows=r&&r.response,total=0;if(!Array.isArray(rows)){cb(null);return;}
        for(var i=0;i<rows.length;i++){var n=rows[i]&&rows[i].coins;if(!ReserveRecovery.integer(n,2147483647)){cb(null);return;}total+=Number(n);if(total>2147483647){cb(null);return;}}cb(total);
    });}
    function resume(p,j,cb){
        if(j.address.toLowerCase()!==p.address.toLowerCase()||j.opk.toLowerCase()!==p.opk.toLowerCase()||j.oadr.toLowerCase()!==p.oadr.toLowerCase()){cb('RECOVERY_IDENTITY_CHANGED: stop and check the original wallet.');return;}
        if(!id(j.close)){cb("Withdrawal attempt interrupted before a durable transaction ID was recorded. Review Activity and node pending transactions; no automatic retry.");return;}
        discover(j,function(ok){if(!ok){cb('Could not read/save recovery evidence. No signature retried.');return;}
            verify(j,'close',function(closed){if(!closed){cb('Waiting for verified withdrawal confirmation. Keep this recovery screen open. An uncertain attempt is never signed again.');return;}
                if(j.forward){verify(j,'forward',function(forwarded){if(!forwarded){cb('Collection submitted or uncertain; waiting for verified confirmation.');return;}balance(j.oadr,function(n){if(n!==0){cb('Collection confirmed, but payout coins remain or could not be read. Review this payout address; no second automatic signature.');return;}j.state='DONE';save(j,function(saved){cb(saved?'Recovery complete: withdrawal and collection confirmed; payout address empty.':'Collection confirmed, but completion could not be saved.');});});});return;}
                if(j.state!=='CLOSE_POSTED'&&j.state!=='CLOSE_STARTED'){cb('A collection was already attempted. Review Activity; it will not be signed again.');return;}
                balance(j.oadr,function(n){if(n===null||n<2){cb('Waiting for both payout reserves to become available.');return;}
                    PoolMgr.forwardOwnerFunds(j.oadr,{
                            beforePost:function(handle,post,fail){draft(j,'forward',handle,post,fail);},
                            recoveryExpected:n, recovery:{pool:p,stage:"forward"},
                            beforeBuild:function(go,fail){
                                MDS.sql("INSERT INTO pp_rescue_attempts (attempt) VALUES ('"+j.address.toLowerCase()+":forward')",function(r){
                                    if(!r||r.status!==true){fail('Collection already claimed or storage unavailable.');return;}
                                    j.state='FORWARD_STARTED';save(j,function(saved){if(saved)go();else fail('Could not save collection state.');});
                                });
                            },
                            forwarded:function(txid){j.state='FORWARD_POSTED';save(j,function(){cb('Collection submitted. Waiting for confirmation.');});},
                            nothing:function(){cb('Waiting for all payout coins to become spendable.');},
                            fail:function(m){cb('Collection stopped: '+m+' No automatic signature retry.');}
                        });
                });
            });
        });
    }
    function run(json,attested,progress,cb){
        if(!attested){cb('Confirm the original wallet and current signing state first.');return;}
        if(busy){cb('Recovery is already running.');return;}
        var backup;try{backup=JSON.parse(json);}catch(e){cb('Invalid pool backup.');return;}
        if(!backup||!Array.isArray(backup.pools)||!backup.pools.length||backup.pools.length>8||!backup.pools.every(ReserveRecovery.validRecipe)){cb('Use a valid backup with 1–8 pools per recovery run.');return;}
        busy=true;var at=0,reports=[];
        function finish(m){reports.push(m);if(progress)progress(m);next();}
        function next(){if(at>=backup.pools.length){busy=false;cb(reports.join('\n\n'));return;}
            var e=backup.pools[at++];Store.ownAll(function(ps,ok){var p=ps.filter(function(p){return p.address.toLowerCase()===e.addr.toLowerCase();})[0];
                if(!ok||!p){finish(e.addr+'\nRestore and verify this pool backup first.');return;}
                read(p.address,function(j,ok){if(!ok){finish(p.address+'\nRecovery journal unreadable. No signatures sent.');return;}
                    if(j){resume(p,j,function(m){finish(p.address+'\n'+m);});return;}
                    ReserveRecovery.readReserves(p,function(funded){if(!funded){finish(p.address+'\nReserves missing. Follow the archive/resync instructions before withdrawal.');return;}
                        PoolMgr.readKeyUses(p.opk,function(uses,index,capacity){
                            if(!ReserveRecovery.integer(uses,268435455)||uses>=capacity||p.minimumOwnerUses<0||uses<p.minimumOwnerUses){finish(p.address+'\nOwner key or current signing counter is missing, exhausted or below the backup. Restore the latest complete matching wallet backup.');return;}
                                claim(p,function(j){if(!j){finish(p.address+'\nRecovery already claimed or storage unavailable. Nothing signed.');return;}
                                    PoolMgr.close(p,{noRetry:true,recovery:{pool:p,stage:"close"},beforePost:function(handle,post,fail){draft(j,'close',handle,post,fail);},
                                        ok:function(txid){j.state='CLOSE_POSTED';save(j,function(){finish(p.address+'\nWithdrawal submitted. Keep this recovery screen open for confirmation and collection.');});},
                                        fail:function(m){finish(p.address+'\nWithdrawal stopped: '+m+' No automatic signature retry.');}
                                    });
                                });
                        });
                    });
                });
            });
        }
        PoolRuntimeGuard.check(function(error){if(error){busy=false;cb(error);return;}table(function(ok){if(!ok){busy=false;cb('Recovery storage unavailable.');return;}next();});});
    }
    // Do not re-import already-withdrawn recipes when reopening a pending recovery.
    // Their empty reserves are expected; the durable journal, not a resync, is the next step.
    function prepare(json,cb){
        var backup;try{backup=JSON.parse(json);}catch(e){cb(null,"Invalid pool backup.");return;}
        if(!backup||!Array.isArray(backup.pools)||!backup.pools.length||backup.pools.length>8||!backup.pools.every(ReserveRecovery.validRecipe)){cb(null,"Use a valid backup with 1–8 pools per recovery run.");return;}
        table(function(ok){if(!ok){cb(null,"Recovery storage unavailable.");return;}var i=0,needed=[];
            function next(){if(i===backup.pools.length){cb(needed.length?JSON.stringify({pandapools_backup:backup.pandapools_backup,pools:needed}):null,null);return;}
                var e=backup.pools[i++];read(e.addr,function(j,ok){if(!ok){cb(null,"Recovery journal unreadable. Stop and preserve your backup.");return;}if(!j)needed.push(e);next();});
            }next();
        });
    }
    return {run:run,prepare:prepare,confirmed:confirmed};
})();
