/* ES5 ports of native TxValidation, CommandSafety and ChainEvidence.tipBlock. */
var PandaSafety = {};
PandaSafety.truthy = function(v) {
  return v === true || v === 1 || (typeof v === "string" && /^(true|1)$/i.test(v.replace(/^\s+|\s+$/g,"")));
};
PandaSafety.commandFailure = function(command) {
  if (typeof command !== "string" || !command.replace(/\s/g,"")) return "Empty node command.";
  if (command.length > 100000) return "Node command is too large.";
  if (/[;\x00-\x1f\x7f]/.test(command)) return "Unsafe command data. Nothing was sent to the node.";
  return null;
};
PandaSafety.checkFailure = function(reply) {
  var r=reply&&reply.response, valid=r&&r.valid, yes=PandaSafety.truthy;
  if (!yes(reply&&reply.status)) return "The node could not check the transaction. Nothing was posted.";
  if (!yes(valid&&valid.mmrproofs)) return "An input coin was already spent or its proof is invalid. Refresh and retry; nothing was posted.";
  if (!yes(r&&r.validamounts)) return "The transaction amounts do not balance. Nothing was posted.";
  if (!yes(valid&&valid.scripts)) return "The covenant rejects this transaction. Nothing was posted.";
  if (!yes(valid&&valid.basic) || !yes(r&&r.allsignaturesvalid) || !yes(r&&r.validtransaction)) return "The node did not validate the complete transaction and signatures. Nothing was posted.";
  return null;
};
PandaSafety.postError = function(reply) {
  var error=String(reply&&reply.error||"");
  if (error.indexOf("TxPoW size too large") >= 0) return "Minima rejected the transaction at txnpost: " + error + ". These are serialized TxPoW bytes / the chain maximum. Nothing was broadcast. Use MinimaCore consolidation to combine fewer coins, wait for confirmation, then retry. A coin-count limit does not guarantee that proofs and signatures fit.";
  return "Node rejected txnpost" + (error ? ": " + error : ".");
};
PandaSafety.positiveInteger = function(value) {
  var s=String(value), n=Number(value);
  return /^[0-9]{1,16}$/.test(s) && isFinite(n) && n>0 && n<=9007199254740991 ? n : 0;
};
PandaSafety.tipBlock = function(reply) {
  return PandaSafety.truthy(reply&&reply.status) ? PandaSafety.positiveInteger(reply&&reply.response&&reply.response.block) : 0;
};

PandaSafety.hex = function(value) { return typeof value === "string" && value.length<=1026 && /^0x(?:[0-9a-fA-F]{2})+$/.test(value); };
/* Bounded BigDecimal syntax/scale/precision, before constructing a Decimal. `sig` is the
   significant-digit ceiling and it is NOT one number:

     44  amounts the APP BUILDS — order locks, wants, splits, relocks. Util.decOr / DexTxn.amountOk.
     64  amounts the NODE REPORTS — balances and coin amounts. Util.balanceDecimal.

   Stock MiniNumber really does emit 64 significant digits with 44 decimal places; an S10 on
   MinimaCore 1.1.2.3 returns 48. Parsing those with the 44-digit order limit is what made native
   0.4.14 show no MINIMA balance (fixed in 0.4.16) and every trade fail on "Could not read the
   available balance" (fixed in 0.4.20). The scale bound is 44 either way — that one is real. */
PandaSafety.bounded = function(value, sig) {
  if (typeof value!=="string" && typeof value!=="number") return null;
  var s=String(value).replace(/^\s+|\s+$/g,""), m, digits, scale;
  if(!s || s.length>100)return null;
  m=/^[+-]?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(s);
  if(!m)return null;
  digits=((m[1]||"")+(m[2]||m[3]||"")).replace(/^0+/,"")||"0";
  scale=(m[2]||m[3]||"").length-Number(m[4]||0);
  if(digits.length>sig || Math.abs(scale)>44)return null;
  try{return PandaDEX.d(s);}catch(ignore){return null;}
};
PandaSafety.decimal = function(value) { return PandaSafety.bounded(value, 44); };
PandaSafety.balanceDecimal = function(value) { return PandaSafety.bounded(value, 64); };
