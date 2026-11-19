/* Stock-node proof coordinates: port of native ChainEvidence. Cached proof is not a fresh check. */
var PandaChain = {};
(function(C,S){
  C.epoch=String(Date.now())+"-"+String(Math.random());C.order=0;
  C.depth=function(reply){var r=reply&&reply.response,n;if(!S.truthy(reply&&reply.status)||!S.truthy(r&&r.found))return -1;n=S.decimal(r.confirmations);return n&&n.gte(0)&&n.isInteger()&&n.lte(2147483647)?n.toNumber():-1;};
  C.block=function(reply){return C.depth(reply)<0?0:S.positiveInteger(reply.response.block);};
  C.blockId=function(reply){var id=reply&&reply.response&&reply.response.blockid;return C.depth(reply)>=0&&S.hex(id)?id:"";};
  C.transactionId=function(tx){var body=tx&&tx.body,txn=body&&body.txn,id=txn&&txn.transactionid;return S.hex(id)?id:"";};
  C.inclusionTime=function(inclusion,reply,txpowid){
    var height=C.block(inclusion),id=C.blockId(inclusion),block=reply&&reply.response,header=block&&block.header,body=block&&block.body,ids=body&&body.txnlist,i,contains;
    if(!height||!id||!S.hex(txpowid)||!S.truthy(reply&&reply.status)||!S.truthy(block&&block.isblock)||id.toLowerCase()!==String(block.txpowid||"").toLowerCase()||S.positiveInteger(header&&header.block)!==height)return 0;
    contains=id.toLowerCase()===txpowid.toLowerCase()&&S.truthy(block.istransaction);
    if(Array.isArray(ids))for(i=0;i<ids.length&&!contains;i++)if(typeof ids[i]==="string"&&ids[i].toLowerCase()===txpowid.toLowerCase())contains=true;
    return contains?S.positiveInteger(header&&header.timemilli):0;
  };
  C.proof=function(tx,index,inclusion,time,order,at){
    var txn=tx&&tx.body&&tx.body.txn||{},inputs=Array.isArray(txn.inputs)?txn.inputs:[];
    return {txpowid:tx.txpowid,transactionId:C.transactionId(tx),inputIndex:index,input:index<0?null:inputs[index],inputCount:inputs.length,
      outputs:Array.isArray(txn.outputs)?txn.outputs:[],transactionState:Array.isArray(txn.state)?txn.state:[],confirmations:C.depth(inclusion),
      inclusionBlock:C.block(inclusion),inclusionBlockId:C.blockId(inclusion),inclusionTimeMs:time,proofOrder:order,proofTimeMs:at,proofEpoch:C.epoch};
  };
})(PandaChain,PandaSafety);
