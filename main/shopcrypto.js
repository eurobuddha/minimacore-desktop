/*
 * shopcrypto.js — miniMall (MINIMERCH) crypto. The sealed-box primitive is IDENTICAL to minimaMail's
 * (mailcrypto.js): libsodium X25519 crypto_box_seal + inner Ed25519 detached signature; publicId = 0x+boxPk+signPk.
 * The ONLY difference is the HKDF domain — miniMall derives under "minimerch-*" so the same node seed yields a
 * DIFFERENT identity than the Mail app ("minima-comms-*"), with zero key clash. This MUST byte-match the native
 * com.eurobuddha.comms CommsIdentity ("minimerch-box-v1"/"minimerch-sign-v1") so the desktop interoperates with the
 * native miniMall Shop/Inbox apps on the shared MINIMERCH mainnet address.
 *
 * seal/open/serialize/load/keypairConsistent/isValidPublicId/boxPkOf/signPkOf are all domain-independent → reused
 * verbatim from mailcrypto. Only deriveIdentity is re-pointed to the merch domain.
 */
const mc = require("./mailcrypto");

const BOX_INFO = "minimerch-box-v1";
const SIGN_INFO = "minimerch-sign-v1";

/** Derive the miniMall shop/vendor identity from the node seed (minimerch HKDF domain). */
async function deriveIdentity(seedStr) { return mc.deriveIdentityDomain(seedStr, BOX_INFO, SIGN_INFO); }

module.exports = {
  ready: mc.ready,
  deriveIdentity,
  seal: mc.seal,
  open: mc.open,
  serializeIdentity: mc.serializeIdentity,
  loadIdentity: mc.loadIdentity,
  keypairConsistent: mc.keypairConsistent,
  isValidPublicId: mc.isValidPublicId,
  boxPkOf: mc.boxPkOf,
  signPkOf: mc.signPkOf,
  DOMAIN: { BOX_INFO, SIGN_INFO }
};
