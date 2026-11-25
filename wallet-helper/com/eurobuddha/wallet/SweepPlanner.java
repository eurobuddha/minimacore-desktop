package com.eurobuddha.wallet;

import java.util.*;
import org.minima.objects.base.MiniNumber;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;

/** Standalone SweepFlow's planner, isolated for the integrated authenticated flow.
 * Original source commit690e9bc; preserve the same chunk limits and whole-token classification.
 * No UI, transport, signing or reservation mutation occurs here.
 */
final class SweepPlanner {

    // ponytail: conservative static chunking keeps every pooled txn under the 64K TxPoW cap
    // (4 sigs ≈ 34K + 10 inputs' node-attached proofs); measure real built sizes if sweeps
    // ever need fewer, bigger txns.
    static final int MAX_INPUTS_PER_TXN = 10;
    static final int MAX_KEYS_PER_TXN   = 4;

    /**
     * Byte-budget planning against the consensus TxPoW cap (64K, Magic.DEFAULT_TXPOW_SIZE).
     * txnpost refuses an oversized txn SYNCHRONOUSLY ("TxPoW size too large.. size/max"), so an
     * overshoot only burns signatures, never coins — but heavy coins (embedded-plate StateNFTs,
     * big sealed state) must still be planned around, not discovered. Each coin's serialized
     * size is measured locally; node-side additions are budgeted conservatively:
     * the coin appears again inside its MMR CoinProof (hence 2×), a classic WOTS signature
     * chain is ~8.4K, and header/outputs/scripts get fixed slack.
     */
    static final int TXN_BYTE_BUDGET = 48 * 1024;
    static final int SIG_BYTES       = 9 * 1024;   // signature chain + its script proof
    static final int INPUT_OVERHEAD  = 2 * 1024;   // MMR proof overhead per input
    static final int TXN_FIXED       = 4 * 1024;   // txpow header, magic, outputs, slack

    /** The standard fungible token script — the only script safe to spend pooled. */
    static final String PLAIN_TOKEN_SCRIPT = "RETURN TRUE";

    // =============================================================================================
    // Plan — pure, unit-testable
    // =============================================================================================

    /** addr(0x) -> wallet key index, or null when the address is not ours. */
    interface KeyLookup { Integer keyIndexFor(String zAddr0x); }

    /** One transaction to build: either a pooled send or a single whole-coin transfer. */
    static final class Job {
        final boolean whole;            // true = per-coin NFT/state transfer, false = pooled send
        final String tokenid;           // pooled: the token being sent (0x00 = Minima)
        final List<JSONObject> coins;   // the input coins (JSON, from act.coins())
        final String label;             // for progress + report
        final int estBytes;             // planned txpow size estimate
        Job(boolean zWhole, String zTokenid, List<JSONObject> zCoins, String zLabel, int zEst) {
            whole = zWhole; tokenid = zTokenid; coins = zCoins; label = zLabel; estBytes = zEst;
        }
    }

    static final class AssetTotal {
        final String tokenid, name, amount;
        AssetTotal(String tokenid,String name,String amount) {
            this.tokenid=tokenid;this.name=name;this.amount=amount;
        }
    }

    static final class Plan {
        final List<Job> jobs = new ArrayList<>();
        final List<String> skipped = new ArrayList<>();      // human reasons, one per skipped coin
        final List<String> oversizedWarnings = new ArrayList<>(); // singles estimated over budget
        // A list preserves distinct tokens with the same display name.
        final List<AssetTotal> totals = new ArrayList<>();
        int wholeItems, pendingCount, lockedCount;
        int signatures = 0;                                   // total WOTS leaves the plan consumes

        boolean isEmpty() { return jobs.isEmpty(); }

        /** Every coinid the plan will spend. */
        List<String> coinIds() {
            List<String> out = new ArrayList<>();
            for (Job j : jobs) for (JSONObject c : j.coins) out.add(Nft.str(c, "coinid"));
            return out;
        }
    }

