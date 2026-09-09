/* Shared Android ReserveRecovery/Recovery counterpart for MDS and desktop.
 * Recipes are durable identities; proofs expire. Every proof is checked by the receiving node.
 * Recovery never regenerates keys, estimates historic leaf use, signs, or posts transactions.
 * Requires the existing Decimal, Covenant, Curve, Store and PoolMgr modules at call time. */
var ReserveRecovery = (function () {
    var NOTICE = "Keep the latest complete MinimaCore wallet backup and this pool recipe. Coin proofs expire. Recovery needs current signing state and available chain proofs; a seed or recipe alone is insufficient.";
    function key(v) { return String(v || "").toLowerCase(); }
    function hex(v) { return typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(v); }
    function hash(v) { return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v); }
    function truth(v) { return v === true || v === "true"; }
    function good(j) { return !!j && truth(j.status) && !truth(j.pending); }
    function integer(v, max) { return (typeof v === "number" || typeof v === "string" && /^\d+$/.test(v)) && isFinite(Number(v)) && Number(v) >= 0 && Math.floor(Number(v)) === Number(v) && Number(v) <= max; }
    function rows(j) { return good(j) && Array.isArray(j.response) ? j.response : null; }
    function local(q, cb) { MDS.cmd(q, cb); }
    // Reuse ActivityChain's once-only, bounded callback wrapper. No timed-out operation is retried here.
    function call(source, q, cb) {
        var ended = false, timer = typeof setTimeout==="function" ? setTimeout(function () { finish(null); }, 30000) : null;
        function finish(j) { if (ended) return; ended = true; if(timer!==null)clearTimeout(timer); cb(good(j) ? j : null); }
        try { source(q, finish); } catch (e) { finish(null); }
    }
    function validRecipe(e) {
        if (!e || !hash(e.addr) || !hash(e.opk) || !hash(e.oadr) || !hash(e.tok) || !integer(e.dec,44)) return false;
        if (e.opkuses !== undefined && !integer(e.opkuses,262144)) return false;
        if (typeof e.kmin !== "string" || e.kmin.length > 80 || !/^\d+(?:\.\d+)?$/.test(e.kmin)) return false;
        try {
            if (!new Decimal(e.kmin).gt(0) || !new Decimal(e.kmin).lt(Covenant.MININUMBER_MAX)) return false;
            var script = String(e.script || "").trim().replace(/\s+/g," ");
            var fee = script.match(/LET fx=MAX\(dx 0\)\*([0-9]+)\/([0-9]+) LET fy=MAX\(dy 0\)\*\1\/\2 /);
            if (!fee || !new Decimal(fee[2]).gt(0) || !new Decimal(fee[1]).lt(fee[2])) return false;
            return script === Covenant.script(e.opk,e.oadr,e.tok,e.kmin).split("*5/1000").join("*"+fee[1]+"/"+fee[2]);
        } catch (err) { return false; }
    }
    function pool(e) { return {address:e.addr,mxaddress:e.mx||"",opk:e.opk,oadr:e.oadr,tok:e.tok,tokDecimals:Number(e.dec),kmin:e.kmin,covenantScript:e.script,script:e.script,minimumOwnerUses:e.opkuses===undefined?-1:Number(e.opkuses)}; }
    function entry(p) {
        var e = {addr:p.address,mx:p.mxaddress||"",opk:p.opk,oadr:p.oadr,tok:p.tok,dec:p.tokDecimals==null?8:p.tokDecimals,kmin:String(p.kmin),script:p.covenantScript||p.script||Covenant.script(p.opk,p.oadr,p.tok,p.kmin)};
        if (integer(p.minimumOwnerUses,262144)) e.opkuses=Number(p.minimumOwnerUses);
        return e;
    }
    function coinFor(p,c) {
        if (!c || c.spent !== false || !hash(c.coinid) || key(c.address)!==key(p.address) || !(key(c.tokenid)==="0x00" || key(c.tokenid)===key(p.tok))) return false;
        if (!c.state || typeof c.state!=="object" || Object.keys(c.state).length) return false;
        var amount=key(c.tokenid)==="0x00"?c.amount:c.tokenamount;
        if (typeof amount!=="string" || !/^\d+(?:\.\d+)?$/.test(amount) || amount.length>160) return false;
        try { return new Decimal(amount).gt(0); } catch(e) { return false; }
    }
    function fill(p,j) {
        p.reserveM=null;p.reserveT=null;p.coinidM="";p.coinidT="";p.reserveBlock=0;p.reserveBlockM=0;p.reserveBlockT=0;
        var cs=rows(j);if(!cs)return false;
        cs.forEach(function(c){
            if(!coinFor(p,c))return;
            var m=key(c.tokenid)==="0x00",amount=new Decimal(m?c.amount:c.tokenamount),leg=m?"M":"T";
            if(p["reserve"+leg]===null || amount.gt(p["reserve"+leg])){
                p["reserve"+leg]=amount;p["coinid"+leg]=c.coinid;p["reserveBlock"+leg]=integer(c.created,2147483647)?Number(c.created):0;
                if(!m && c.token){p.tokName=typeof c.token.name==="string"?c.token.name:(c.token.name&&c.token.name.name)||p.tokName;if(integer(c.token.decimals,44))p.tokDecimals=Number(c.token.decimals);}
            }
        });
        p.reserveBlock=Math.max(p.reserveBlockM,p.reserveBlockT);return true;
    }
    function complete(p) { try {return Curve.funded(p) && new Decimal(p.kmin).gt(0) && p.reserveM.times(p.reserveT).gte(p.kmin);}catch(e){return false;} }
    function readIds(source,ids,mega,i,out,cb){
        if(i===ids.length){cb({status:true,response:out});return;}
        call(source,"coins coinid:"+ids[i]+(mega?" megammr:true":""),function(j){
            var cs=rows(j);if(!cs || cs.length>1 || cs.length && key(cs[0].coinid)!==key(ids[i])){cb(null);return;}
            if(cs.length)out.push(cs[0]);readIds(source,ids,mega,i+1,out,cb);
        });
    }
    function read(source,p,mega,limit,cb){
        var suffix=" address:"+p.address+(mega?" megammr:true":"");
        call(source,"balance"+suffix,function(j){
            var rs=rows(j),count=0;if(!rs){cb(null);return;}
            for(var i=0;i<rs.length;i++){if(!integer(rs[i].coins,100000000)){cb(null);return;}count+=Number(rs[i].coins);}
            if(count>limit){
                if(hash(p.coinidM)&&hash(p.coinidT)&&key(p.coinidM)!==key(p.coinidT))readIds(source,[p.coinidM,p.coinidT],mega,0,[],cb);
                else cb(null);
                return;
            }
            call(source,"coins"+suffix,cb);
        });
    }
    function savedHints(p,cb){
        Store.ownAll(function(ps,ok){
            if(ok===false){cb(false);return;}
            ps.forEach(function(r){if(key(r.address)===key(p.address)){
                if(!hash(p.coinidM))p.coinidM=r.coinidM;if(!hash(p.coinidT))p.coinidT=r.coinidT;
                p.minimumOwnerUses=Math.max(p.minimumOwnerUses===undefined?-1:p.minimumOwnerUses,r.minimumOwnerUses);
                p.signingStateUnverified=!!p.signingStateUnverified||r.signingStateUnverified;
            }});cb(true);
        });
    }
    function readCurrent(p,cb){read(local,p,false,512,cb);}
    function readReserves(p,cb){savedHints(p,function(){read(local,p,false,512,function(j){
        var ok=fill(p,j)&&complete(p);if(ok)Store.ownRememberReserves(p,function(){cb(true);});else cb(false);
    });});}
    function proof(data){return typeof data==="string" && data.length<=32000 && hex(data);}
    function recover(p,snapshot,archive,cb){
        var ended=false,notes=[],hints={address:p.address,coinidM:p.coinidM,coinidT:p.coinidT};
        function finish(ok){if(ended)return;ended=true;cb(ok,p.address+"\n"+(ok?"Both reserves verified on this node. Owner signing remains paused until current wallet signing state is confirmed.":"Reserves unresolved; recipe retained. An empty local lookup does not prove the funds were spent. Use a synced MegaMMR archive or fresh backup proofs. "+notes.join(" ")));}
        function live(next){read(local,hints,false,512,function(j){if(fill(p,j)&&complete(p))finish(true);else next();});}
        function checked(data,token,id,next){
            if(!proof(data)){notes.push("Missing or malformed proof for "+token+".");next();return;}
            call(local,"coincheck data:"+data,function(j){
                var r=j&&j.response,c=r&&r.coin;
                if(!r||!truth(r.valid)||!coinFor(p,c)||key(c.tokenid)!==key(token)||id&&key(c.coinid)!==key(id)){notes.push("Proof rejected for "+token+".");next();return;}
                hints[key(token)==="0x00"?"coinidM":"coinidT"]=c.coinid;
                call(local,"coinimport track:true data:"+data,function(imported){if(!imported)notes.push("Import failed for "+c.coinid+".");next();});
            });
        }
        function snapshots(i){if(i===2){live(function(){fromArchive(local,true);});return;}var data=snapshot&&(i===0?snapshot.cm:snapshot.ct);if(!data){snapshots(i+1);return;}checked(data,i===0?"0x00":p.tok,null,function(){snapshots(i+1);});}
        function nextSource(isLocal){if(isLocal&&archive)fromArchive(archive,false);else finish(false);}
        function fromArchive(source,isLocal){
            call(source,"status",function(j){
                if(!j||!j.response||!truth(j.response.megammr)){if(!isLocal)notes.push("Archive unavailable or not a MegaMMR node.");nextSource(isLocal);return;}
                var found={address:p.address,tok:p.tok,kmin:p.kmin,coinidM:hints.coinidM,coinidT:hints.coinidT};
                read(source,found,true,512,function(coins){
                    if(!fill(found,coins)){notes.push("Archive coin lookup failed.");nextSource(isLocal);return;}
                    function leg(i){
                        if(i===2){live(function(){nextSource(isLocal);});return;}
                        var id=i===0?found.coinidM:found.coinidT,token=i===0?"0x00":p.tok;
                        if(!hash(id)){notes.push("Archive reserve missing for "+token+".");leg(i+1);return;}
                        call(source,"coinexport coinid:"+id,function(j){checked(j&&j.response&&j.response.data,token,id,function(){leg(i+1);});});
                    }leg(0);
                });
            });
        }
        live(function(){snapshots(0);});
    }
    function restoreOne(e,archive,cb){
        if(!validRecipe(e)){cb(false,"Invalid pool recipe; nothing imported.");return;}
        call(local,"runscript script:"+Covenant.scriptArg(e.script),function(j){
            var r=j&&j.response;
            if(!r||!truth(r.parseok)||!r.script||key(r.script.address)!==key(e.addr)){cb(false,e.addr+"\nCovenant address did not verify.");return;}
            var p=pool(e);p.signingStateUnverified=true;
            Store.ownRecord(p,function(saved){
                if(!saved){cb(false,e.addr+"\nCould not save the recipe and signing hold. Nothing imported.");return;}
                if(integer(e.kidx,2048))PoolMgr.rememberKidx(e.opk,Number(e.kidx));
                Store.knownAddrsAdd([e.addr,e.mx]);
                call(local,"newscript trackall:true script:"+Covenant.scriptArg(e.script),function(tracked){
                    if(!tracked){cb(false,e.addr+"\nCould not track covenant; recipe retained.");return;}
                    savedHints(p,function(){recover(p,e,archive,function(ok,detail){if(!ok){cb(false,detail);return;}Store.ownRecord(p,function(persisted){cb(!!persisted,detail+(persisted?"":"\nCould not save verified reserve IDs."));});});});
                });
            });
        });
    }
    function cancelPoolTransactions(cb){
        call(local,"txnlist",function(j){var txs=rows(j);if(!txs){cb(false);return;}
            var ids=txs.map(function(t){return t.id;}).filter(function(id){return typeof id==="string"&&/^pp(?:annsvc|refsvc|ann|refresh|create|dep|mig|close|fwd|swap)_[a-zA-Z0-9_]+$/.test(id);});
            function next(i){if(i===ids.length){cb(true);return;}call(local,"txndelete id:"+ids[i],function(r){if(!r){cb(false);return;}next(i+1);});}next(0);
        });
    }
    function restore(json,archive,progress,cb){
        var root;try{root=JSON.parse(json);}catch(e){cb({restored:0,total:0,warn:"Invalid backup JSON."});return;}
        if(!root||!integer(root.pandapools_backup,3)||Number(root.pandapools_backup)<1||!Array.isArray(root.pools)||!root.pools.length||root.pools.length>500){cb({restored:0,total:0,warn:"Unsupported or empty pool backup."});return;}
        var i=0,ok=0,details=[];
        function next(){
            if(i===root.pools.length){cb({restored:ok,total:i,regen:0,details:details,warn:"Owner signing is paused for restored recipes. Confirm the latest complete wallet signing state before spending. "+NOTICE});return;}
            restoreOne(root.pools[i++],archive,function(verified,detail){if(verified)ok++;details.push(detail);if(progress)progress(detail);next();});
        }cancelPoolTransactions(function(ok){if(ok)next();else cb({restored:0,total:root.pools.length,warn:"Could not cancel existing pool transactions. Recovery did not start; clear pending PandaPools actions and retry."});});
    }
    function backup(height,cb){
        Store.ownAll(function(recipes,readOk){
            if(readOk===false){cb({empty:false,error:"Could not read saved pool recipes."});return;}
            if(!recipes.length){cb({empty:true,json:""});return;}
            var out=[],i=0;
            function next(){
                if(i===recipes.length){cb({json:JSON.stringify({pandapools_backup:3,recovery_notice:NOTICE,pools:out},null,2)});return;}
                var p=recipes[i++],e=entry(p);out.push(e);
                PoolMgr.readKeyUses(p.opk,function(uses,kidx){
                    if(integer(uses,262144)){
                        e.opkuses=Math.max(Number(uses),p.minimumOwnerUses||0);p.minimumOwnerUses=e.opkuses;
                        if(height>0)e.atblock=height;
                        if(Number(uses)<e.opkuses)e.signing_warning="Node counter is below a recorded count.";
                    }else e.signing_warning="Owner-key counter unavailable; current wallet signing state is required.";
                    if(kidx>=0){e.kidx=kidx;PoolMgr.rememberKidx(p.opk,kidx);}
                    Store.ownRecord(p,function(saved){
                        if(!saved)e.signing_warning="Could not save the observed owner-key count.";
                        readReserves(p,function(found){
                            if(!found){e.proof_warning="Live reserves unavailable. Fresh archive proofs may be required.";next();return;}
                            var ids=[p.coinidM,p.coinidT];
                            function leg(n){
                                if(n===2){
                                    readReserves(p,function(still){
                                        if(!still||key(p.coinidM)!==key(ids[0])||key(p.coinidT)!==key(ids[1])){delete e.cm;delete e.ct;e.proof_warning="Pool moved during export; obtain fresh archive proofs.";}
                                        else if(!e.cm||!e.ct)e.proof_warning="A reserve proof could not be exported. Recipe retained.";
                                        next();
                                    });return;
                                }
                                call(local,"coinexport coinid:"+ids[n],function(j){
                                    var r=j&&j.response,c=r&&r.coinproof&&r.coinproof.coin,token=n===0?"0x00":p.tok,name=n===0?"cm":"ct";
                                    if(r&&proof(r.data)&&coinFor(p,c)&&key(c.coinid)===key(ids[n])&&key(c.tokenid)===key(token)){
                                        e[name]=r.data;e[name+"_created"]=c.created;e[name+"_proofblock"]=r.coinproof.proof&&r.coinproof.proof.blocktime;
                                    }leg(n+1);
                                });
                            }leg(0);
                        });
                    });
                });
            }next();
        });
    }
    function keyRows(j){var r=j&&j.response;return good(j)?(Array.isArray(r)?r:r&&Array.isArray(r.keys)?r.keys:null):null;}
    function checkedKeys(wanted,j,ps){
        var rs=keyRows(j),missing={};wanted.forEach(function(k){if(k)missing[key(k)]=true;});
        if(rs)rs.forEach(function(r){if(r&&integer(r.uses,262143))delete missing[key(r.publickey)];});
        ps.forEach(function(p){if(wanted.map(key).indexOf(key(p.opk))<0)return;
            var row=rs&&rs.filter(function(r){return key(r.publickey)===key(p.opk);})[0];
            if(p.signingStateUnverified||(typeof Store!=="undefined"&&Store.confirmationFailed(p.opk))||!row||!integer(row.uses,262143)||Number(row.uses)<p.minimumOwnerUses)missing[key(p.opk)]=true;
        });return Object.keys(missing);
    }
    function ensureKeys(wanted,cb){
        call(local,"keys",function(j){signingRecipes(function(ps,ok){cb(0,ok===false?(wanted||[]).slice():checkedKeys(wanted||[],j,ps));});});
    }
    // The headless MDS bundle has no Store global. Reuse the same persisted guard columns directly.
    function signingRecipes(cb){
        if(typeof Store!=="undefined"){Store.ownAll(cb);return;}
        MDS.sql("SELECT OPK,OPKUSES,SIGNING_UNVERIFIED FROM pp_ownpools",function(r){
            if(!r||r.status!==true||!Array.isArray(r.rows)){cb([],false);return;}
            cb(r.rows.map(function(row){return {opk:row.OPK,minimumOwnerUses:Number(row.OPKUSES),signingStateUnverified:Number(row.SIGNING_UNVERIFIED)!==0};}),true);
        });
    }
    function validEndpoint(url){
        if(typeof url!=="string"||url.length>1024)return false;
        var m=url.match(/^https:\/\/([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(\/[^\s?#\\]*)?$/);
        return !!m && /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(m[1])
            && !/\.(?:local|localhost|internal)$/i.test(m[1]) && (!m[2] || Number(m[2])>0&&Number(m[2])<65536);
    }
    function allowedArchive(q){return q==="status" || /^(?:balance|coins) address:0x[0-9a-fA-F]{64} megammr:true$/.test(q) || /^coins coinid:0x[0-9a-fA-F]{64} megammr:true$/.test(q) || /^coinexport coinid:0x[0-9a-fA-F]{64}$/.test(q);}
    function configuredArchive(cb){
        Store.kvGet("recovery_archive",function(url,ok){
            if(ok===false||!validEndpoint(url)){cb(null);return;}
            var base=url.replace(/\/$/,"")+"/";
            cb(function(q,done){
                if(!allowedArchive(q)){done(null);return;}
                var target=base+encodeURIComponent(q);
                if(MDS.archiveGET){MDS.archiveGET(target,done);return;}
                browserArchive(target,done);
            });
        });
    }
    // Browser transport: bound bytes while reading and cancel the request, not just its callback.
    function browserArchive(url,cb){
        if(typeof fetch!=="function"||typeof AbortController!=="function"||typeof TextDecoder!=="function"){cb(null);return;}
        var controller=new AbortController(),reader=null,ended=false,total=0,parts=[];
        var timer=setTimeout(function(){finish(null);},15000);
        function finish(j){if(ended)return;ended=true;clearTimeout(timer);controller.abort();if(reader)reader.cancel().catch(function(){});cb(j);}
        fetch(url,{signal:controller.signal,credentials:"omit",redirect:"error",cache:"no-store"}).then(function(r){
            if(!r.ok||!r.body||!r.body.getReader||Number(r.headers.get("Content-Length"))>256000){finish(null);return;}
            reader=r.body.getReader();
            function next(){reader.read().then(function(part){
                if(ended)return;
                if(part.done){var bytes=new Uint8Array(total),offset=0;parts.forEach(function(p){bytes.set(p,offset);offset+=p.byteLength;});try{finish(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));}catch(e){finish(null);}return;}
                total+=part.value.byteLength;if(total>256000){finish(null);return;}parts.push(part.value);next();
            },function(){finish(null);});}next();
        },function(){finish(null);});
    }
    function saveArchive(url,cb){
        url=String(url||"").trim();if(url&&!validEndpoint(url)){cb(false);return;}
        Store.kvSet("recovery_archive",url,function(){Store.kvGet("recovery_archive",function(saved,ok){cb(ok!==false&&saved===url);});});
    }
    function confirmKey(opk,cb){
        PoolMgr.readKeyUses(opk,function(uses){if(!integer(uses,262143)){cb(false);return;}Store.ownAcknowledge(opk,Number(uses),cb);});
    }
    // Mirror core txnsign:auto: only actual simple script rows supply automatic signing keys.
    function checkSignature(ids,signer,cb){
        var addresses={},signers=[];
        if(!ids.length||ids.length>64||!(signer==="auto"||hash(signer))){cb("Invalid signing inputs.");return;}
        if(signer!=="auto")signers.push(signer);
        function input(i){
            if(i===ids.length){script(Object.keys(addresses),0);return;}
            if(!hash(ids[i])){cb("Invalid signing input ID.");return;}
            call(local,"coins coinid:"+ids[i],function(j){var cs=rows(j),c=cs&&cs.length===1&&cs[0];
                if(!c||c.spent!==false||key(c.coinid)!==key(ids[i])||!hash(c.address)){cb("Could not verify a current signing input.");return;}
                if(signer==="auto")addresses[key(c.address)]=true;input(i+1);
            });
        }
        function script(as,i){
            if(i===as.length){ensureKeys(signers,function(n,missing){cb(missing.length?"Owner signing is paused or the current signing key could not be verified.":null);});return;}
            call(local,"scripts address:"+as[i],function(j){var r=j&&j.response;
                if(!r||key(r.address)!==as[i]||typeof r.simple!=="boolean"){cb("Could not identify the input signing key.");return;}
                if(r.simple){if(!hash(r.publickey)){cb("Invalid input signing key.");return;}if(signers.map(key).indexOf(key(r.publickey))<0)signers.push(r.publickey);}
                script(as,i+1);
            });
        }call(local,"checkmode",function(j){if(!j||!j.response||j.response.writemode!==true){cb("Enable PandaPools WRITE mode in MiniHub before signing; deferred signature approvals are not supported.");return;}input(0);});
    }
    return {restore:restore,backup:backup,entry:entry,readCurrent:readCurrent,readReserves:readReserves,recover:recover,validRecipe:validRecipe,complete:complete,fill:fill,coinFor:coinFor,integer:integer,ensureKeys:ensureKeys,checkSignature:checkSignature,configuredArchive:configuredArchive,validEndpoint:validEndpoint,allowedArchive:allowedArchive,saveArchive:saveArchive,confirmKey:confirmKey,notice:NOTICE};
})();
