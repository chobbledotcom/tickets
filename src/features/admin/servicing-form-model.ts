/**
 * Form model for admin servicing events.
 *
 * Servicing uses the attendee booking grid parser, then narrows the saved shape
 * to name + booked listing lines. Contact, status, balance, and ticket-facing
 * fields are deliberately absent from the returned create/update input.
 */

import {
  DAY_COUNT_FIELD,
  isBookedLine,
  type ParsedAttendeeForm,
  parseAttendeeForm,
  QTY_PREFIX,
  START_DATE_FIELD,
  toCreateInput,
} from "#routes/admin/attendee-form-model.ts";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms.tsx";
import type { ListingWithCount } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";

export type ServicingCreateInput = {
  bookings: ListingBooking[];
  kind: typeof SERVICING_KIND;
  name: string;
};

export type ServicingListingForForm = Pick<
  ListingWithCount,
  "id" | "listing_type" | "max_quantity"
> &
  Partial<ListingWithCount>;

const QUANTITY_ALIAS_PREFIX = "quantity_";

export const buildServicingFieldSchema = (): Field[] => [
  {
    autocomplete: "off",
    label: "Name",
    name: "name",
    required: true,
    type: "text",
  },
  {
    label: "Start date",
    name: START_DATE_FIELD,
    type: "date",
  },
  {
    label: "Days",
    min: 1,
    name: DAY_COUNT_FIELD,
    type: "number",
  },
];

export const renderServicingHiddenIndicator = (): string =>
  '<label><input type="checkbox" name="hidden_from_public" checked disabled> Hidden from public</label>';

const withQuantityAliases = (form: FormParams): FormParams => {
  const normalized = new FormParams(form.toString());
  for (const [field, value] of form.entries()) {
    if (!field.startsWith(QUANTITY_ALIAS_PREFIX)) continue;
    const id = field.slice(QUANTITY_ALIAS_PREFIX.length);
    const qtyField = `${QTY_PREFIX}${id}`;
    if (!normalized.has(qtyField)) normalized.append(qtyField, value);
  }
  return normalized;
};

export const parseServicingForm = (
  form: FormParams,
  listingsById: Map<number, ServicingListingForForm>,
): ParsedAttendeeForm =>
  parseAttendeeForm(
    withQuantityAliases(form),
    listingsById as Map<number, ListingWithCount>,
  );

export const normalizeServicingForSave = (
  parsed: ParsedAttendeeForm,
): ServicingCreateInput => {
  const hasDailyBooking = parsed.lines.some(
    (line) => isBookedLine(line) && line.listing?.listing_type === "daily",
  );
  if (hasDailyBooking && !isIsoDate(parsed.startDate)) {
    throw new Error("A start date is required for the booked daily listings");
  }
  return {
    bookings: toCreateInput(parsed).bookings.filter((b) => b.quantity! > 0),
    kind: SERVICING_KIND,
    name: parsed.name.trim(),
  };
};

export const toServicingCreateInput = (
  parsed: ParsedAttendeeForm,
): ServicingCreateInput => normalizeServicingForSave(parsed);