    /**
     * Classify every owned coin into jobs. Per-coin whole transfers for anything carrying state
     * or a non-trivial token script (NFTs, StateNFTs, scripted tokens); pooled chunked sends for
     * plain fungible tokens and native Minima. Pure: no Android, no node.
     */
    static Plan plan(JSONArray zCoins, KeyLookup zKeys, Set<String> zPendingCoinIds) {
        Plan plan = new Plan();
        if (zCoins == null) return plan;
        // The review must own its data; a later balance/gallery refresh cannot rewrite its inputs.
        try { zCoins=(JSONArray)new org.minima.utils.json.parser.JSONParser().parse(zCoins.toString()); }
        catch(Exception invalid){throw new IllegalArgumentException("Invalid sweep coin list",invalid);}
        Set<String> seen=new HashSet<>();
        Set<String> pending=new HashSet<>();
        if(zPendingCoinIds!=null)for(String id:zPendingCoinIds)
            if(id!=null)pending.add(id.toLowerCase(Locale.ROOT));

        List<JSONObject> minima = new ArrayList<>();
        Map<String, List<JSONObject>> fungible = new LinkedHashMap<>();   // tokenid -> coins
        Map<String, String> fungibleNames = new LinkedHashMap<>();
        List<JSONObject> wholes = new ArrayList<>();
        MiniNumber minimaTotal = MiniNumber.ZERO;
        Map<String, MiniNumber> tokenTotals = new LinkedHashMap<>();

        for (Object o : zCoins) {
            if(!(o instanceof JSONObject))throw new IllegalArgumentException("Invalid sweep coin");
            JSONObject c = (JSONObject) o;
            String coinid = Nft.str(c, "coinid");
            String addr   = Nft.str(c, "address");
            if(coinid.isEmpty()||addr.isEmpty()||!seen.add(coinid.toLowerCase(java.util.Locale.ROOT)))
                throw new IllegalArgumentException("Duplicate or incomplete sweep coin");

            if (zKeys.keyIndexFor(addr) == null) {
                plan.skipped.add(coinid + " — address " + addr + " is not in this wallet");
                continue;
            }
            if (pending.contains(coinid.toLowerCase(Locale.ROOT))) {
                plan.pendingCount++;
                plan.skipped.add(coinid + " — already confirming from an earlier send");
                continue;
            }

            String tokenid = Nft.str(c, "tokenid");
            boolean hasState = hasValidatedState(c);
            if (Util.isMinima(tokenid) && !hasState) {
                minima.add(c);
                minimaTotal = minimaTotal.add(new MiniNumber(Nft.str(c, "amount")));
                continue;
            }

            JSONObject tokNode = (c.get("token") instanceof JSONObject) ? (JSONObject) c.get("token") : null;
            Nft.Meta meta = Nft.meta(tokNode);
            if (Nft.isUnstampedLocked(meta, c)) {
                plan.lockedCount++;
                plan.skipped.add(meta.name + " (" + coinid + ") — UNSTAMPED locked edition; the "
                        + "creator could reclaim it. Stamp it in NFT wallet first");
                continue;
            }

            boolean plainToken = normalizeScript(meta.script).equals(PLAIN_TOKEN_SCRIPT);
            if (hasState || !plainToken) {
                wholes.add(c);
            } else {
                fungible.computeIfAbsent(tokenid, k -> new ArrayList<>()).add(c);
                fungibleNames.put(tokenid, meta.name);
                MiniNumber disp = tokenTotals.getOrDefault(tokenid, MiniNumber.ZERO);
                String ta = Nft.str(c, "tokenamount");
                tokenTotals.put(tokenid, disp.add(new MiniNumber(ta.isEmpty() ? Nft.str(c, "amount") : ta)));
            }
        }

        // 1. NFTs / state / scripted coins — one transaction each, state replayed verbatim.
        //    Singles whose ESTIMATE exceeds the byte budget go LAST (attempted anyway — the
        //    estimate is conservative and a refusal cannot block the rest of the sweep).
        int nftCount = 0;
        List<Job> heavy = new ArrayList<>();
        for (JSONObject c : wholes) {
            JSONObject tokNode = (c.get("token") instanceof JSONObject) ? (JSONObject) c.get("token") : null;
            Nft.Meta meta = Nft.meta(tokNode);
            int idx = Nft.itemIndex(c);
            String label = Util.isMinima(Nft.str(c,"tokenid")) ? "Minima (state)" : meta.name + (idx >= 0 ? " #" + idx : "");
            int coinBytes = sizeOf(c);
            //Input coin + its copy inside the MMR CoinProof + the state replayed on the txn.
            int est = TXN_FIXED + 3 * coinBytes + INPUT_OVERHEAD + SIG_BYTES;
            Job j = new Job(true, Nft.str(c, "tokenid"), listOf(c), label, est);
            if (est > TXN_BYTE_BUDGET) {
                heavy.add(j);
                plan.oversizedWarnings.add(label + " (" + Nft.str(c, "coinid") + ") — estimated ~"
                        + (est / 1024) + "K against the chain's 64K transaction cap; it will be"
                        + " attempted last and reported honestly if the node refuses it");
            } else {
                plan.jobs.add(j);
            }
            plan.signatures++;
            nftCount++;
        }
        plan.wholeItems = nftCount;

        // 2. Plain fungible tokens — pooled, chunked.
        for (Map.Entry<String, List<JSONObject>> e : fungible.entrySet()) {
            String name = fungibleNames.get(e.getKey());
            plan.totals.add(new AssetTotal(e.getKey(),name,tokenTotals.get(e.getKey()).toString()));
            chunkInto(plan, e.getValue(), zKeys, e.getKey(), name);
        }

        // 3. Native Minima next.
        if (!minima.isEmpty()) {
            plan.totals.add(0,new AssetTotal(Util.MINIMA_TOKENID,"Minima",minimaTotal.toString()));
            chunkInto(plan, minima, zKeys, Util.MINIMA_TOKENID, "Minima");
        }

        // 4. Over-budget singles LAST — a refusal there can no longer block anything.
        plan.jobs.addAll(heavy);

        return plan;
    }

