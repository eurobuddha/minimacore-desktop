package com.eurobuddha.wallet;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.minima.objects.base.MiniData;
import org.minima.objects.base.MiniNumber;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;

/**
 * Aggregates the raw {@code coins} response for OUR watched address(es) into a per-token summary for
 * the Balances page.
 *
 * <p><b>Why not the node's {@code balance} command (or {@code sendable})?</b> {@code balance}'s
 * {@code sendable} counts only coins whose script is {@code RETURN TRUE}. Our coins are guarded by
 * {@code RETURN SIGNEDBY(<pubkey>)} — we hold the key, so for us every confirmed coin is spendable —
 * but the node would report them as unsendable. So we aggregate the {@code coins relevant:true
 * address:<ours>} response ourselves: group by tokenid, sum, count. Confirmed == spendable for us; we
 * never rely on the node's {@code sendable} flag.
 *
 * <p>Two totals are kept per token:
 * <ul>
 *   <li><b>raw</b> — {@code sum(Coin.getAmount())}, the on-chain unit used for spend math (what
 *       {@link TxnFactory} consumes; native Minima and token alike).</li>
 *   <li><b>display</b> — {@code sum(tokenamount)} when the coin carries a token (the node's
 *       already-scaled human amount), else {@code sum(amount)}. This is what the balance card shows,
 *       so we never re-implement token scaling.</li>
 * </ul>
 *
 * <p>Pure Java (bundled {@code org.minima.utils.json}), so it is unit-testable off-device.
 */
public final class CoinAggregator {

    /** The native Minima token id. */
    public static final String MINIMA_TOKENID = "0x00";

    /** One token's aggregate across our coins. */
    public static final class Agg {
        /** Token id (0x hex); {@code 0x00} for native Minima. */
        public final String tokenid;
        /** Sum of RAW on-chain amounts ({@code Coin.getAmount()}). Spend math uses this. */
        public final MiniNumber rawTotal;
        /** Sum of DISPLAY amounts (node-scaled {@code tokenamount}; == raw for Minima). */
        public final MiniNumber displayTotal;
        /** Number of unspent coins of this token at our address. */
        public final int count;
        /** The token descriptor JSON ({@code Coin.toJSON().token}); null for native Minima. */
        public final JSONObject tokenJson;

        Agg(String zTokenid, MiniNumber zRaw, MiniNumber zDisplay, int zCount, JSONObject zTokenJson) {
            tokenid      = zTokenid;
            rawTotal     = zRaw;
            displayTotal = zDisplay;
            count        = zCount;
            tokenJson    = zTokenJson;
        }

        public boolean isMinima() {
            return MINIMA_TOKENID.equals(tokenid) || new MiniData(tokenid).isEqual(new MiniData(MINIMA_TOKENID));
        }
    }

    private CoinAggregator() {}

    /**
     * Aggregate a {@code coins} response array (each element a {@code Coin.toJSON()} object). Native
     * Minima is always listed first (if present); the remaining tokens follow in first-seen order.
     */
    public static List<Agg> aggregate(JSONArray zCoins) {
        //Accumulators keyed by canonical tokenid string.
        LinkedHashMap<String, MiniNumber> raw     = new LinkedHashMap<>();
        LinkedHashMap<String, MiniNumber> display = new LinkedHashMap<>();
        LinkedHashMap<String, Integer>    counts  = new LinkedHashMap<>();
        LinkedHashMap<String, JSONObject> tokens  = new LinkedHashMap<>();

        if (zCoins != null) {
            for (Object o : zCoins) {
                JSONObject coin = (JSONObject) o;

                String tokenid = str(coin.get("tokenid"), MINIMA_TOKENID);
                MiniNumber amount = new MiniNumber(str(coin.get("amount"), "0"));

                //Display amount: tokenamount when present (node already scaled it), else raw amount.
                Object tokenamount = coin.get("tokenamount");
                MiniNumber disp = (tokenamount != null) ? new MiniNumber(String.valueOf(tokenamount)) : amount;

                MiniNumber r = raw.get(tokenid);
                raw.put(tokenid, r == null ? amount : r.add(amount));
                MiniNumber d = display.get(tokenid);
                display.put(tokenid, d == null ? disp : d.add(disp));
                Integer c = counts.get(tokenid);
                counts.put(tokenid, c == null ? 1 : c + 1);

                if (!tokens.containsKey(tokenid)) {
                    Object tok = coin.get("token");
                    tokens.put(tokenid, (tok instanceof JSONObject) ? (JSONObject) tok : null);
                }
            }
        }

        //Emit Minima first, then the rest in first-seen order.
        List<Agg> out = new ArrayList<>();
        if (counts.containsKey(MINIMA_TOKENID)) {
            out.add(build(MINIMA_TOKENID, raw, display, counts, tokens));
        }
        for (String tokenid : counts.keySet()) {
            if (MINIMA_TOKENID.equals(tokenid)) continue;
            out.add(build(tokenid, raw, display, counts, tokens));
        }
        return out;
    }

    private static Agg build(String tokenid,
                             Map<String, MiniNumber> raw, Map<String, MiniNumber> display,
                             Map<String, Integer> counts, Map<String, JSONObject> tokens) {
        return new Agg(tokenid, raw.get(tokenid), display.get(tokenid), counts.get(tokenid), tokens.get(tokenid));
    }

    private static String str(Object v, String zDefault) {
        return (v == null) ? zDefault : String.valueOf(v);
    }
}
