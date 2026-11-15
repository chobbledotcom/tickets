import type { SessionMetadata } from "#shared/payments.ts";

/* jscpd:ignore-start -- a list of strings, not code */
const SESSION_METADATA_KEYS = [
  "_origin",
  "address",
  "allocations",
  "answer_ids",
  "balance_attendee_id",
  "date",
  "day_count",
  "email",
  "items",
  "modifiers",
  "name",
  "phone",
  "price_proof",
  "reservation_amount",
  "site_token_index",
  "special_instructions",
  "tax_policy",
  "text_answer_ids",
  "thank_you_url",
] as const satisfies readonly (keyof SessionMetadata)[];
/* jscpd:ignore-end */

/** Every metadata field blank. A field missing from the key list fails the
 *  type check where the record becomes `SessionMetadata`. */
export const blankMetadata = Object.fromEntries(
  SESSION_METADATA_KEYS.map((key) => [key, ""]),
) as Record<(typeof SESSION_METADATA_KEYS)[number], string>;
