package com.eurobuddha.wallet;

import java.math.BigInteger;

import org.minima.objects.Address;
import org.minima.objects.base.MiniData;
import org.minima.objects.keys.Signature;
import org.minima.objects.keys.TreeKey;
import org.minima.utils.BIP39;
import org.minima.utils.Crypto;

/**
 * WalletCore — deterministic self-custodial key derivation, address generation and local WOTS
 * signing, mirroring minima-core's {@code Wallet.createNewKey}.
 *
 * <p><b>Derivation (must match minima-core exactly so importing a Minima seed reproduces the same
 * wallet):</b>
 * <pre>
 *   baseSeed        = BIP39.convertStringToSeed(phrase)                       // SHA of phrase bytes
 *   modifier(index) = new MiniData(BigInteger.valueOf(index))                 // key index n
 *   privSeed(index) = Crypto.getInstance().hashObjects(baseSeed, modifier)    // == Wallet.java:509
 *   treeKey(index)  = TreeKey.createDefault(privSeed)                         // 64^3 = 262144 leaves
 *   script(index)   = "RETURN SIGNEDBY(" + treeKey.getPublicKey() + ")"       // == Wallet.java:488
 *   address(index)  = new Address(script)                                     // MMR-root of script
 * </pre>
 *
 * <p><b>Signing safety.</b> {@link #signTransactionID(MiniData, int)} obtains its leaf ONLY via
 * {@link KeyUses#reserveNextUse(int)}, which durably persists {@code uses := n+1} before returning
 * {@code n}. The signature is then produced at leaf {@code n}. This makes a one-time-key reuse
 * impossible even across a crash (a crash merely skips a leaf). See {@link KeyUses}.
 *
 * <p>M0 scope: in-memory seed + the injected {@link KeyUses} store only. Encrypted-at-rest seed
 * persistence (seed-derived key) is M3; the transaction factory that calls
 * {@link #signTransactionID} is M1.
 */
public class WalletCore {

    /**
     * The number of BASE wallet keys/addresses, matching minima-core's
     * {@code Wallet.NUMBER_GETADDRESS_KEYS}: a node (or this wallet) initialised from the same seed
     * derives exactly these 64 default addresses (modifiers 0..63).
     */
    public static final int NUM_BASE_KEYS = 64;

    /** The wallet base seed = BIP39.convertStringToSeed(phrase). Held in memory for M0. */
    private final MiniData mBaseSeed;

    /**
     * Public keys by key index. Deriving a public key builds a full {@link TreeKey} (64 WOTS
     * keygens, expensive) — once known, a pubkey is pure public data, so it is cached here and can
     * be preloaded from a persisted cache (see {@code AddressBook}).
     */
    private final java.util.Map<Integer, MiniData> mPubKeys = new java.util.HashMap<>();

    /** The durable one-time-use counter guarding every signature. */
    private final KeyUses mKeyUses;

    /**
     * @param zPhrase  the wallet seed phrase (any phrase; ≥16 chars recommended per the plan).
     * @param zKeyUses the durable uses counter (Android: {@link PrefsKeyUses}; tests: in-memory).
     */
    public WalletCore(String zPhrase, KeyUses zKeyUses) {
        this(BIP39.convertStringToSeed(zPhrase), zKeyUses);
    }

    /** Construct directly from an already-derived base seed (e.g. an imported raw seed). */
    public WalletCore(MiniData zBaseSeed, KeyUses zKeyUses) {
        mBaseSeed = zBaseSeed;
        mKeyUses = zKeyUses;
    }

    /** The wallet base seed (SHA of the phrase). */
    public MiniData getBaseSeed() {
        return mBaseSeed;
    }

    /**
     * The private seed for a given key index — {@code hashObjects(baseSeed, modifier(index))}.
     * Mirrors {@code Wallet.createNewKey} (minima-core Wallet.java:509).
     */
    public MiniData derivePrivateSeed(int zKeyIndex) {
        if (zKeyIndex < 0) {
            throw new IllegalArgumentException("key index must be >= 0");
        }
        MiniData modifier = new MiniData(BigInteger.valueOf(zKeyIndex));
        return Crypto.getInstance().hashObjects(mBaseSeed, modifier);
    }

