/** The non-expiring share link for one invoice, and the key it carries. */

import { importAesKeyBytes } from "#crypto/aes-gcm.ts";
import { decryptWithKey } from "#crypto/encryption.ts";
import type { KeyEncrypted } from "#crypto/sealed.ts";
import { fromBase64Url } from "#crypto/utils.ts";
import { tokenUrl } from "#shared/token-url.ts";

/** The absolute share link an operator can copy. */
export const invoiceShareUrl = tokenUrl("/invoice/");

/** The body's key is the token's own 32 random bytes. The row keeps that token
 *  sealed under the owner key, so only an owner session hands the key out. */
export const invoiceBodyKey = (shareToken: string): Promise<CryptoKey> =>
  importAesKeyBytes(fromBase64Url(shareToken));

/** Open one frozen body with the share token that unlocks it. */
export const openInvoiceBody = async (
  body: KeyEncrypted,
  shareToken: string,
): Promise<string> => decryptWithKey(body, await invoiceBodyKey(shareToken));
