/** Form model for admin servicing events. */

import type { ListingBooking } from "#db/attendee-types.ts";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import { t } from "#i18n";
import {
  LINE_LISTING_PREFIX,
  QTY_PREFIX,
} from "#routes/admin/attendee-form-lines.ts";
import {
  DAY_COUNT_FIELD,
  isBookedLine,
  type ParsedAttendeeForm,
  parseAttendeeForm,
  START_DATE_FIELD,
  toCreateInput,
} from "#routes/admin/attendee-form-model.ts";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import type { ListingWithCount } from "#types";

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
    label: t("servicing.field.name"),
    name: "name",
    required: true,
    type: "text",
  },
  {
    label: t("servicing.field.start_date"),
    name: START_DATE_FIELD,
    type: "date",
  },
  {
    label: t("servicing.field.days"),
    min: 1,
    name: DAY_COUNT_FIELD,
    type: "number",
  },
];

/**
 * The browser quantity guard reads `quantity_<id>`, while the shared attendee
 * parser reads indexed booking lines. Convert the first shape into the second
 * so servicing and attendee forms keep one booking parser.
 */
const withQuantityAliases = (form: FormParams): FormParams => {
  const normalized = new FormParams(form.toString());
  let index = 0;
  for (const [field, value] of form.entries()) {
    if (!field.startsWith(QUANTITY_ALIAS_PREFIX)) continue;
    const id = field.slice(QUANTITY_ALIAS_PREFIX.length);
    normalized.append(`${LINE_LISTING_PREFIX}${index}`, id);
    normalized.append(`${QTY_PREFIX}${index}`, value);
    index++;
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
    throw new Error(t("servicing.error.daily_start_date"));
  }
  return {
    bookings: toCreateInput(parsed).bookings.filter((b) => b.quantity! > 0),
    kind: SERVICING_KIND,
    name: parsed.name.trim(),
  };
};
