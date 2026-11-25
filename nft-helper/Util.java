package com.eurobuddha.nftwallet;
import org.json.JSONObject;
import java.math.BigDecimal;
final class Util {
    public static boolean isValidHexId(String id) {
        return id != null && ("0x00".equals(id) || id.matches("^0x[0-9a-fA-F]{2,64}$"));
    }
    public static boolean isValidAmount(String amt) {
        return amt != null && amt.matches("^[0-9]+(\\.[0-9]+)?$");
    }
}
