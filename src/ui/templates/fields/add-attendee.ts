/**
 * Admin "add attendee" form. Builds on the public ticket fields (a manually
 * added booking is still a booking) but disables native autofill — the operator
 * is entering a customer's details, not their own — and appends quantity,
 * date, and (for customisable daily listings) a day-count selector.
 */

import { type Field, requireChoiceOptions } from "#shared/forms/field.ts";
import {
  getTicketFields,
  type TicketFormValues,
} from "#templates/fields/ticket.ts";
import { validateDate } from "#templates/fields/validators.ts";
import type { ListingFields } from "#types";

/** Typed values from the admin add-attendee form. */
export type AddAttendeeFormValues = TicketFormValues & {
  quantity: number;
  date: string;
  day_count: string;
};

/** Quantity field for admin add-attendee form */
const addAttendeeQuantityField: Field = {
  label: "Quantity",
  min: 1,
  name: "quantity",
  required: true,
  type: "number",
};

/** Date field for admin add-attendee form (daily listings only) */
const addAttendeeDateField: Field = {
  label: "Date",
  name: "date",
  required: true,
  type: "date",
  validate: validateDate,
};

/** Day-count select for adding an attendee to a customisable daily listing. */
const addAttendeeDayCountField = (dayCounts: number[]): Field => ({
  label: "Number of days",
  name: "day_count",
  options: requireChoiceOptions(
    "Number of days",
    dayCounts.map((n) => ({
      label: `${n} day${n === 1 ? "" : "s"}`,
      value: String(n),
    })),
  ),
  required: true,
  type: "select",
});

/**
 * Get admin add-attendee form fields based on listing config.
 * Includes contact fields (name + email/phone per setting), quantity, a date
 * field for daily listings, and — for customisable daily listings — a day-count
 * selector so the manually-added booking reserves the chosen span.
 */
export const getAddAttendeeFields = (
  fields: ListingFields,
  isDaily: boolean,
  dayCounts?: number[],
): Field[] => {
  // Admin enters a customer's details here, so disable native autofill: we don't
  // want the operator's browser to store or suggest other customers' PII. The
  // shared ticket fields keep their semantic autocomplete for the public form,
  // so override on copies rather than mutating the originals.
  const contactFields = getTicketFields(fields, false).map(
    (f): Field => ({ ...f, autocomplete: "off" }),
  );
  const result = [...contactFields, addAttendeeQuantityField];
  if (isDaily) result.push(addAttendeeDateField);
  if (dayCounts && dayCounts.length > 0) {
    result.push(addAttendeeDayCountField(dayCounts));
  }
  return result;
};
