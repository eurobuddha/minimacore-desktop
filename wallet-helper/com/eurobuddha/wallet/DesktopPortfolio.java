package com.eurobuddha.wallet;

import java.util.Collections;
import java.util.List;
import org.minima.objects.base.MiniNumber;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;

/** Public-data adapter for the integrated Android wallet's pure planners. */
public final class DesktopPortfolio {
    public static JSONObject run(JSONObject request) {
        JSONArray coins = (JSONArray) request.get("coins");
        JSONObject result = new JSONObject();
        JSONArray totals = new JSONArray();
        for (CoinAggregator.Agg a : CoinAggregator.aggregate(coins)) {
            JSONObject item = new JSONObject();
            item.put("tokenid", a.tokenid);
            item.put("amount", a.displayTotal.toString());
            item.put("count", a.count);
            item.put("token", a.tokenJson);
            totals.add(item);
        }
        result.put("balances", totals);
        if ("summary".equals(request.get("action"))) return result;

        JSONObject indices = (JSONObject) request.get("indices");
        SweepPlanner.Plan sweep = SweepPlanner.plan(coins, addr ->
                indices.containsKey(addr) ? ((Number)indices.get(addr)).intValue() : null,
                Collections.emptySet());
        JSONArray jobs = new JSONArray();
        if ("sweep".equals(request.get("kind"))) {
            for (SweepPlanner.Job j : sweep.jobs) jobs.add(job(j.coins, j.tokenid, j.whole, null));
        } else {
            String token = request.getString("tokenid");
            MiniNumber display = new MiniNumber(request.getString("amount"));
            JSONArray eligible = new JSONArray();
            for (SweepPlanner.Job j : sweep.jobs)
                if (!j.whole && j.tokenid.equals(token)) eligible.addAll(j.coins);
            if (eligible.isEmpty()) throw new IllegalArgumentException("Insufficient funds");
            MiniNumber raw = display;
            if (!Util.isMinima(token)) {
                org.minima.objects.Token descriptor = TxnFactory.fromCoinJson((JSONObject)eligible.get(0), 0).getToken();
                raw = descriptor.getScaledMinimaAmount(display);
                if (!descriptor.getScaledTokenAmount(raw).isEqual(display)) throw new IllegalArgumentException("Invalid precision");
            }
            jobs.add(job(CoinSelector.selectToCover(eligible, token, raw), token, false, display.toString()));
        }
        result.put("jobs", jobs);
        result.put("skipped", sweep.skipped);
        return result;
    }

    private static JSONObject job(List<JSONObject> coins, String token, boolean whole, String payment) {
        JSONObject out = new JSONObject();
        JSONArray ids = new JSONArray();
        MiniNumber sum = MiniNumber.ZERO;
        for (JSONObject c : coins) {
            ids.add(c.get("coinid"));
            sum = sum.add(new MiniNumber(c.getString(Util.isMinima(token) ? "amount" : "tokenamount")));
        }
        out.put("coinids", ids);
        out.put("amount", payment == null ? sum.toString() : payment);
        out.put("total", sum.toString());
        out.put("tokenid", token);
        out.put("whole", whole);
        return out;
    }
}
