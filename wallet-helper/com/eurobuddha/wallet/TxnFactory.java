package com.eurobuddha.wallet;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import org.minima.objects.Address;
import org.minima.objects.Coin;
import org.minima.objects.StateVariable;
import org.minima.objects.Token;
import org.minima.objects.Transaction;
import org.minima.objects.Witness;
import org.minima.objects.base.MiniData;
import org.minima.objects.base.MiniNumber;
import org.minima.objects.base.MiniString;
import org.minima.objects.keys.Signature;
import org.minima.objects.mmr.MMREntryNumber;
import org.minima.database.userprefs.txndb.TxnRow;
import org.minima.system.brains.TxPoWGenerator;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;

/**
 * TxnFactory — builds a complete, locally-signed {@link Transaction}+{@link Witness}, serialized to
 * the {@code txnimport} MiniData hex, for the three v1 wallet operations (send / split / consolidate).
 *
 * <p>It mirrors the node's own build sequence in
 * {@code org.minima.system.commands.send.send}/{@code sendnosign} (input coins → output coins →
 * change → {@link TxPoWGenerator#precomputeTransactionCoinID} → {@link Transaction#calculateTransactionID}
 * → sign → witness), with two deliberate differences dictated by our self-custodial, node-relay model:
 *
 * <ol>
 *   <li><b>We sign locally</b> via {@link WalletCore#signTransactionID} (one one-time WOTS leaf per
 *       distinct input address), instead of the node wallet's {@code signData}.</li>
 *   <li><b>The witness carries SIGNATURES ONLY</b> — no {@code CoinProof}s (MMR proofs) AND no
 *       {@code ScriptProof}s. The node adds BOTH the MMR proofs and the scripts from its own tip MMR at
 *       {@code txnbasics} time (see {@code txnutils.setMMRandScripts}), then we {@code txnpost} WITHOUT
 *       {@code auto}. The WOTS signature covers only the transaction ID (which excludes the witness), so
 *       adding proofs+scripts after signing keeps the signatures valid. We must NOT pre-attach proofs or
 *       scripts: {@code Witness.addCoinProof} has no dedup, so a pre-existing proof (or {@code auto:true})
 *       would duplicate the MMR proof and make the transaction invalid.</li>
 * </ol>
 *
 * <h3>Units — RAW on-chain amounts</h3>
 * All {@link MiniNumber} amounts here are <b>raw on-chain values</b>, i.e. exactly {@code Coin.getAmount()}
 * as returned by the node's {@code coins} query. For native Minima ({@code 0x00}) these equal the
 * displayed amount. For custom tokens the raw value is the <i>scaled-down Minima amount</i>; the UI
 * layer (M2+) is responsible for converting a human token amount to raw units via
 * {@code Token.getScaledMinimaAmount(...)} before calling this factory. The factory does NO decimal
 * scaling — this keeps it provably identical to what is serialized and avoids re-implementing token
 * math. (This is the "require inputs already in raw units" option; see the M1 plan.)
 *
 * <h3>Burn handling</h3>
 * For native Minima a burn is <b>built into the transaction</b> as the input−output difference: we add
 * {@code burn} to the amount our inputs must cover and simply do NOT emit an output for it
 * ({@code Transaction.getBurn() == inputs − outputs}). It is therefore NOT passed on {@code txnpost}.
 * Passing {@code burn:} on {@code txnpost} would instead make the node build a <i>separate</i> burn
 * transaction funded and signed by the NODE's own wallet ({@code txnutils.createBurnTransaction}),
 * which our self-custodial wallet must not rely on. Burning while spending a custom token would need
 * an extra self-funded Minima input + linked burn txn — deferred past M1; token operations here
 * require {@code burn == 0}.
 */
public class TxnFactory {

    /** Maximum number of split output coins (mirrors {@code GeneralParams.MAX_SPLIT_COINS}). */
    public static final int MAX_SPLIT_COINS = 20;

    /** The native Minima token id. */
    public static final MiniData TOKEN_MINIMA = new MiniData("0x00");

