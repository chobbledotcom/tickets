/**
 * Sealing the directory's text, and opening it back up.
 *
 * Everything an admin types here — a source name, its URL pattern, an external
 * id — is sealed with the site owner's public key. A database dump plus the
 * symmetric key cannot read it. Only an authenticated admin session, whose
 * password unwraps the owner private key, can.
 */

import { decryptWithOwnerKey, encryptWithOwnerKey } from "#crypto/hybrid.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { settings } from "#db/settings.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";

/** Seal one value under the owner public key. A write needs no session. */
export const sealForAdmin = (text: string): Promise<OwnerKeyEncrypted> =>
  encryptWithOwnerKey(text, settings.publicKey);

/**
 * Open one value with the current request's private key. Every read of this
 * directory runs inside an authenticated admin request, where the key is in
 * scope. Outside one the read fails closed.
 */
export const openForAdmin = async (
  sealed: OwnerKeyEncrypted,
): Promise<string> =>
  decryptWithOwnerKey(sealed, await requireRequestPrivateKey());
