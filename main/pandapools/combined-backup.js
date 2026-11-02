/* Portable PandaPools combined backup. Matches BackupVault.java's existing MVLT AES-GCM container.
 * Reuses the wallet's PBKDF2 -> HKDF-expand -> AES-256-GCM scheme; WebCrypto performs all cryptography.
 * No node commands or restore side effects occur here. Authenticate first, then validate the payload.
 */
(function (root) {
    'use strict';
    var MAX_NODE = 128 * 1024 * 1024, MAX_MANIFEST = 4 * 1024 * 1024;
    var MAX_PAYLOAD = MAX_NODE + MAX_MANIFEST + 8, ROUNDS = 210000;
    var enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
    function cryptoApi() {
        var c = root.crypto || (typeof module !== 'undefined' && module.exports ? require('node:crypto').webcrypto : null);
        if (!c || !c.subtle || !c.getRandomValues) throw Error('ENCRYPTION_UNAVAILABLE: open PandaPools through HTTPS or localhost. No unencrypted backup will be made.');
        return c;
    }
    function bytes(value) { return value instanceof Uint8Array ? value : new Uint8Array(value); }
    function hex(value) { return Array.from(bytes(value), function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
    function validPassword(pass) { return typeof pass === 'string' && Array.from(pass).length >= 12 && enc.encode(pass).length <= 1024; }
    function randomPassword() { return hex(cryptoApi().getRandomValues(new Uint8Array(32))); }
    async function sha(value) { return hex(await cryptoApi().subtle.digest('SHA-256', bytes(value))); }
    async function key(pass, salt) {
        var s = cryptoApi().subtle;
        var password = await s.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
        var master = await s.deriveBits({name:'PBKDF2', hash:'SHA-256', salt:salt, iterations:ROUNDS}, password, 256);
        var hmac = await s.importKey('raw', master, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
        var info = enc.encode('minima-wallet-vault/aes-256-gcm/v1\x01');
        var aes = await s.sign('HMAC', hmac, info); new Uint8Array(master).fill(0);
        var result = await s.importKey('raw', aes, {name:'AES-GCM'}, false, ['encrypt','decrypt']); new Uint8Array(aes).fill(0);
        return result;
    }
    async function seal(pass, payload) {
        if (!validPassword(pass)) throw Error('PASSWORD_REQUIRED: use at least 12 characters.');
        payload = bytes(payload); if (payload.length > MAX_PAYLOAD) throw Error('BACKUP_TOO_LARGE');
        var c = cryptoApi(), salt = c.getRandomValues(new Uint8Array(16)), nonce = c.getRandomValues(new Uint8Array(12));
        var header = new Uint8Array(40); header.set(enc.encode('MVLT')); header[4]=1; header[5]=1;
        new DataView(header.buffer).setUint32(6, ROUNDS); header[10]=16; header.set(salt,11); header[27]=12; header.set(nonce,28);
        var cipher = new Uint8Array(await c.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:header,tagLength:128}, await key(pass,salt),payload));
        var result = new Uint8Array(header.length+cipher.length); result.set(header);result.set(cipher,header.length);return result;
    }
    async function unseal(pass, data) {
        data=bytes(data);
        if (typeof pass !== 'string' || enc.encode(pass).length > 1024) throw Error('PASSWORD_INVALID');
        if(data.length<56||data.length>MAX_PAYLOAD+56)throw Error('BACKUP_SIZE_INVALID');
        if(hex(data.subarray(0,6))!=='4d564c540101'||new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(6)!==ROUNDS||data[10]!==16||data[27]!==12)
            throw Error('BACKUP_FORMAT: unsupported encrypted backup.');
        try { return new Uint8Array(await cryptoApi().subtle.decrypt({name:'AES-GCM',iv:data.subarray(28,40),additionalData:data.subarray(0,40),tagLength:128}, await key(pass,data.subarray(11,27)),data.subarray(40))); }
        catch(e){throw Error('BACKUP_AUTHENTICATION: wrong password or damaged backup. Nothing restored.');}
    }
    function validate(m) {
        if(!m||m.format!=='pandapools_full_backup'||m.version!==1||m.network!=='minima-mainnet')throw Error('BACKUP_VERSION_OR_NETWORK: incompatible bundle.');
        if(!/^0x[0-9a-fA-F]{64}$/.test(m.wallet||'')||!['block','classic'].includes(m.keyMode))throw Error('BACKUP_WALLET_IDENTITY_MISSING');
        if(!/^[a-f0-9]{64}$/.test(m.nodePassword||'')||!/^[a-f0-9]{64}$/.test(m.nodeSha256||'')||!Number.isSafeInteger(m.nodeBytes)||m.nodeBytes<32||m.nodeBytes>MAX_NODE||!Number.isSafeInteger(m.created)||m.created<=0)throw Error('BACKUP_NODE_METADATA_INVALID');
        var p=m.pools;
        if(!p||!Number.isInteger(p.pandapools_backup)||p.pandapools_backup<1||p.pandapools_backup>3||!Array.isArray(p.pools)||p.pools.length<1||p.pools.length>500)throw Error('BACKUP_POOL_RECIPES_MISSING');
        return m;
    }
    async function create(pass, poolJson, wallet, mode, nodePassword, nodeBytes) {
        nodeBytes=bytes(nodeBytes);
        var m=validate({format:'pandapools_full_backup',version:1,network:'minima-mainnet',created:Date.now(),wallet:wallet,keyMode:mode,nodePassword:nodePassword,nodeBytes:nodeBytes.length,nodeSha256:await sha(nodeBytes),pools:typeof poolJson==='string'?JSON.parse(poolJson):poolJson});
        var json=enc.encode(JSON.stringify(m));if(json.length>MAX_MANIFEST)throw Error('BACKUP_MANIFEST_TOO_LARGE');
        var payload=new Uint8Array(8+json.length+nodeBytes.length);payload.set(enc.encode('PPB1'));new DataView(payload.buffer).setUint32(4,json.length);payload.set(json,8);payload.set(nodeBytes,8+json.length);
        try { return await seal(pass,payload); } finally {payload.fill(0);}
    }
    async function open(pass, encrypted) {
        var plain=await unseal(pass,encrypted);
        try {
            if(plain.length<10||hex(plain.subarray(0,4))!=='50504231')throw Error('BACKUP_TYPE: not a combined PandaPools backup.');
            var size=new DataView(plain.buffer,plain.byteOffset,plain.byteLength).getUint32(4);
            if(size<2||size>MAX_MANIFEST||size>plain.length-8)throw Error('BACKUP_MANIFEST_INVALID');
            var manifest=validate(JSON.parse(dec.decode(plain.subarray(8,8+size))));
            var node=plain.slice(8+size);
            if(node.length!==manifest.nodeBytes||await sha(node)!==manifest.nodeSha256)throw Error('NODE_BACKUP_INTEGRITY: node backup is incomplete or damaged.');
            return {manifest:manifest,node:node,poolJson:JSON.stringify(manifest.pools)};
        } finally {plain.fill(0);}
    }
    var api={create:create,open:open,seal:seal,unseal:unseal,sha:sha,validPassword:validPassword,randomPassword:randomPassword,validate:validate,MAX_NODE:MAX_NODE,MAX_FILE:MAX_PAYLOAD+56};
    if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PoolBackupBundle=api;
})(typeof globalThis!=='undefined'?globalThis:this);
