/** The non-expiring share link for one invoice. */

import { tokenUrl } from "#shared/token-url.ts";

/** The absolute share link an operator can copy. The link carries the token
 *  that opens the invoice body. */
export const invoiceShareUrl = tokenUrl("/invoice/");
