/**
 * Admin guide — Tax section.
 *
 * The Tax setting sits in Settings beside the payment settings. It decides how
 * checkout prices carry tax, so it has a section of its own.
 */

import {
  faqSection,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

/* jscpd:ignore-start -- a list of strings, not code */
/** The section's FAQ entry ids, in the order it shows them. */
const TAX_ENTRY_IDS = [
  "what_is_tax",
  "how_do_tax_settings_work",
  "tax_at_checkout",
  "tax_and_existing_bookings",
  "tax_in_money_and_refunds",
] as const;
/* jscpd:ignore-end */

export const taxSection: GuideSection = faqSection("tax", TAX_ENTRY_IDS, "tax");