    /**
     * A parsed unspent input coin, as returned by the node's {@code coins} query. Carries exactly the
     * fields the node needs to re-find the coin and attach its MMR proof at {@code txnbasics} time, and
     * every field that is part of the on-chain coin's serialization (so the imported input coin is
     * byte-identical to the chain's — see {@code sendnosign}, which feeds the node-DB coin straight in).
     */
    public static final class InputCoin {

        private final MiniData mCoinID;
        private final MiniData mAddress;
        private final MiniNumber mAmount;
        private final MiniData mTokenID;
        private final org.minima.objects.mmr.MMREntryNumber mMMREntryNumber;
        private final MiniNumber mBlockCreated;
        private final boolean mStoreState;
        private final ArrayList<StateVariable> mState;
        private final Token mToken;
        private final int mKeyIndex;

        /**
         * @param zCoinID         the coin's globally-unique CoinID ({@code coins[].coinid}).
         * @param zAddress        the coin's script address ({@code coins[].address}, 0x form).
         * @param zAmount         the RAW on-chain amount ({@code coins[].amount}).
         * @param zTokenID        the token id ({@code coins[].tokenid}); {@code 0x00} for Minima.
         * @param zMMREntryNumber the MMR entry number ({@code coins[].mmrentry}).
         * @param zBlockCreated   the block the coin was created in ({@code coins[].created}).
         * @param zStoreState     whether the coin stores state ({@code coins[].storestate}).
         * @param zState          the coin's state variables (empty if none).
         * @param zToken          the {@link Token} descriptor for a custom-token coin, else null.
         * @param zKeyIndex       which of OUR wallet key indices owns/controls this coin's address.
         */
        public InputCoin(MiniData zCoinID, MiniData zAddress, MiniNumber zAmount, MiniData zTokenID,
                         org.minima.objects.mmr.MMREntryNumber zMMREntryNumber, MiniNumber zBlockCreated,
                         boolean zStoreState, ArrayList<StateVariable> zState, Token zToken, int zKeyIndex) {
            mCoinID         = zCoinID;
            mAddress        = zAddress;
            mAmount         = zAmount;
            mTokenID        = zTokenID;
            mMMREntryNumber = zMMREntryNumber;
            mBlockCreated   = zBlockCreated;
            mStoreState     = zStoreState;
            mState          = (zState == null) ? new ArrayList<StateVariable>() : zState;
            mToken          = zToken;
            mKeyIndex       = zKeyIndex;
        }

        /** Convenience for a simple native-Minima coin at our primary address (key index 0), no state. */
        public InputCoin(MiniData zCoinID, MiniData zAddress, MiniNumber zAmount,
                         org.minima.objects.mmr.MMREntryNumber zMMREntryNumber) {
            this(zCoinID, zAddress, zAmount, TOKEN_MINIMA, zMMREntryNumber, MiniNumber.ZERO,
                    true, null, null, 0);
        }

        public MiniData getCoinID()   { return mCoinID; }
        public MiniData getAddress()  { return mAddress; }
        public MiniNumber getAmount() { return mAmount; }
        public MiniData getTokenID()  { return mTokenID; }
        public int getKeyIndex()      { return mKeyIndex; }
        public Token getToken()       { return mToken; }
        public ArrayList<StateVariable> getState() { return mState; }