    /** Chunk a token's coins into pooled jobs: same-address coins grouped (one signature covers
     *  them all), at most {@link #MAX_KEYS_PER_TXN} keys, {@link #MAX_INPUTS_PER_TXN} inputs,
     *  AND an estimated {@link #TXN_BYTE_BUDGET} bytes per transaction. */
    private static void chunkInto(Plan zPlan, List<JSONObject> zCoins, KeyLookup zKeys,
                                  String zTokenid, String zName) {
        // Group same-address coins together so each chunk needs the fewest signatures.
        zCoins.sort((a, b) -> Nft.str(a, "address").compareTo(Nft.str(b, "address")));

        List<JSONObject> chunk = new ArrayList<>();
        List<String> chunkAddrs = new ArrayList<>();
        int chunkBytes = 0;
        int part = 1;
        for (JSONObject c : zCoins) {
            String addr = Nft.str(c, "address");
            boolean newKey = !chunkAddrs.contains(addr);
            int coinCost = 2 * sizeOf(c) + INPUT_OVERHEAD;   // coin in txn + copy in its MMR proof
            int addCost  = coinCost + (newKey ? SIG_BYTES : 0);
            if (!chunk.isEmpty()
                    && (chunk.size() >= MAX_INPUTS_PER_TXN
                        || (newKey && chunkAddrs.size() >= MAX_KEYS_PER_TXN)
                        || TXN_FIXED + chunkBytes + addCost > TXN_BYTE_BUDGET)) {
                zPlan.jobs.add(new Job(false, zTokenid, chunk, zName + " (part " + part++ + ")",
                        TXN_FIXED + chunkBytes));
                zPlan.signatures += chunkAddrs.size();
                chunk = new ArrayList<>();
                chunkAddrs = new ArrayList<>();
                chunkBytes = 0;
            }
            chunk.add(c);
            chunkBytes += 2 * sizeOf(c) + INPUT_OVERHEAD
                    + (chunkAddrs.contains(addr) ? 0 : SIG_BYTES);
            if (!chunkAddrs.contains(addr)) chunkAddrs.add(addr);
        }
        if (!chunk.isEmpty()) {
            zPlan.jobs.add(new Job(false, zTokenid, chunk,
                    part == 1 ? zName : zName + " (part " + part + ")", TXN_FIXED + chunkBytes));
            zPlan.signatures += chunkAddrs.size();
        }
    }

