/** Seal and open the frozen invoice body. */

import { importAesKeyBytes } from "#crypto/aes-gcm.ts";
import { decryptWithKey, getEncryptionKeyBytes } from "#crypto/encryption.ts";
import { hmacWithKey } from "#crypto/hashing.ts";
import type { KeyEncrypted } from "#crypto/sealed.ts";

/** The body's key comes from the share token and the site key together.
 *  Neither one alone opens a body. */
export const invoiceBodyKey = (shareToken: string): Promise<CryptoKey> =>
  importAesKeyBytes(
    hmacWithKey(getEncryptionKeyBytes(), `invoice-body-key v1\n${shareToken}`),
  );

/** Open one frozen body with the share token that unlocks it. */
export const openInvoiceBody = async (
  body: KeyEncrypted,
  shareToken: string,
): Promise<string> => decryptWithKey(body, await invoiceBodyKey(shareToken));
