package com.eurobuddha.nftwallet;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class StateNft {
    public static final String GRAVEYARD =
            "0xABA005476D2B3CD7F251B9783E64C124C9670BB358695F04D91B2057BB64CB49";

    private static final Pattern LEGACY_SCRIPT = Pattern.compile(
            "^IF SIGNEDBY\\((0x[0-9A-Fa-f]+)\\) THEN RETURN TRUE ENDIF RETURN VERIFYOUT\\(@INPUT GETOUTADDR\\(@INPUT\\) @AMOUNT @TOKENID TRUE\\)$");
    private static final Pattern LOCKED_SCRIPT = Pattern.compile(
            "^LET s=PREVSTATE\\(0\\) IF s EQ 0 AND SIGNEDBY\\((0x[0-9A-Fa-f]+)\\) THEN RETURN TRUE ENDIF RETURN SAMESTATE\\(0 [01]\\) AND VERIFYOUT\\(@INPUT GETOUTADDR\\(@INPUT\\) @AMOUNT @TOKENID TRUE\\)$");

    private StateNft() {}

    /**
     * True for a coin that has been buried — it sits at the graveyard address.
     *
     * The node keeps returning these from {@code coins relevant:true} after a burial, because it
     * still tracks the coin. {@code balance} does not count them, so a buried collection vanished
     * from the Balances tab (token-driven) while the Gallery (coin-driven) went on showing every
     * buried item as though you still held it. Filtered at ingestion so no screen has to remember.
     */


    public static class Meta {
        public String tokenid = "";
        public String name = "Collection";
        public String description = "";
        public String mode = "url";
        public int size = 0;
        public String base = "";
        public String ext = ".png";
        public String icon = "";
        public String externalUrl = "";
        public String webvalidate = "";
        public String creatorPk = "";
        public String creatorAddr = "";
        public String phase = "DONE";
        public String error = "";
        public long localId = 0;
        public int posted = 0;
        public int postedAt = 0;
        public boolean creator = false;
        public boolean created = false;
        public boolean webValid = false;
        public int owned = 0;
        public int minted = 0;
        public int totalSeen = 0;
    }

    public static class Item {
        public int index;
        public JSONObject coin;
        public String imageUrl = "";
        public boolean owned;
    }

    public static Meta parseMeta(String tokenid, Object tokenNode) {
        Meta m = new Meta();
        m.tokenid = tokenid == null ? "" : tokenid;
        JSONObject root = TokenMeta.asObject(tokenNode);
        // `tokens tokenid:` returns an ENVELOPE — {token:{name:{…},totalamount},script} — while a
        // balance row hands us the token record directly. Unwrap so either shape parses.
        JSONObject envelope = null;
        JSONObject nested = root == null ? null : TokenMeta.asObject(root.opt("token"));
        if (nested != null) {
            envelope = root;
            root = nested;
        }
        JSONObject meta = root == null ? null : TokenMeta.asObject(root.opt("name"));
        JSONObject src = meta != null ? meta : root;
        if (src != null) {
            m.name = first(src.optString("name", ""), "Collection");
            m.description = first(src.optString("description", ""), root.optString("description", ""));
            m.mode = first(src.optString("mode", ""), root.optString("mode", ""), src.optString("base", "").isEmpty() ? "embed" : "url");
            m.size = firstInt(src.opt("size"), root.opt("size"), root.opt("total"),
                    root.opt("totalamount"), root.opt("amount"),
                    envelope == null ? null : envelope.opt("total"),
                    envelope == null ? null : envelope.opt("totalamount"));
            m.base = first(src.optString("base", ""), root.optString("base", ""));
            m.ext = first(src.optString("ext", ""), root.optString("ext", ""), ".png");
            m.icon = first(src.optString("url", ""), root.optString("url", ""), src.optString("icon", ""), root.optString("icon", ""));
            m.externalUrl = first(src.optString("external_url", ""), root.optString("external_url", ""));
            m.webvalidate = first(src.optString("webvalidate", ""), root.optString("webvalidate", ""));
        } else if (tokenNode instanceof String) {
            m.name = (String) tokenNode;
        }
        return m;
    }

    public static boolean isCandidate(Meta m) {
        if (m == null || m.size <= 0) return false;
        return "embed".equals(m.mode) || "url".equals(m.mode) || !m.base.isEmpty();
    }

    public static String creatorPk(String script) {
        Matcher a = LOCKED_SCRIPT.matcher(script == null ? "" : script);
        if (a.matches()) return a.group(1);
        Matcher b = LEGACY_SCRIPT.matcher(script == null ? "" : script);
        if (b.matches()) return b.group(1);
        return "";
    }

    public static boolean isStateNftScript(String script) {
        return !creatorPk(script).isEmpty();
    }

    public static String script(String pk, String mode) {
        String range = "url".equals(mode) ? "0 0" : "0 1";
        return "LET s=PREVSTATE(0) IF s EQ 0 AND SIGNEDBY(" + pk + ") THEN RETURN TRUE ENDIF "
                + "RETURN SAMESTATE(" + range + ") AND "
                + "VERIFYOUT(@INPUT GETOUTADDR(@INPUT) @AMOUNT @TOKENID TRUE)";
    }

    /** Estimated on-chain token-definition weight at mint time: icon + name +
     *  description + external URL + ~900 chars of script/JSON scaffolding.
     *  Definitions past ~10.5K (estimated) cannot split reliably under the
     *  64KB TxPoW cap even at unit+change — the definition is IMMUTABLE after
     *  tokencreate, so such a mint must be refused before it exists. Shared
     *  calibration with Atelier (measured: an 18.4KB definition failed all
     *  splits; estimate-to-actual runs ~1.55x). */
    /* ---- the JOINT transfer budget (ported from Atelier 4.1.10) ----
     * A sealed transfer carries the token record TWICE and the embedded
     * image TWICE plus a multi-KB signature, all under the 64KB TxPoW cap.
     * And the creator signature (signtype/signedby/signature, ~8.4KB) lands
     * in the record AFTER tokencreate — invisible to any estimate of the
     * metadata alone. Atelier's 'Math' passed every estimator at ~10K and
     * sealed at 18.4K, past the split bound, untransferable forever. These
     * are the exact bounds, measured on-chain. */
    public static final int TRANSFER_PAIR_BUDGET = 19500;  // 20000 combined CONFIRMED on-chain 2026-08-10 (21000 failed) − 500 margin
    public static final int DEF_WRAPPER = 533;             // fullDef - len(metaJSON)
    public static final int DEF_SPLIT_MAX = 17300;         // 3 records + sig under 64KB
    public static final int DEF_SIGN_WEIGHT = 8400;        // signtype+signedby+signature

    /** Exact record length this Meta would seal (metadata JSON + wrapper). */
    public static int defActualLen(Meta m) {
        return tokenMetadata(m).toString().length() + DEF_WRAPPER + DEF_SIGN_WEIGHT;  // ALWAYS signed
    }

    /** metaLen ceiling with the signature ALWAYS aboard. */
    public static final int META_MAX = DEF_SPLIT_MAX - DEF_WRAPPER - DEF_SIGN_WEIGHT;  // 8367

    /** ALWAYS SIGNED: image room the signed record leaves, or -1 when the
     *  record alone cannot split. */
    public static int imageBudget(int metaLen) {
        if (metaLen > META_MAX) return -1;
        return TRANSFER_PAIR_BUDGET - DEF_WRAPPER - DEF_SIGN_WEIGHT - metaLen;
    }

    /** Sign-or-error. The nosign branch is DELETED project-wide — never
     *  reintroduce it: unsigned mints silently trade the creator's
     *  provenance away. */
    public static String jointGate(int metaLen, int maxImg) {
        int room = imageBudget(metaLen);
        if (room < 0) {
            return "record " + (metaLen + DEF_WRAPPER + DEF_SIGN_WEIGHT)
                 + "B signed cannot split under the 64KB cap (metadata " + metaLen
                 + "B > " + META_MAX + "B) — shorter text or a hosted icon";
        }
        if (maxImg > room) {
            return "largest image " + maxImg + "B exceeds the " + room
                 + "B image budget the signed record leaves — smaller images or a lighter record";
        }
        return "sign";
    }

    public static JSONObject tokenMetadata(Meta m) {
        JSONObject meta = new JSONObject();
        put(meta, "name", m.name);
        put(meta, "description", m.description == null ? "" : m.description);
        put(meta, "mode", m.mode);
        put(meta, "size", m.size);
        if ("url".equals(m.mode)) {
            put(meta, "base", m.base == null ? "" : m.base);
            put(meta, "ext", m.ext == null || m.ext.isEmpty() ? ".png" : m.ext);
        }
        if (m.icon != null && !m.icon.isEmpty()) {
            boolean http = m.icon.startsWith("http");
            // Token metadata rides in EVERY transaction touching the token. An oversized embedded
            // icon pushes those transactions past the 64KB TxPoW cap — and metadata is immutable,
            // so the collection is bricked at creation. Drop the icon rather than seal that.
            if (http || m.icon.length() <= ImageTools.ICON_BUDGET) {
                // The closing tag matters: IconResolver's regex requires it, and without it every
                // embedded icon we minted fell through to an identicon.
                put(meta, "url", http ? m.icon : "<artimage>" + m.icon + "</artimage>");
            }
        }
        if (m.externalUrl != null && !m.externalUrl.isEmpty()) put(meta, "external_url", m.externalUrl);
        return meta;
    }

    /**
     * Read a state port for INTERPRETATION (index, embedded image).
     *
     * Deliberately lenient about shape, because what the node returns varies: ports arrive as ints
     * or strings, the state as an array of {port,data} or as a plain {port:data} map, and string
     * values are sometimes quoted. Anything that MUTATES chain state uses {@link #rawStateEntries}
     * and stays byte-exact — this leniency must never leak into what we write back.
     */
    public static String state(JSONObject coin, int port) {
        for (String[] e : rawStateEntries(coin)) {
            if (e[0].equals(String.valueOf(port))) return unquote(e[1]);
        }
        return null;
    }

    /** Surrounding double quotes are a transport artefact, not part of the value. */
    private static String unquote(String v) {
        if (v != null && v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            return v.substring(1, v.length() - 1);
        }
        return v;
    }

    /**
     * Every state entry as {port, data} VERBATIM — no unquoting, no coercion. The transfer/bury
     * replay writes these back, so they must reproduce the chain exactly. Handles both the array
     * form and the {port:data} object form.
     */
    public static List<String[]> rawStateEntries(JSONObject coin) {
        List<String[]> out = new ArrayList<>();
        if (coin == null) return out;
        JSONArray arr = coin.optJSONArray("state");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.optJSONObject(i);
                if (s == null) continue;
                out.add(new String[]{ String.valueOf(s.opt("port")), String.valueOf(s.opt("data")) });
            }
            return out;
        }
        JSONObject obj = coin.optJSONObject("state");
        if (obj != null) {
            JSONArray names = obj.names();
            if (names != null) {
                for (int i = 0; i < names.length(); i++) {
                    String k = names.optString(i);
                    out.add(new String[]{ k, String.valueOf(obj.opt(k)) });
                }
            }
        }
        return out;
    }

    public static String stamped(JSONObject coin) {
        String s0 = state(coin, 0);
        return s0 != null && !"0".equals(s0) ? s0 : null;
    }

    /**
     * The coin's token amount, or "" when it isn't a plain decimal. Amounts are interpolated into
     * commands, so a synthetic coin carrying "1 burn:9999" must not build a transaction — callers
     * pair this with {@link #replayableState} and the id gate; an empty amount makes txncheck fail
     * before anything is signed.
     */
    public static String safeAmount(JSONObject coin) {
        String a = coin == null ? "" : coin.optString("tokenamount", "1");
        return a.matches("^[0-9]+(\\.[0-9]+)?$") ? a : "";
    }

    public static boolean safeStateValue(Object v) {
        String s = String.valueOf(v);
        return s.matches("^[0-9]+$") || s.matches("^\\[[A-Za-z0-9+/=]*\\]$");
    }

    public static boolean replayableState(JSONObject coin) {
        for (String[] e : rawStateEntries(coin)) {
            if (!e[0].matches("^[0-9]+$") || !safeStateValue(e[1])) return false;
        }
        return true;
    }

    public static String imageUrl(Meta meta, int idx, JSONObject coin) {
        String embedded = state(coin, 1);
        if (embedded != null && embedded.startsWith("[") && embedded.endsWith("]")) {
            // Sniff the payload rather than assuming: plates are WebP now, were JPEG before, and
            // may be SVG. A hardcoded label is wrong for two of those three.
            return ImageTools.dataUri(embedded.substring(1, embedded.length() - 1));
        }
        if (meta != null && !meta.base.isEmpty()) return meta.base + idx + (meta.ext == null ? "" : meta.ext);
        return meta == null ? "" : meta.icon;
    }

    public static List<Item> items(Meta meta, JSONArray ownedCoins, JSONArray allCoins) {
        java.util.Map<String, JSONObject> byIndex = new java.util.LinkedHashMap<>();
        java.util.HashSet<String> ownedIds = new java.util.HashSet<>();
        if (ownedCoins != null) {
            for (int i = 0; i < ownedCoins.length(); i++) {
                JSONObject c = ownedCoins.optJSONObject(i);
                if (c == null) continue;
                ownedIds.add(c.optString("coinid", ""));
                String idx = stamped(c);
                if (idx != null && idx.matches("^[0-9]+$")) byIndex.put(idx, c);
            }
        }
        if (allCoins != null) {
            for (int i = 0; i < allCoins.length(); i++) {
                JSONObject c = allCoins.optJSONObject(i);
                if (c == null) continue;
                String idx = stamped(c);
                if (idx != null && idx.matches("^[0-9]+$") && !byIndex.containsKey(idx)) byIndex.put(idx, c);
            }
        }
        List<Item> out = new ArrayList<>();
        int size = meta == null ? 0 : Math.max(0, meta.size);
        for (int i = 1; i <= size; i++) {
            JSONObject c = byIndex.get(String.valueOf(i));
            Item it = new Item();
            it.index = i;
            it.coin = c;
            it.owned = c != null && ownedIds.contains(c.optString("coinid", ""));
            it.imageUrl = imageUrl(meta, i, c);
            out.add(it);
        }
        return out;
    }

    public static List<String> transferCommands(String txn, String tokenid, JSONObject coin, String to) {
        List<String> cmds = new ArrayList<>();
        // Pre-delete: the txn id is deterministic per coin, so a previous abnormal exit would
        // otherwise leave a stale txn and fail txncreate on the next attempt.
        cmds.add("txndelete id:" + txn);
        cmds.add("txncreate id:" + txn);
        cmds.add("txninput id:" + txn + " coinid:" + coin.optString("coinid"));
        // The unit's real amount — hardcoding 1 builds an unbalanced txn on any coin holding more,
        // which posts "fine" and is silently rejected on-chain.
        cmds.add("txnoutput id:" + txn + " amount:" + safeAmount(coin)
                + " address:" + to + " tokenid:" + tokenid + " storestate:true");
        for (String[] e : rawStateEntries(coin)) {
            cmds.add("txnstate id:" + txn + " port:" + e[0] + " value:" + e[1]);
        }
        // Balance check BEFORE signing — an unbalanced txn posts "fine" and is rejected on-chain.
        cmds.add("txncheck id:" + txn);
        cmds.add("txnsign id:" + txn + " publickey:auto");
        cmds.add("txnbasics id:" + txn);
        cmds.add("txnpost id:" + txn);
        return cmds;
    }

    public static List<String> buryCommands(String txn, String tokenid, String creatorPk, JSONObject coin, boolean preserve) {
        List<String> cmds = new ArrayList<>();
        cmds.add("txndelete id:" + txn);
        cmds.add("txncreate id:" + txn);
        cmds.add("txninput id:" + txn + " coinid:" + coin.optString("coinid"));
        cmds.add("txnoutput id:" + txn + " amount:" + safeAmount(coin)
                + " address:" + GRAVEYARD + " tokenid:" + tokenid + " storestate:" + (preserve ? "true" : "false"));
        if (preserve) {
            for (String[] e : rawStateEntries(coin)) {
                cmds.add("txnstate id:" + txn + " port:" + e[0] + " value:" + e[1]);
            }
        }
        cmds.add("txncheck id:" + txn);
        cmds.add("txnsign id:" + txn + " publickey:auto");
        if (!creatorPk.isEmpty() && (!preserve || stamped(coin) == null)) {
            cmds.add("txnsign id:" + txn + " publickey:" + creatorPk);
        }
        cmds.add("txnbasics id:" + txn);
        cmds.add("txnpost id:" + txn);
        return cmds;
    }

    private static String first(String... vals) {
        for (String v : vals) if (v != null && !v.isEmpty()) return v;
        return "";
    }

    private static int firstInt(Object... vals) {
        for (Object v : vals) {
            if (v == null) continue;
            if (v instanceof Number) return ((Number) v).intValue();
            try {
                String s = String.valueOf(v).trim();
                if (!s.isEmpty()) return Integer.parseInt(s);
            } catch (Exception ignored) {}
        }
        return 0;
    }

    private static void put(JSONObject o, String k, Object v) {
        try { o.put(k, v); } catch (Exception ignored) {}
    }
}
