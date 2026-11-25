package com.eurobuddha.wallet;

/** Desktop has already fsynced the next count before handing its signer one reserved leaf. */
@FunctionalInterface
public interface KeyUses {
    int reserveNextUse(int keyIndex);
}