    /** This coin's serialized byte size, measured from its own data (state and token included).
     *  Falls back to a safe default when the JSON cannot be reconstructed locally. */
    static int sizeOf(JSONObject zCoin) {
        try {
            return org.minima.objects.base.MiniData
                    .getMiniDataVersion(TxnFactory.fromCoinJson(zCoin, 0).toCoin()).getLength();
        } catch (Exception e) {
            return 1024;
        }
    }

    /** Display parsing is intentionally tolerant; sweep must never discard malformed state. */
    private static boolean hasValidatedState(JSONObject coin) {
        if(!coin.containsKey("state"))return false;
        Object state=coin.get("state");
        int expected;
        if(state instanceof JSONArray) {
            expected=((JSONArray)state).size();
            for(Object entry:(JSONArray)state) {
                if(!(entry instanceof JSONObject)
                    || !(((JSONObject)entry).get("data") instanceof String))
                    throw new IllegalArgumentException("Invalid sweep state entry");
            }
        } else if(state instanceof JSONObject) {
            expected=((JSONObject)state).size();
            for(Object value:((JSONObject)state).values())
                if(!(value instanceof String))throw new IllegalArgumentException("Invalid sweep state data");
        } else throw new IllegalArgumentException("Invalid sweep state");
        List<String[]> entries=Nft.rawStateEntries(coin);
        if(entries.size()!=expected)throw new IllegalArgumentException("Incomplete sweep state");
        Set<Integer> ports=new HashSet<>();
        for(String[] entry:entries) {
            if(!entry[0].matches("[0-9]{1,3}"))throw new IllegalArgumentException("Invalid sweep state port");
            int port=Integer.parseInt(entry[0]);
            if(port>255 || !ports.add(port))throw new IllegalArgumentException("Duplicate or invalid sweep state port");
        }
        return !entries.isEmpty();
    }

    /** Split a pooled job in half (used when the node refuses it as too large). */
    static List<Job> split(Job zJob) {
        if(zJob.whole||zJob.coins.size()<2)throw new IllegalArgumentException("Cannot split a whole or single coin");
        List<Job> out = new ArrayList<>(2);
        int mid = zJob.coins.size() / 2;
        out.add(new Job(false, zJob.tokenid, new ArrayList<>(zJob.coins.subList(0, mid)),
                zJob.label + " (split A)", zJob.estBytes / 2));
        out.add(new Job(false, zJob.tokenid, new ArrayList<>(zJob.coins.subList(mid, zJob.coins.size())),
                zJob.label + " (split B)", zJob.estBytes / 2));
        return out;
    }

    /** Collapse whitespace + trim so formatting differences never misclassify a plain script. */
    static String normalizeScript(String zScript) {
        return zScript == null ? "" : zScript.trim().replaceAll("\\s+", " ").toUpperCase(Locale.ROOT);
    }

    private static List<JSONObject> listOf(JSONObject c) {
        List<JSONObject> l = new ArrayList<>(1);
        l.add(c);
        return l;
    }

}
