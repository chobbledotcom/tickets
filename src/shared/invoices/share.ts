/** The non-expiring share link for one invoice, and the key it carries. */

import { importAesKeyBytes } from "#crypto/aes-gcm.ts";
import { decryptWithKey, getEncryptionKeyBytes } from "#crypto/encryption.ts";
import { hmacWithKey } from "#crypto/hashing.ts";
import type { KeyEncrypted } from "#crypto/sealed.ts";
import { tokenUrl } from "#shared/token-url.ts";

/** The absolute share link an operator can copy. */
export const invoiceShareUrl = tokenUrl("/invoice/");

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
