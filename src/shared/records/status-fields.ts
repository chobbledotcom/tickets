/** The attendee status fields: the stored row, the write input, the API
 *  bodies, and the JSON body read derive from this one list. The status
 *  pages keep their own form. */

import type { FieldSpecs } from "#shared/rest/field-specs.ts";

/* jscpd:ignore-start -- a list of strings, not code */
export const STATUS_FIELDS = [
  { key: "isPaidDefault", kind: "switch" },
  { key: "isPublicDefault", kind: "switch" },
  { key: "isReservation", kind: "switch" },
  { key: "name", kind: "name" },
  { key: "reservationAmount", kind: "text" },
] as const satisfies FieldSpecs;
/* jscpd:ignore-end */
