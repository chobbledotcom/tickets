/** The attendee status fields declare the stored row, the write input, the
 *  API bodies, and the JSON body read. The status form derives from the same
 *  list. */

import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount-hint.ts";
import type { FieldSpecs } from "#shared/rest/field-specs.ts";

/* jscpd:ignore-start -- a list of strings, not code */
export const STATUS_FIELDS = [
  {
    key: "name",
    kind: "name",
    label: "common.name",
    requiredMessageKey: "statuses.name_required",
  },
  {
    exclusive: {
      other: "isPaidDefault",
      why: "statuses.error_paid_default_reservation",
    },
    key: "isReservation",
    kind: "switch",
    label: "statuses.form_reservation_checkbox",
  },
  {
    key: "isPublicDefault",
    kind: "switch",
    label: "statuses.form_public_default_checkbox",
  },
  {
    exclusive: {
      other: "isReservation",
      why: "statuses.error_paid_default_reservation",
    },
    key: "isPaidDefault",
    kind: "switch",
    label: "statuses.form_paid_default_checkbox",
  },
  {
    default: "0",
    hint: "statuses.form_reservation_amount_hint",
    hintPrefix: RESERVATION_AMOUNT_HINT,
    key: "reservationAmount",
    kind: "text",
    label: "statuses.form_reservation_amount_label",
  },
] as const satisfies FieldSpecs;
/* jscpd:ignore-end */
