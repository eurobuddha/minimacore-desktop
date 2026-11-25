package com.eurobuddha.wallet;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

import org.minima.objects.base.MiniNumber;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;

/**
 * CoinSelector — v1 greedy coin selection over OUR watched-address coins (the bundled-JSON {@code coins}
 * response). Deliberately simple and documented; a smarter selector (dust avoidance, privacy) is future
 * work.
 *
 * <h3>Strategy</h3>
 * <ul>
 *   <li><b>Send / Split</b> ({@link #selectToCover}) — filter to the target token, sort coins
 *       DESCENDING by raw amount, and greedily accumulate the largest coins until the running sum
 *       covers {@code requiredRaw} (= amount + native burn). Largest-first minimises the number of
 *       inputs (fewer signatures, smaller txn). Throws {@link InsufficientFundsException} if the total
 *       of all coins is still short.</li>
 *   <li><b>Consolidate</b> ({@link #selectSmallest}) — filter to the token, sort ASCENDING, and take the
 *       smallest {@code maxCoins} coins (the whole point of consolidation is to sweep up dust). Requires
 *       at least 3 (mirrors {@link TxnFactory#buildConsolidate}).</li>
 * </ul>
 *
 * <p>All amounts are RAW on-chain values ({@code coins[].amount}); the UI converts a human token amount
 * to raw before calling. Pure Java (bundled {@code org.minima.utils.json}) — unit-testable off-device.
 */
public final class CoinSelector {

    /** Hard cap on inputs in a single build (keeps the txn/PoW sane on mobile). */
    public static final int MAX_INPUTS = 20;

    public static final class InsufficientFundsException extends RuntimeException {
        public InsufficientFundsException(String zMsg) { super(zMsg); }
    }

    private CoinSelector() {}

    /**
     * Greedily select the fewest largest coins of {@code zTokenId} that cover {@code zRequiredRaw}.
     *
     * @throws InsufficientFundsException if all coins of the token still fall short, or if covering it
     *         would need more than {@link #MAX_INPUTS} coins.
     */
    public static List<JSONObject> selectToCover(JSONArray zCoins, String zTokenId, MiniNumber zRequiredRaw) {
        List<JSONObject> pool = filterByToken(zCoins, zTokenId);
        // Largest first.
        pool.sort(Collections.reverseOrder(byRawAmount()));

        List<JSONObject> chosen = new ArrayList<>();
        MiniNumber sum = MiniNumber.ZERO;
        for (JSONObject c : pool) {
            if (chosen.size() >= MAX_INPUTS) break;
            chosen.add(c);
            sum = sum.add(rawAmount(c));
            if (sum.isMoreEqual(zRequiredRaw)) {
                return chosen;
            }
        }
        // Not enough (or capped by MAX_INPUTS).
        MiniNumber poolTotal = MiniNumber.ZERO;
        for (JSONObject c : pool) poolTotal = poolTotal.add(rawAmount(c));
        if (poolTotal.isLess(zRequiredRaw)) {
            throw new InsufficientFundsException(
                    "Insufficient funds: have " + poolTotal + " need " + zRequiredRaw);
        }
        throw new InsufficientFundsException(
                "Too fragmented: covering " + zRequiredRaw + " needs more than " + MAX_INPUTS
              + " coins — consolidate first");
    }

    /**
     * Select up to {@code zMaxCoins} of the SMALLEST coins of {@code zTokenId} for consolidation.
     * @throws IllegalArgumentException if fewer than 3 coins of the token exist.
     */
    public static List<JSONObject> selectSmallest(JSONArray zCoins, String zTokenId, int zMaxCoins) {
        List<JSONObject> pool = filterByToken(zCoins, zTokenId);
        if (pool.size() < 3) {
            throw new IllegalArgumentException(
                    "Consolidate needs at least 3 coins of this token (have " + pool.size() + ")");
        }
        pool.sort(byRawAmount());   // smallest first
        int n = Math.min(zMaxCoins, Math.min(pool.size(), MAX_INPUTS));
        return new ArrayList<>(pool.subList(0, n));
    }

    /** Total RAW amount of a list of coins. */
    public static MiniNumber sumRaw(List<JSONObject> zCoins) {
        MiniNumber sum = MiniNumber.ZERO;
        for (JSONObject c : zCoins) sum = sum.add(rawAmount(c));
        return sum;
    }

    // ---------------------------------------------------------------------------------------------

    private static List<JSONObject> filterByToken(JSONArray zCoins, String zTokenId) {
        List<JSONObject> out = new ArrayList<>();
        if (zCoins == null) return out;
        boolean minima = Util.isMinima(zTokenId);
        for (Object o : zCoins) {
            JSONObject c = (JSONObject) o;
            String tid = String.valueOf(c.get("tokenid"));
            if (minima ? Util.isMinima(tid) : zTokenId.equals(tid)) {
                out.add(c);
            }
        }
        return out;
    }

    private static Comparator<JSONObject> byRawAmount() {
        return (a, b) -> rawAmount(a).compareTo(rawAmount(b));
    }

    private static MiniNumber rawAmount(JSONObject zCoin) {
        return new MiniNumber(String.valueOf(zCoin.get("amount")));
    }
}
