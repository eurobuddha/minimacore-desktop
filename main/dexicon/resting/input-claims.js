/* Durable posted-UTXO claims. Reuses the existing SQL primary-key reservation pattern.
 * Time never releases a submitted input. Confirmed transactions produce new IDs; uncertain posts stay held.
 */
var PoolInputClaims = (function(){
    var held={},owner={};   // owner: coin id -> the transaction handle whose post claimed it
    function valid(id){return typeof id==='string'&&/^0x[0-9a-fA-F]{64}$/.test(id);}
    function table(cb){MDS.sql('CREATE TABLE IF NOT EXISTS pp_posted_inputs (coinid varchar(160) primary key, handle varchar(160))',function(r){cb(!!r&&r.status===true);});}
    function blocked(ids){for(var i=0;i<ids.length;i++)if(held[ids[i].toLowerCase()])return true;return false;}
    function load(ids,cb){
        if(!ids.length||ids.some(function(id){return !valid(id);})){cb(false);return;}
        table(function(ok){if(!ok){cb(false);return;}
            var quoted=ids.map(function(id){return "'"+id.toLowerCase()+"'";}).join(',');
            MDS.sql('SELECT coinid,handle FROM pp_posted_inputs WHERE coinid IN ('+quoted+')',function(r){
                if(!r||r.status!==true||!Array.isArray(r.rows)){cb(false);return;}
                for(var i=0;i<r.rows.length;i++){var id=r.rows[i].COINID||r.rows[i].coinid;if(!valid(id)){cb(false);return;}
                    id=id.toLowerCase();held[id]=true;owner[id]=String(r.rows[i].HANDLE||r.rows[i].handle||'');}
                cb(!blocked(ids));
            });
        });
    }
    // Same checkmempool query as the proven funding selector, for covenant reserves too.
    function check(ids,cmd,cb){
        load(ids,function(ok){if(!ok)return cb(false);var at=0;
            function next(){if(at>=ids.length)return cb(true);var id=ids[at++];
                cmd('coins checkmempool:true coinid:'+id,function(r){
                    var rows=r&&r.status===true&&!r.pending&&r.response,c=Array.isArray(rows)&&rows.length===1?rows[0]:null;
                    if(!c||String(c.coinid).toLowerCase()!==id.toLowerCase()||c.spent!==false)return cb(false);next();
                });
            }next();
        });
    }
    function post(ids,handle,cb){
        if(typeof handle!=='string'||!handle.match(/^[A-Za-z0-9_-]{1,150}$/)||blocked(ids)){cb(false);return;}
        // Keep memory holds even when storage fails. A failed partial reservation never broadcasts.
        for(var i=0;i<ids.length;i++){if(!valid(ids[i])){cb(false);return;}}
        ids.forEach(function(id){held[id.toLowerCase()]=true;owner[id.toLowerCase()]=handle;});
        var at=0;
        function step(){if(at===ids.length){if(MDS.persistRecovery)MDS.persistRecovery(cb);else cb(true);return;}
            MDS.sql("INSERT INTO pp_posted_inputs (coinid,handle) VALUES ('"+ids[at++].toLowerCase()+"','"+handle+"')",function(r){if(!r||r.status!==true){cb(false);return;}step();});}
        table(function(ok){if(!ok){cb(false);return;}step();});
    }
    /* Free this handle's claims. ONLY for a definite "nothing was broadcast": the node answered txnpost with
     * status:false (not pending), or the claim write itself failed before txnpost. An unanswered, pending or
     * uncertain post must stay held. Claims made by any other handle are never touched. */
    function release(ids,handle,cb){
        cb=cb||function(){};
        if(typeof handle!=='string'||!handle.match(/^[A-Za-z0-9_-]{1,150}$/)){cb(false);return;}
        MDS.sql("DELETE FROM pp_posted_inputs WHERE handle='"+handle+"'",function(r){
            if(!r||r.status!==true){cb(false);return;}
            (ids||[]).forEach(function(id){var k=String(id).toLowerCase();if(owner[k]===handle){delete held[k];delete owner[k];}});
            if(MDS.persistRecovery)MDS.persistRecovery(function(){cb(true);});else cb(true);
        });
    }
    /* Review 7 Nov (C-1): an uncertain post held its inputs FOREVER (no release path), so a BOOK/POOL take that never
     * mined kept the user's funding coins, order coins and pool reserves unusable in the app. Two-phase sweep, run from a
     * service tick: a claim first SEEN at least SWEEP_MS ago whose coin the node still reports UNSPENT and NOT in the
     * mempool was provably never posted — it is released. Spent, in-mempool or unreadable claims stay held. */
    var SWEEP_MS=10*60000,firstSeen={};
    function sweepUnposted(cmd,nowMs,cb){
        cb=cb||function(){};nowMs=nowMs||Date.now();
        table(function(ok){if(!ok){cb(0);return;}
            MDS.sql('SELECT coinid,handle FROM pp_posted_inputs',function(r){
                if(!r||r.status!==true||!Array.isArray(r.rows)){cb(0);return;}
                var rows=r.rows,at=0,freed=0,live={};
                function next(){
                    if(at>=rows.length){for(var k in firstSeen)if(!live[k])delete firstSeen[k];cb(freed);return;}
                    var id=String(rows[at].COINID||rows[at].coinid||'').toLowerCase();at++;
                    if(!valid(id)){next();return;}
                    live[id]=true;
                    if(!firstSeen[id]){firstSeen[id]=nowMs;next();return;}
                    if(nowMs-firstSeen[id]<SWEEP_MS){next();return;}
                    cmd('coins checkmempool:true coinid:'+id,function(c){
                        var rs=c&&c.status===true&&!c.pending&&c.response,coin=Array.isArray(rs)&&rs.length===1?rs[0]:null;
                        if(!coin||String(coin.coinid).toLowerCase()!==id||coin.spent!==false){next();return;}
                        MDS.sql("DELETE FROM pp_posted_inputs WHERE coinid='"+id+"'",function(d){
                            if(d&&d.status===true){delete held[id];delete owner[id];delete firstSeen[id];freed++;}
                            next();
                        });
                    });
                }
                next();
            });
        });
    }
    return {load:load,check:check,post:post,release:release,blocked:blocked,sweepUnposted:sweepUnposted};
})();
