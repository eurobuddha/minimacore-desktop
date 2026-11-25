// The first-run checker uses the real address and archive parsers with fixture public descriptors.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const keyuses = require("../main/keyuses");
const helper = require("../main/classic-webwallet");
const net = require("../main/netfetch");
const wallet = require("../main/webwallet");
const {inspect} = require("../main/setup-keys");

for (const [mode,migrate] of [["classic",true],["classic",false],["block",false]]) {
  test("Phrase audit covers both families for " + mode + (migrate ? " migration" : " restore"), async t => {
    const byKey = new Map(), byAddress = new Map(), books = {};
    for (const [family,count] of [["classic",64],["block",32]]) {
      books[family] = Array.from({length:count},(_,i) => {
        const pk = "0x"+(i+(family==="classic"?1:1000)).toString(16).padStart(64,"0");
        const key = {publickey:pk,address:keyuses.addressOf(pk).hex};
        byKey.set(pk,key);byAddress.set(key.address,key);return key;
      });
    }
    t.mock.method(helper,"run",async r => {
      assert.equal(r.action,"addresses");assert.equal(r.seed,"fixture recovery words");
      return {keys:books[r.accountMode]};
    });
    t.mock.method(wallet,"keyusesInfo",()=>({keyuses:7}));
    const lookups = {keys:new Set(),addrs:new Set()};
    let omitLast=false;
    t.mock.method(net,"fetchJson",async url => {
      const u=new URL(url);
      assert.equal(u.hostname,"eurobuddha.com");
      const usage=u.pathname==="/keyaudit",field=usage?"keys":"addrs";
      assert.deepEqual([...u.searchParams.keys()],[field]);
      const ids=u.searchParams.get(field).split(",");
      for(const id of ids)lookups[field].add(id);
      if(usage)return {status:true,archive_tip:123,keys:ids.map(id=>({publickey:id,address:byKey.get(id).address,spend_blocks:1,spent_coins:1}))};
      assert.equal(u.pathname,"/reuse");
      return {status:true,results:ids.filter(id=>!omitLast || id!==books.block[31].address).map(id=>{
        assert.ok(byAddress.has(id));
        const reused=id===books.block[31].address || id===books.classic[63].address;
        return {address:id,reused,reuse_count:reused?2:0};
      })};
    });
    const result=await inspect("fixture recovery words",mode,migrate);
    assert.equal(result.classic,64);assert.equal(result.block,32);assert.equal(result.reused,2);
    assert.deepEqual(lookups.keys,new Set(byKey.keys()));assert.deepEqual(lookups.addrs,new Set(byAddress.keys()));
    assert.deepEqual(result.addresses,books[mode].map(k=>k.address));
    assert.equal(result.mainPublicKey,books[migrate?"block":mode][0].publickey);
    omitLast=true;
    await assert.rejects(inspect("fixture recovery words",mode,migrate),/incomplete/);
  });
}
