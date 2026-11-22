// effects: pure
/**
 * The keys that the attendee writes read from a JSON body. The docs page
 * builds its field table from this list. The parse files read the body type
 * of this list. A read of a key that is not declared here is a compile
 * error.
 */

import type { ExtraField } from "#shared/admin-api-example/field-docs.ts";
import { listOfObjects, TEXT } from "#shared/admin-api-example/value-forms.ts";

/** The write keys of an attendee. Every key is optional on an update. A key
 *  with `only` belongs to one verb: an update refuses `created` and
 *  `ticketToken`, because they name the booking. */
export const ATTENDEE_WRITE_FIELDS = {
  address: { value: TEXT },
  adjustments: {
    value: listOfObjects(["amount", "description", "taxable"]),
  },
  answers: { value: listOfObjects(["answerId", "freeText", "questionId"]) },
  created: { only: "create", value: { form: "time" } },
  email: { value: TEXT },
  lines: {
    required: true,
    value: listOfObjects([
      "date",
      "durationDays",
      "listingId",
      "price",
      "quantity",
    ]),
  },
  name: { required: true, value: TEXT },
  notifications: { only: "create", value: { form: "switch" } },
  payments: { value: listOfObjects(["amount"]) },
  phone: { value: TEXT },
  special_instructions: { value: TEXT },
  status: { value: TEXT },
  ticketToken: { only: "create", value: TEXT },
} as const satisfies Record<string, ExtraField>;

/** A JSON body as the attendee parse files read it: only a declared key can
 *  be read, and each key holds whatever the caller sent. */
export type AttendeeBody = {
  [Key in keyof typeof ATTENDEE_WRITE_FIELDS]?: unknown;
};
