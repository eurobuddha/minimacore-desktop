package com.eurobuddha.casino;

import java.nio.file.*;
import java.util.*;
import org.minima.kissvm.Contract;
import org.minima.kissvm.values.Value;
import org.minima.objects.*;
import org.minima.objects.base.*;
import org.minima.utils.json.*;
import org.minima.utils.json.parser.JSONParser;

/** Offline real-core covenant execution and cross-language production builder comparison.
 * Signer lists stand for already-verified signatures; this does not mine or submit transactions. */
public class CasinoOfferOracle {
    static void check(boolean value,String message) { if(!value)throw new AssertionError(message); }
    static org.minima.objects.Coin output(String amount,String token,boolean keep) {
        MiniNumber value=new MiniNumber(amount);
        org.minima.objects.Coin c=new org.minima.objects.Coin(new MiniData(CasinoContract.SCRIPT_ADDR),value,new MiniData(token),keep);
        if(!token.equals("0x00")) {
            // Synthetic scale-16 metadata exercises real VERIFYOUT token scaling without a live wallet.
            Token t=new Token(new MiniData("0x99"),new MiniNumber(16),MiniNumber.ONE,new MiniString("test USD"),new MiniString("RETURN TRUE"));
            c=new org.minima.objects.Coin(new MiniData(CasinoContract.SCRIPT_ADDR),t.getScaledMinimaAmount(value),new MiniData(token),keep);
            c.setToken(t);
        }
        return c;
    }
    static boolean execute(Bet b,Transaction tx,boolean owner) throws Exception {
        ArrayList<StateVariable> previous=new ArrayList<>();
        for(int p=0;p<8;p++)previous.add(new StateVariable(p,b.coin.stateAt(p)));
        ArrayList<MiniData> signatures=new ArrayList<>();signatures.add(new MiniData(owner?b.housePk:"0xEE"));
        Contract c=new Contract(CasinoContract.SCRIPT,signatures,new Witness(),tx,previous);
        String[][] globals={{"@INPUT","0"},{"@ADDRESS",CasinoContract.SCRIPT_ADDR},{"@TOKENID",b.tokenid()},{"@AMOUNT",b.totalAmount},{"@COINAGE","500"}};
        for(String[] g:globals)c.setGlobalVariable(g[0],Value.getValue(g[1]));
        c.run();check(c.isParseOK(),"covenant failed to parse");return c.isSuccess();
    }
    public static void main(String[] args) throws Exception {
        JSONArray cases=(JSONArray)new JSONParser().parse(Files.readString(Path.of(args[0])));
        for(Object row:cases) {
            JSONObject r=(JSONObject)row, raw=(JSONObject)r.get("coin");
            Coin c=new Coin();c.coinid=(String)raw.get("coinid");c.tokenid=(String)raw.get("tokenid");c.created=0;
            c.amount=String.valueOf(raw.get("tokenamount")!=null?raw.get("tokenamount"):raw.get("amount"));
            for(Object field:(JSONArray)raw.get("state")) {JSONObject f=(JSONObject)field;c.state.put(((Number)f.get("port")).intValue(),(String)f.get("data"));}
            Bet b=new Bet(c);check(OfferKeepAlive.due(b,500),"APK rejected valid offer");
            List<String> nativePlan=OfferKeepAlive.commands(b,"test"),jsPlan=new ArrayList<>();
            for(Object command:(JSONArray)r.get("commands")) {String s=(String)command;if(s.startsWith("txn")&&!s.startsWith("txnpost")&&!s.startsWith("txndelete"))jsPlan.add(s.replaceAll(" id:[^ ]+"," id:test"));}
            check(nativePlan.equals(jsPlan),"APK/JS transaction plan differs: "+nativePlan+" vs "+jsPlan);
            org.minima.system.commands.base.maths math=new org.minima.system.commands.base.maths();
            math.getParams().put("calculate",b.betAmount+"*"+(b.payout-1));
            String exact=(String)((JSONObject)math.runCommand().get("response")).get("result");
            check(new MiniNumber(exact).isEqual(new MiniNumber(b.totalAmount)),"core exact collateral mismatch");
            Transaction renewal=new Transaction();
            for(int p=0;p<8;p++)renewal.addStateVariable(new StateVariable(p,c.stateAt(p)));
            renewal.addOutput(output(b.totalAmount,b.tokenid(),true));
            check(execute(b,renewal,true),"owner renewal rejected");
            check(!execute(b,renewal,false),"stranger renewed an offer");
            Transaction take=new Transaction();
            for(int p=0;p<8;p++)take.addStateVariable(new StateVariable(p,p==6?"1":c.stateAt(p)));
            take.addStateVariable(new StateVariable(8,"0xEE"));take.addStateVariable(new StateVariable(9,"0xFF"));
            take.addStateVariable(new StateVariable(10,"0xAABB"));take.addStateVariable(new StateVariable(11,"0"));
            take.addOutput(output(new MiniNumber(b.totalAmount).add(new MiniNumber(b.betAmount)).toString(),b.tokenid(),true));
            check(execute(b,take,false),"renewed offer cannot be taken");
            take.addStateVariable(new StateVariable(5,"999"));check(!execute(b,take,false),"taker can mutate stake");
        }
        System.out.println("6 production APK/JS plans identical; real KISS VM accepts owner renewal and subsequent take, rejects stranger renewal and changed terms; exact node maths and scaled-token outputs checked.");
    }
}
