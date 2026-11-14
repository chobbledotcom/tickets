/** The attendee status fields: the stored row, the write input, the API
 *  bodies, and the JSON body read derive from this one list. The status
 *  pages keep their own form. */

import type { FieldSpecs } from "#shared/rest/field-specs.ts";

/* jscpd:ignore-start -- a list of strings, not code */
export const STATUS_FIELDS = [
  { key: "is_paid_default", kind: "switch" },
  { key: "is_public_default", kind: "switch" },
  { key: "is_reservation", kind: "switch" },
  { key: "name", kind: "name" },
  { key: "reservation_amount", kind: "text" },
] as const satisfies FieldSpecs;
/* jscpd:ignore-end */
