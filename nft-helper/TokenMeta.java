package com.eurobuddha.nftwallet;
import org.json.JSONObject;
import java.math.BigDecimal;
final class TokenMeta {
    static JSONObject asObject(Object value) {
        if (value == null || value == JSONObject.NULL) return null;
        if (value instanceof JSONObject) return (JSONObject) value;
        String text = value.toString().trim();
        if (text.startsWith("{")) {
            try { return new JSONObject(text); }
            catch (org.json.JSONException ignored) { }
        }
        return null;
    }
}
