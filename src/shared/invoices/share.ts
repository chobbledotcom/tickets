/** The non-expiring share link for one invoice. */

import { encodedAfter } from "#shared/encoded-after.ts";
import { tokenUrl } from "#shared/token-url.ts";

/** The path the share token opens. */
export const invoiceSharePath = encodedAfter("/invoice/");

/** The absolute share link an operator can copy. */
export const invoiceShareUrl = tokenUrl("/invoice/");
