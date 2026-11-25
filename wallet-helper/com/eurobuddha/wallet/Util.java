package com.eurobuddha.wallet;

final class Util {
    static final String MINIMA_TOKENID = "0x00";
    public static boolean isMinima(String tokenid) {
        return tokenid == null || MINIMA_TOKENID.equals(tokenid);
    }
}