        /** Reconstruct the on-chain {@link Coin} exactly, for use as a transaction input. */
        Coin toCoin() {
            Coin coin = new Coin(mCoinID, mAddress, mAmount, mTokenID, mStoreState);
            coin.setMMREntryNumber(mMMREntryNumber);
            coin.setBlockCreated(mBlockCreated);
            if (!mState.isEmpty()) {
                coin.setState(mState);
            }
            if (mToken != null) {
                coin.setToken(mToken);
            }
            return coin;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // coins-JSON -> InputCoin (THE M2 integration point)
    // ---------------------------------------------------------------------------------------------

    /**
     * Build an {@link InputCoin} from a single coin object as returned by the node's {@code coins}
     * query, populating EVERY consensus field so the reconstructed input {@link Coin} serializes
     * byte-identically to the on-chain coin. This is the critical link between "what the node reports
     * we own" and "what we sign": the WOTS signature covers the transaction id, which hashes the full
     * serialization of each input coin, so any drift here (wrong mmrentry, missing token, wrong
     * storestate, ...) would make the node's MMR proof mismatch our coin and the post fail.
     *
     * <p><b>Field names are exactly those emitted by {@code Coin.toJSON(...)}</b> (see
     * {@code org.minima.objects.Coin}), which is what {@code coins.java} serializes:
     * <pre>
     *   coinid      -&gt; CoinID           (0x hex)
     *   address     -&gt; script address    (0x hex)   [we use the 0x form, not miniaddress]
     *   amount      -&gt; RAW on-chain amount           [Coin.getAmount(); token math is separate]
     *   tokenid     -&gt; token id          (0x hex; 0x00 == Minima)
     *   storestate  -&gt; boolean
     *   mmrentry    -&gt; MMR entry number
     *   created     -&gt; block created
     *   state       -&gt; array of {port,type,data} (non-simple form; coins default) OR {port:data}
     *   token       -&gt; null for Minima, else the Token descriptor (reconstructed exactly)
     * </pre>
     *
     * <p>Uses the pure-Java bundled {@code org.minima.utils.json.JSONObject} so this is unit-testable
     * off-device; the Android layer re-parses each android {@code org.json} coin through the bundled
     * {@code JSONParser} before calling this (keeping the converter node/Android-agnostic).
     *
     * @param zCoin     one element of the {@code coins} response array.
     * @param zKeyIndex which of OUR wallet key indices controls this coin's address.
     */
    public static InputCoin fromCoinJson(JSONObject zCoin, int zKeyIndex) {

        MiniData coinid  = new MiniData(getStr(zCoin, "coinid"));
        MiniData address = new MiniData(getStr(zCoin, "address"));
        MiniNumber amount = new MiniNumber(getStr(zCoin, "amount"));
        MiniData tokenid = new MiniData(getStr(zCoin, "tokenid"));

        //storestate is a JSON boolean literal
        boolean storestate = getBool(zCoin, "storestate", true);

        //MMR entry number — toString() is a plain decimal; rebuild via BigDecimal (whole for coins)
        MMREntryNumber mmrentry = new MMREntryNumber(new BigDecimal(getStr(zCoin, "mmrentry")));

        //Block the coin was created in
        MiniNumber created = new MiniNumber(getStr(zCoin, "created"));

        //State variables (empty for a plain RETURN SIGNEDBY receive coin)
        ArrayList<StateVariable> state = parseState(zCoin.get("state"));

        //Token descriptor — only for custom-token coins; reconstructed field-for-field so its
        //recomputed tokenid matches (Token recomputes it in its constructor).
        Token token = null;
        Object tokObj = zCoin.get("token");
        if (tokObj instanceof JSONObject) {
            token = parseToken((JSONObject) tokObj);
        }

        return new InputCoin(coinid, address, amount, tokenid, mmrentry, created,
                storestate, state, token, zKeyIndex);
    }

    /**
     * Build an {@link InputCoin} from a BYTE-EXACT chain {@link Coin} (a {@code coinexport}
     * CoinProof's coin). This is the REQUIRED path for custom-token inputs: the token descriptor
     * and state here are the chain's own bytes, so the recomputed tokenid always matches —
     * unlike {@link #fromCoinJson}, whose JSON round-trip is lossy for object token names.
     */
    public static InputCoin fromExportedCoin(Coin zCoin, int zKeyIndex) {
        return new InputCoin(zCoin.getCoinID(), zCoin.getAddress(), zCoin.getAmount(),
                zCoin.getTokenID(), zCoin.getMMREntryNumber(), zCoin.getBlockCreated(),
                zCoin.storeState(), zCoin.getState(), zCoin.getToken(), zKeyIndex);
    }

    /**
     * LOUD token-integrity gate, run on every custom-token input before signing. A token whose
     * recomputed id mismatches its coin's tokenid builds a transaction that consensus rejects
     * AFTER an apparently-successful async txnpost — i.e. it fails silently on-chain and burns a
     * one-time signature. Refusing here turns that into an immediate, explained error.
     */
    private static void assertTokenIntegrity(InputCoin zCoin) {
        if (isMinima(zCoin.getTokenID())) return;
        if (zCoin.getToken() == null) {
            throw new IllegalArgumentException("Token coin " + zCoin.getCoinID().to0xString()
                    + " has no token descriptor — resolve it via coinexport before building");
        }
        if (!zCoin.getToken().getTokenID().isEqual(zCoin.getTokenID())) {
            throw new IllegalArgumentException("Token descriptor mismatch on coin "
                    + zCoin.getCoinID().to0xString() + ": descriptor recomputes to "
                    + zCoin.getToken().getTokenID().to0xString() + " but the coin's tokenid is "
                    + zCoin.getTokenID().to0xString()
                    + " — rebuild this input via coinexport (lossy JSON token name)");
        }
    }

    /** Reconstruct a {@link Token} from a {@code Coin.toJSON().token} sub-object. */
    private static Token parseToken(JSONObject zTok) {
        MiniData  tcoinid = new MiniData(getStr(zTok, "coinid"));
        MiniNumber scale  = new MiniNumber(getStr(zTok, "scale"));
        MiniNumber tamount = new MiniNumber(getStr(zTok, "totalamount"));
        MiniNumber created = new MiniNumber(getStr(zTok, "created"));

        //"name" is written by Token.toJSON as the raw MiniString content — a plain string, or (for a
        //JSON-object name) the serialized JSON text. Either way we want its exact string form so the
        //token bytes (and thus the recomputed tokenid) match.
        Object nameObj = zTok.get("name");
        String name = (nameObj instanceof String) ? (String) nameObj : String.valueOf(nameObj);

        String script = getStr(zTok, "script");

        return new Token(tcoinid, scale, tamount, new MiniString(name), new MiniString(script), created);
    }

    /**
     * Parse the coin's {@code state}. {@code coins} emits the non-simple array form
     * ({@code [{port,type,data}, ...]}); we also accept the {@code simplestate} object form
     * ({@code {"0":"...","1":"..."}}). Reconstruction mirrors the node's own state parsing
     * ({@code StateVariable(port, data)} re-infers the type from the data string).
     */
    private static ArrayList<StateVariable> parseState(Object zState) {
        ArrayList<StateVariable> out = new ArrayList<>();
        if (zState instanceof JSONArray) {
            for (Object o : (JSONArray) zState) {
                JSONObject sv = (JSONObject) o;
                int port = Integer.parseInt(String.valueOf(sv.get("port")));
                String data = String.valueOf(sv.get("data"));
                out.add(new StateVariable(port, data));
            }
        } else if (zState instanceof JSONObject) {
            JSONObject simple = (JSONObject) zState;
            for (Object k : simple.keySet()) {
                int port = Integer.parseInt(String.valueOf(k));
                String data = String.valueOf(simple.get(k));
                out.add(new StateVariable(port, data));
            }
        }
        return out;
    }

    private static String getStr(JSONObject zObj, String zKey) {
        Object v = zObj.get(zKey);
        if (v == null) {
            throw new IllegalArgumentException("coins JSON missing field: " + zKey);
        }
        return String.valueOf(v);
    }

    private static boolean getBool(JSONObject zObj, String zKey, boolean zDefault) {
        Object v = zObj.get(zKey);
        if (v == null) return zDefault;
        if (v instanceof Boolean) return (Boolean) v;
        return Boolean.parseBoolean(String.valueOf(v));
    }

    /** The result of a build: the signed txn, its serialization, and the exact node command pair. */
    public static final class BuiltTxn {

        private final String mID;
        private final Transaction mTransaction;
        private final Witness mWitness;
        private final MiniData mImportData;
        private final int mNumSignatures;

        BuiltTxn(String zID, Transaction zTxn, Witness zWitness, MiniData zImportData, int zNumSignatures) {
            mID            = zID;
            mTransaction   = zTxn;
            mWitness       = zWitness;
            mImportData    = zImportData;
            mNumSignatures = zNumSignatures;
        }

        /** The transaction id chosen for this build (used on both txnimport and txnpost). */
        public String getID() { return mID; }

        public Transaction getTransaction() { return mTransaction; }
        public Witness getWitness()         { return mWitness; }

        /** The 32-byte transaction ID that was signed. */
        public MiniData getTransactionID() { return mTransaction.getTransactionID(); }

        /** The raw serialized {@code TxnRow} (Transaction+Witness) MiniData. */
        public MiniData getImportData() { return mImportData; }

        /** The {@code txnimport data:} 0x-hex payload. */
        public String getImportHex() { return mImportData.to0xString(); }

        /** How many one-time WOTS signatures this build consumed (one per distinct input address). */
        public int getNumSignatures() { return mNumSignatures; }

        /** The first node command: import the signed transaction under our chosen id. */
        public String getTxnImportCommand() {
            return "txnimport id:" + mID + " data:" + getImportHex();
        }

        /**
         * The final node command: post it with {@code mine:true} and NO {@code auto:true}. The MMR
         * proofs + scripts are attached separately by {@code txnbasics} (which {@link com.eurobuddha.wallet.comms.NodeLink#publish}
         * runs between import and post), so {@code auto} must NOT be used here — it would duplicate the
         * MMR proofs and invalidate the transaction. No {@code burn:} either — a native-Minima burn is
         * already built into the transaction as the input−output difference.
         */
        public String getTxnPostCommand() {
            return "txnpost id:" + mID + " mine:true";
        }
    }

    /** A resolved output request (address hash + raw amount). */
    private static final class Output {
        final MiniData mAddress;
        final MiniNumber mAmount;
        Output(MiniData zAddress, MiniNumber zAmount) { mAddress = zAddress; mAmount = zAmount; }
    }

    private final WalletCore mWallet;

    public TxnFactory(WalletCore zWallet) {
        mWallet = zWallet;
    }

    // ---------------------------------------------------------------------------------------------
    // Public operations
    // ---------------------------------------------------------------------------------------------

    /**
     * SEND: spend {@code zInputs} to pay {@code zAmount} of {@code zTokenID} to {@code zRecipient}
     * (Mx.. or 0x.. address), returning change to our own change address. Optional native-Minima burn.
     */
    public BuiltTxn buildSend(List<InputCoin> zInputs, String zRecipient, MiniNumber zAmount,
                              MiniData zTokenID, MiniNumber zBurn, String zID) {

        MiniData recipient = parseAddress(zRecipient);

        ArrayList<Output> recipients = new ArrayList<>();
        recipients.add(new Output(recipient, zAmount));

        return build(zInputs, recipients, 1, zTokenID, zBurn, zID);
    }

    /**
     * SPLIT (send-to-self): split {@code zAmount} of {@code zTokenID} into {@code zN} equal output
     * coins (plus a remainder coin if the division is not exact) at our own primary address; any
     * leftover input value returns as a separate change coin. Optional native-Minima burn.
     */
    public BuiltTxn buildSplit(List<InputCoin> zInputs, MiniNumber zAmount, int zN,
                               MiniData zTokenID, MiniNumber zBurn, String zID) {

        if (zN < 1 || zN > MAX_SPLIT_COINS) {
            throw new IllegalArgumentException("Split must be 1.." + MAX_SPLIT_COINS + " (was " + zN + ")");
        }

        MiniData selfAddr = mWallet.getReceiveAddress().getAddressData();

        ArrayList<Output> recipients = new ArrayList<>();
        recipients.add(new Output(selfAddr, zAmount));

        return build(zInputs, recipients, zN, zTokenID, zBurn, zID);
    }

    /**
     * CONSOLIDATE: merge many small input coins (≥3) of {@code zTokenID} into a single self-output of
     * their summed value (minus a native-Minima burn), at our own primary address. No change coin.
     */
    public BuiltTxn buildConsolidate(List<InputCoin> zInputs, MiniData zTokenID,
                                     MiniNumber zBurn, String zID) {

        if (zInputs.size() < 3) {
            throw new IllegalArgumentException("Consolidate needs >= 3 input coins (was " + zInputs.size() + ")");
        }

        MiniNumber sum = sumInputs(zInputs, zTokenID);

        boolean minima = isMinima(zTokenID);
        if (!minima && zBurn.isMore(MiniNumber.ZERO)) {
            throw new IllegalArgumentException("Token-coin burn is not supported in M1 (burn must be 0 for tokens)");
        }

        //The single self-output is the whole sum minus the (built-in) burn.
        MiniNumber outAmount = minima ? sum.sub(zBurn) : sum;
        if (outAmount.isLessEqual(MiniNumber.ZERO)) {
            throw new IllegalArgumentException("Consolidated output <= 0 (sum=" + sum + " burn=" + zBurn + ")");
        }

        MiniData selfAddr = mWallet.getReceiveAddress().getAddressData();

        ArrayList<Output> recipients = new ArrayList<>();
        recipients.add(new Output(selfAddr, outAmount));

        return build(zInputs, recipients, 1, zTokenID, zBurn, zID);
    }

    /**
     * NFT TRANSFER: spend ONE token coin whole to {@code zRecipient} — no change, no split, exact
     * amount — replaying every state variable of the input coin verbatim onto the transaction and
     * storing state on the output ({@code storestate:true}). This reproduces the structure the NFT
     * wallet builds node-side (txnoutput storestate:true + txnstate per port), which is what a
     * locked StateNFT token script requires: {@code SAMESTATE(0 ..)} and
     * {@code VERIFYOUT(@INPUT GETOUTADDR(@INPUT) @AMOUNT @TOKENID TRUE)} — same index, same
     * amount, same tokenid, state kept. A plain NFT coin (no state) builds the same transaction
     * with an empty state set. Signed locally with the input coin's own key index.
     */
    public BuiltTxn buildNftTransfer(InputCoin zCoin, String zRecipient, String zID) {

        if (isMinima(zCoin.getTokenID())) {
            throw new IllegalArgumentException("Not a token coin — NFT transfer needs a custom-token coin");
        }
        if (zCoin.getToken() == null) {
            throw new IllegalArgumentException("NFT transfer requires the Token descriptor on the input coin");
        }

        return buildWholeTransfer(zCoin,zRecipient,zID);
    }

    /** Sweep can preserve state on native Minima too. Reuse the exact NFT whole-coin builder. */
    public BuiltTxn buildWholeTransfer(InputCoin zCoin, String zRecipient, String zID) {
        MiniData recipient = parseAddress(zRecipient);

        //Validate the claimed key index actually derives this address (same gate as build()).
        MiniData derived = mWallet.getAddress(zCoin.getKeyIndex()).getAddressData();
        if (!derived.isEqual(zCoin.getAddress())) {
            throw new IllegalArgumentException("Input address " + zCoin.getAddress().to0xString()
                    + " does not match wallet key index " + zCoin.getKeyIndex()
                    + " (derived " + derived.to0xString() + ")");
        }

        //LOUD gate: a mismatched token descriptor must fail HERE, not silently on-chain.
        assertTokenIntegrity(zCoin);

        Transaction transaction = new Transaction();
        Witness witness = new Witness();

        transaction.addInput(zCoin.toCoin());

        //Whole coin to the recipient at output index 0 (matches the input index for VERIFYOUT).
        Coin out = new Coin(Coin.COINID_OUTPUT, recipient, zCoin.getAmount(), Token.TOKENID_MINIMA, true);
        out.resetTokenID(zCoin.getTokenID());
        out.setToken(zCoin.getToken());
        transaction.addOutput(out);

        //Replay the input coin's state VERBATIM (ports sorted by Transaction.addStateVariable).
        for (StateVariable sv : zCoin.getState()) {
            transaction.addStateVariable(sv);
        }

        TxPoWGenerator.precomputeTransactionCoinID(transaction);
        transaction.calculateTransactionID();
        MiniData txid = transaction.getTransactionID();

        Signature sig = mWallet.signTransactionID(txid, zCoin.getKeyIndex());
        witness.addSignature(sig);

        TxnRow row = new TxnRow(zID, transaction, witness);
        MiniData importdata = MiniData.getMiniDataVersion(row);
        return new BuiltTxn(zID, transaction, witness, importdata, 1);
    }

    // ---------------------------------------------------------------------------------------------
    // Core builder — mirrors send.java / sendnosign.java ordering
    // ---------------------------------------------------------------------------------------------

    private BuiltTxn build(List<InputCoin> zInputs, ArrayList<Output> zRecipients, int zSplit,
                           MiniData zTokenID, MiniNumber zBurn, String zID) {

        if (zInputs == null || zInputs.isEmpty()) {
            throw new IllegalArgumentException("No input coins provided");
        }
        if (zBurn == null || zBurn.isLess(MiniNumber.ZERO)) {
            throw new IllegalArgumentException("Burn cannot be negative");
        }
        if (zSplit < 1 || zSplit > MAX_SPLIT_COINS) {
            throw new IllegalArgumentException("Split must be 1.." + MAX_SPLIT_COINS);
        }

        boolean minima = isMinima(zTokenID);
        if (!minima && zBurn.isMore(MiniNumber.ZERO)) {
            throw new IllegalArgumentException("Token-coin burn is not supported in M1 (burn must be 0 for tokens)");
        }

        //All inputs must be the same token as we are spending.
        for (InputCoin ic : zInputs) {
            if (!ic.getTokenID().isEqual(zTokenID)) {
                throw new IllegalArgumentException("Input coin token mismatch: " + ic.getTokenID().to0xString()
                        + " != " + zTokenID.to0xString());
            }
        }

        //The token descriptor (for custom-token outputs) — taken from the inputs.
        Token token = null;
        if (!minima) {
            for (InputCoin ic : zInputs) {
                if (ic.getToken() != null) { token = ic.getToken(); break; }
            }
            if (token == null) {
                throw new IllegalArgumentException("Custom-token send requires a Token descriptor on the input coins");
            }
        }

        //Total we must cover = sum(recipient amounts) + burn (native Minima only; burn already 0 for tokens).
        MiniNumber sendtotal = MiniNumber.ZERO;
        for (Output o : zRecipients) {
            if (o.mAmount.isLessEqual(MiniNumber.ZERO)) {
                throw new IllegalArgumentException("Output amount must be > 0 (was " + o.mAmount + ")");
            }
            sendtotal = sendtotal.add(o.mAmount);
        }
        MiniNumber totalrequired = minima ? sendtotal.add(zBurn) : sendtotal;

        //Sum inputs of this token.
        MiniNumber currentamount = sumInputs(zInputs, zTokenID);

        //Enough?
        if (currentamount.isLess(totalrequired)) {
            throw new IllegalArgumentException("Insufficient funds: have " + currentamount
                    + " require " + totalrequired);
        }

        //Change = inputs - amount - (built-in burn).
        MiniNumber change = currentamount.sub(totalrequired);

        //--- Construct the transaction -----------------------------------------------------------
        Transaction transaction = new Transaction();
        Witness witness = new Witness();

        //Inputs, in the order given. Also gather distinct signing addresses (first-seen order).
        ArrayList<String> distinctAddrs = new ArrayList<>();
        ArrayList<Integer> distinctKeyIndex = new ArrayList<>();
        for (InputCoin ic : zInputs) {
            transaction.addInput(ic.toCoin());

            //Validate the claimed key index actually derives this address (defensive correctness).
            MiniData derived = mWallet.getAddress(ic.getKeyIndex()).getAddressData();
            if (!derived.isEqual(ic.getAddress())) {
                throw new IllegalArgumentException("Input address " + ic.getAddress().to0xString()
                        + " does not match wallet key index " + ic.getKeyIndex()
                        + " (derived " + derived.to0xString() + ")");
            }

            //LOUD gate: a mismatched token descriptor must fail HERE, not silently on-chain.
            assertTokenIntegrity(ic);

            String addr = ic.getAddress().to0xString();
            if (!distinctAddrs.contains(addr)) {
                distinctAddrs.add(addr);
                distinctKeyIndex.add(ic.getKeyIndex());
            }
        }

        //Outputs: recipients (with split + remainder), mirroring send.java exactly.
        MiniNumber msplit = new MiniNumber(zSplit);
        for (Output user : zRecipients) {

            MiniNumber usertotal = user.mAmount;
            MiniNumber splitamount = usertotal.div(msplit);
            if (splitamount.isLessEqual(MiniNumber.ZERO)) {
                throw new IllegalArgumentException("Split output too small for amount " + usertotal);
            }

            MiniNumber currenttotal = MiniNumber.ZERO;
            for (int i = 0; i < zSplit; i++) {
                Coin out = new Coin(Coin.COINID_OUTPUT, user.mAddress, splitamount, Token.TOKENID_MINIMA, true);
                if (!minima) {
                    out.resetTokenID(zTokenID);
                    out.setToken(token);
                }
                transaction.addOutput(out);
                currenttotal = currenttotal.add(splitamount);
            }

            //Rounding remainder (send.java's "left over" output).
            MiniNumber currentdiff = usertotal.sub(currenttotal);
            if (currentdiff.isMore(MiniNumber.ZERO)) {
                Coin remain = new Coin(Coin.COINID_OUTPUT, user.mAddress, currentdiff, Token.TOKENID_MINIMA, true);
                if (!minima) {
                    remain.resetTokenID(zTokenID);
                    remain.setToken(token);
                }
                transaction.addOutput(remain);
            }
        }

        //Change output — back to our own change address (does not keep state; storeState=false).
        //ponytail: change always goes to base address 0 (tracked + spendable); rotate across the 64
        //like the node's random getaddress if change-address privacy ever matters.
        if (change.isMore(MiniNumber.ZERO)) {
            MiniData chgaddr = mWallet.getReceiveAddress().getAddressData();
            Coin changecoin = new Coin(Coin.COINID_OUTPUT, chgaddr, change, Token.TOKENID_MINIMA, false);
            if (!minima) {
                changecoin.resetTokenID(zTokenID);
                changecoin.setToken(token);
            }
            transaction.addOutput(changecoin);
        }

        //--- Finalise ids, then sign -------------------------------------------------------------

        //Compute the deterministic output CoinIDs (hash of firstinput-coinid + output index).
        TxPoWGenerator.precomputeTransactionCoinID(transaction);

        //THE transaction id — this is what gets signed. Must be computed AFTER precompute.
        transaction.calculateTransactionID();
        MiniData txid = transaction.getTransactionID();

        //One Signature per distinct input address. SIGNATURES ONLY — no ScriptProofs, no CoinProofs:
        //the node adds both the scripts and the MMR proofs at txnbasics (see class javadoc).
        int numsigs = 0;
        for (int i = 0; i < distinctAddrs.size(); i++) {
            int keyIndex = distinctKeyIndex.get(i);

            //Locally sign the txid, consuming exactly one one-time WOTS leaf (KeyUses advanced first).
            Signature sig = mWallet.signTransactionID(txid, keyIndex);
            witness.addSignature(sig);
            numsigs++;
        }

        //Serialize Transaction+Witness to the txnimport MiniData (via TxnRow).
        TxnRow row = new TxnRow(zID, transaction, witness);
        MiniData importdata = MiniData.getMiniDataVersion(row);

        return new BuiltTxn(zID, transaction, witness, importdata, numsigs);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private static boolean isMinima(MiniData zTokenID) {
        return zTokenID.isEqual(TOKEN_MINIMA);
    }

    private static MiniNumber sumInputs(List<InputCoin> zInputs, MiniData zTokenID) {
        MiniNumber tot = MiniNumber.ZERO;
        for (InputCoin ic : zInputs) {
            if (ic.getTokenID().isEqual(zTokenID)) {
                tot = tot.add(ic.getAmount());
            }
        }
        return tot;
    }

    /** Parse an Mx.. or 0x.. address string to its raw hash {@link MiniData} (mirrors send.java). */
    public static MiniData parseAddress(String zAddress) {
        String addr = zAddress.trim();
        if (addr.toLowerCase().startsWith("mx")) {
            return Address.convertMinimaAddress(addr);
        }
        return new MiniData(addr);
    }
}
