package com.eurobuddha.casino;
import java.util.*;
/** Runs the APK's real compiled classes; no Android UI or wallet calls. */
public class CasinoTimeoutParity {
    public static void main(String[] args) {
        for (String token : Arrays.asList("0x00", "USD"))
        for (int phase : new int[]{0,1,2,3})
        for (long age : new long[]{-1,0,9,10,11})
        for (String role : Arrays.asList("house", "player", "stranger", "both")) {
            Coin c = new Coin(); c.coinid="0x01"; c.tokenid=token; c.created=age<0?-1:100-age;
            c.state.put(0,"house"); c.state.put(2,"commit"); c.state.put(6,""+phase);
            c.state.put(7,"10"); c.state.put(8,"player");
            Set<String> keys = role.equals("both") ? new HashSet<>(Arrays.asList("house","player")) : Collections.singleton(role);
            System.out.println(new Bet(c).canClaimTimeout(keys,100));
        }
        System.out.println(CasinoContract.SCRIPT);
    }
}