    /**
     * The deterministic {@link TreeKey} for a key index (64^3 = 262144 one-time leaves).
     * <p>NOTE: this returns a freshly-constructed TreeKey with its internal {@code uses} at 0. The
     * authoritative uses count lives in {@link KeyUses}; callers MUST NOT sign off a TreeKey's own
     * counter — always route signing through {@link #signTransactionID}.
     */
    public TreeKey deriveTreeKey(int zKeyIndex) {
        return new TreeKey(derivePrivateSeed(zKeyIndex), 64, 3); // Official classic Web Wallet, in both node modes.
    }

    /** The WOTS public key (MiniData / 0x-hex) for a key index. Cached after first derivation. */
    public MiniData getPublicKey(int zKeyIndex) {
        synchronized (mPubKeys) {
            MiniData cached = mPubKeys.get(zKeyIndex);
            if (cached != null) return cached;
        }
        //Expensive TreeKey build — outside the lock so parallel derivations don't serialize.
        MiniData pubkey = deriveTreeKey(zKeyIndex).getPublicKey();
        synchronized (mPubKeys) {
            mPubKeys.put(zKeyIndex, pubkey);
        }
        return pubkey;
    }

    /**
     * Preload a known public key for an index, skipping the expensive TreeKey build. The caller is
     * responsible for the value being the TRUE pubkey of this seed+index (a wrong preload cannot
     * leak funds via signing — {@link #signTransactionID} derives from the seed — but it would
     * display a receive address this wallet cannot spend; see AddressBook's spot-check).
     */
    public void preloadPublicKey(int zKeyIndex, MiniData zPubKey) {
        synchronized (mPubKeys) {
            mPubKeys.put(zKeyIndex, zPubKey);
        }
    }

    /** The default script for a key index: {@code RETURN SIGNEDBY(0x<pubkey>)}. */
    public String getScript(int zKeyIndex) {
        return "RETURN SIGNEDBY(" + getPublicKey(zKeyIndex) + ")";
    }

    /**
     * The receive {@link Address} for a key index — the MMR-root of the default script.
     * Use {@link Address#getMinimaAddress()} for the {@code Mx...} form and
     * {@link Address#getAddressData()} for the {@code 0x...} form.
     */
    public Address getAddress(int zKeyIndex) {
        return new Address(getScript(zKeyIndex));
    }

    /** Convenience: the primary receive address (key index 0). */
    public Address getReceiveAddress() {
        return getAddress(0);
    }

    /**
     * Sign a 32-byte transaction ID with the WOTS key at {@code zKeyIndex}, consuming exactly one
     * one-time leaf and durably advancing the {@link KeyUses} counter FIRST.
     *
     * <p>Ordering (crash-safe): reserve+persist {@code uses := n+1} → set the TreeKey to leaf n →
     * sign → return. A crash before the signature is emitted skips leaf n; a leaf is never reused.
     *
     * @throws IllegalStateException if the key has exhausted all one-time leaves.
     */
    public Signature signTransactionID(MiniData zTxnID, int zKeyIndex) {
        TreeKey treekey = deriveTreeKey(zKeyIndex);

        // Reserve the leaf: this DURABLY persists uses := n+1 before returning n.
        int leaf = mKeyUses.reserveNextUse(zKeyIndex);

        // Exhaustion guard: never wrap around and reuse leaf 0.
        if (leaf >= treekey.getMaxUses()) {
            throw new IllegalStateException(
                "Key " + zKeyIndex + " exhausted: " + leaf + " / " + treekey.getMaxUses()
                    + " one-time signatures used");
        }

        // Point the freshly-derived TreeKey at the reserved leaf and sign it.
        treekey.setUses(leaf);
        return treekey.sign(zTxnID);
    }
}
