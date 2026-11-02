/* Native node capture orchestration, shared by MDS and Desktop. No signing or node replacement. */
(function(root){'use strict';
    var B=typeof module!=='undefined'&&module.exports?require('./combined-backup.js'):root.PoolBackupBundle;
    function keys(reply){if(!reply||reply.status!==true||reply.pending===true||!reply.response||!Array.isArray(reply.response.keys))throw Error('WALLET_UNREADABLE: could not read the wallet keys.');return reply.response.keys;}
    function counter(v){return (typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)||(typeof v==='string'&&/^[0-9]+$/.test(v)&&Number.isSafeInteger(Number(v)));}
    function identity(reply,recipes){
        var rows=keys(reply),first=rows.find(function(r){return /^(?:0x)?0+$/i.test(String(r.modifier||''));} );
        if(!first||!/^0x[0-9a-fA-F]{64}$/.test(first.publickey||''))throw Error('WALLET_IDENTITY_MISSING');
        var mode=Number(first.size)===128&&Number(first.depth)===4?'block':Number(first.size)===64&&Number(first.depth)===3?'classic':'';
        if(!mode)throw Error('KEY_MODE_UNKNOWN');
        recipes.pools.forEach(function(p){
            var row=rows.find(function(r){return String(r.publickey).toLowerCase()===String(p.opk).toLowerCase();});
            if(!row||!counter(row.uses)||Number(row.uses)<Number(p.opkuses)||Number(row.size)!==Number(first.size)||Number(row.depth)!==Number(first.depth))throw Error('OWNER_KEYS_MISSING: the node does not contain every pool owner key with its recorded signing state.');
        });
        return {wallet:first.publickey.toLowerCase(),mode:mode};
    }
    async function capture(api,password){
        if(!B.validPassword(password))throw Error('PASSWORD_REQUIRED: use at least 12 characters.');
        var json=await api.backup(),recipes=JSON.parse(json),state=await api.cmd('status');
        if(!state||state.status!==true||state.pending===true||!state.response||state.response.locked!==false)throw Error('WALLET_LOCKED: unlock the node wallet first.');
        var before=identity(await api.cmd('keys'),recipes),inner=B.randomPassword(),name='pandapools-node-'+B.randomPassword().slice(0,32)+'.bak';
        try {
            await api.makeNode(name,inner);
            var node=await api.readNode(name);
            if(!node||node.length<32||node.length>B.MAX_NODE)throw Error('NODE_BACKUP_SIZE: node backup is empty or exceeds 128 MiB.');
            var after=identity(await api.cmd('keys'),recipes);
            if(before.wallet!==after.wallet||before.mode!==after.mode)throw Error('WALLET_CHANGED: wallet changed during backup. Nothing exported.');
            var encrypted=await B.create(password,json,before.wallet,before.mode,inner,node);
            var checked=await B.open(password,encrypted);checked.node.fill(0);
            return {encrypted:encrypted,json:json};
        } finally {inner=null;try{await api.deleteNode(name);}catch(ignore){/* Random-password native blob; never expose its password in errors. */}}
    }
    var api={capture:capture,identity:identity};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FullBackup=api;
})(typeof globalThis!=='undefined'?globalThis:this);
