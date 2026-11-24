/**
 * The one value rule of each field kind. The JSON API check, the API body
 * views, and the catalogue transfer schema all derive from this table. So the
 * API, the form, and the import cannot accept different values for one field.
 */

import * as v from "valibot";
import { columnName } from "#shared/column-names.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { bindFirst, flagOfKind } from "#shared/fp-bind.ts";
import {
  dateField,
  optionalTextField,
  switchField,
  textField,
} from "#shared/rest/api-body-fields.ts";
import type {
  ByColumn,
  ByInputKey,
  FieldKind,
  FieldSpec,
  FieldSpecs,
  StoredValue,
} from "#shared/rest/field-specs.ts";
import { commaParts } from "#shared/split.ts";
import { RecurringIntervalChoiceSchema } from "#shared/subscriptions/plan.ts";
import {
  IsoDateSchema,
  isUtcInstantOfRealDay,
} from "#shared/validation/date-string.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { isContactField, ListingTypeSchema, MAX_DURATION_DAYS } from "#types";

/** The `fields` column: a comma-separated list of valid contact-field names,
 * so a typo ("fax") is a field error rather than a silently-dropped entry.
 * The parse matches the booking form's own read of the same string. */
export const fieldsSchema = v.pipe(
  v.string(),
  v.transform(commaParts),
  v.array(
    v.custom<string>(
      (value) => typeof value === "string" && isContactField(value),
      "must be a known contact field",
    ),
  ),
  v.transform((parts) => parts.join(",")),
);

/** The same rule for an update, where the caller can leave the column alone. */
export const optionalFieldsSchema = v.optional(fieldsSchema);

const UTC_INSTANT_MESSAGE = "must be a UTC instant of a real calendar day";

/** A time of a real calendar day, in UTC with the `Z` suffix. */
const UtcInstantSchema = v.pipe(
  v.string(),
  v.check(isUtcInstantOfRealDay, UTC_INSTANT_MESSAGE),
);

/** A day-count JSON key: a positive whole number within the bookable range. A
 * typo key ("weekday") or an out-of-range count is then a field error rather
 * than a silently-dropped override. */
const DayCountKeySchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*$/, "day count must be a positive whole number"),
  v.check(
    (key) => Number(key) <= MAX_DURATION_DAYS,
    `day count must be between 1 and ${MAX_DURATION_DAYS}`,
  ),
);

/** Per-day-count prices in minor units, as they appear in JSON. */
export const JsonDayPricesSchema = v.record(
  DayCountKeySchema,
  integerAtLeast(0),
);

/** The value rule of each kind. A count reads its smallest value from the
 *  field. */
const KIND_VALUES: {
  [Kind in FieldKind]: (field: FieldSpec) => v.GenericSchema;
} = {
  contactFields: () => fieldsSchema,
  count: (field) => integerAtLeast(field.min ?? 0),
  date: () => IsoDateSchema,
  // An undated listing stores "".
  datetime: () =>
    v.pipe(
      v.string(),
      v.check(
        (value) => value === "" || isUtcInstantOfRealDay(value),
        UTC_INSTANT_MESSAGE,
      ),
    ),
  dayPrices: () => JsonDayPricesSchema,
  durationDays: () =>
    v.pipe(
      integerAtLeast(1),
      v.maxValue(
        MAX_DURATION_DAYS,
        `must be at most ${MAX_DURATION_DAYS} days`,
      ),
    ),
  listingType: () => ListingTypeSchema,
  name: () => v.pipe(v.string(), v.trim(), v.nonEmpty()),
  optionalDatetime: () => v.nullable(UtcInstantSchema),
  price: () => integerAtLeast(0),
  privateText: () => v.string(),
  recurringInterval: () => RecurringIntervalChoiceSchema,
  sealedText: () => v.pipe(v.string(), v.trim(), v.nonEmpty()),
  switch: () => v.boolean(),
  text: () => v.string(),
  weekdays: () => v.array(v.picklist(VALID_DAY_NAMES)),
};

/** The value rule of one field. */
export const fieldValueSchema = (field: FieldSpec): v.GenericSchema =>
  KIND_VALUES[field.kind](field);

/** The kinds whose form box refuses a fraction with the whole-number rule. A
 *  price box reads a decimal amount, and the duration box has its own rule. */
/* jscpd:ignore-start -- static data, not code */
const WHOLE_NUMBER_KINDS: Record<FieldKind, boolean> = {
  contactFields: false,
  count: true,
  date: false,
  datetime: false,
  dayPrices: false,
  durationDays: false,
  listingType: false,
  name: false,
  optionalDatetime: false,
  price: false,
  privateText: false,
  recurringInterval: false,
  sealedText: false,
  switch: false,
  text: false,
  weekdays: false,
};
/* jscpd:ignore-end */

/** True when the field's form box takes the whole-number rule, the same
 *  rule the API check applies to the body value. */
export const isWholeNumberField = flagOfKind(WHOLE_NUMBER_KINDS);

/** The API refusals that say more than "has an invalid value". */
const API_REFUSALS: Partial<Record<FieldKind, (key: string) => string>> = {
  datetime: (key) => `${key} ${UTC_INSTANT_MESSAGE}`,
  durationDays: (key) =>
    `${key} must be a whole number from 1 to ${MAX_DURATION_DAYS}`,
  optionalDatetime: (key) => `${key} ${UTC_INSTANT_MESSAGE}`,
};

/** The message the JSON API answers when a field refuses its value. */
export const apiRefusal = (field: FieldSpec): string =>
  API_REFUSALS[field.kind]?.(columnName(field.key)) ??
  `${columnName(field.key)} has an invalid value`;

/** Both views of a field that the API reads as an optional value. */
const optionalViews = (field: FieldSpec) => {
  const view = v.optional(fieldValueSchema(field));
  return { create: view, update: view };
};

/** The views that `build` gives for the API key of the field. */
const viewsAtApiKey = <View>(
  build: (key: string) => View,
  field: FieldSpec,
): View => build(columnName(field.key));
const atApiKey = bindFirst(viewsAtApiKey);

/** The create and update wire views of each kind. A name is required text. A
 *  date is a calendar date text. Every other kind is optional. */
const API_FIELDS = {
  contactFields: optionalViews,
  count: optionalViews,
  date: atApiKey(dateField),
  datetime: optionalViews,
  dayPrices: optionalViews,
  durationDays: optionalViews,
  listingType: optionalViews,
  name: atApiKey(textField),
  optionalDatetime: optionalViews,
  price: optionalViews,
  privateText: optionalViews,
  recurringInterval: optionalViews,
  sealedText: atApiKey(textField),
  switch: atApiKey(switchField),
  text: atApiKey(optionalTextField),
  weekdays: optionalViews,
} as const satisfies Record<FieldKind, unknown>;

/** The create and update wire views each kind gives. */
type ApiViews = {
  [Kind in FieldKind]: ReturnType<(typeof API_FIELDS)[Kind]>;
};

/** The wire views of every field, keyed by API key. */
type ApiFieldViews<Fields extends FieldSpecs> = ByColumn<Fields, ApiViews>;

/** The wire views of every field, ready for `apiBodyPair` and `idRow`. */
export const apiFieldsOf = <const Fields extends FieldSpecs>(
  fields: Fields,
): ApiFieldViews<Fields> =>
  // Each API key holds the views of its own field kind.
  Object.fromEntries(
    fields.map((field) => [
      columnName(field.key),
      API_FIELDS[field.kind](field),
    ]),
  ) as ApiFieldViews<Fields>;

/** The value each kind carries in a catalogue transfer. JSON keys are text. */
type TransferValue = Omit<StoredValue, "dayPrices"> & {
  dayPrices: Record<string, number>;
};

/** One transfer of the fields: a required field is always present. */
export type TransferData<Fields extends FieldSpecs> = ByInputKey<
  Extract<Fields[number], { required: true }>,
  TransferValue
> &
  Partial<
    ByInputKey<Exclude<Fields[number], { required: true }>, TransferValue>
  >;

/** The exact transfer object of the fields, keyed by input name. An optional
 *  field is left out rather than given a default, so the importing table
 *  applies its own column default. */
export const transferSchema = <const Fields extends FieldSpecs>(
  fields: Fields,
) =>
  v.pipe(
    v.strictObject(
      Object.fromEntries(
        fields.map((field) => [
          field.key,
          field.required
            ? fieldValueSchema(field)
            : v.optional(fieldValueSchema(field)),
        ]),
      ),
    ),
    // The strict object checked each key against its own field's rule.
    v.transform((value) => value as TransferData<Fields>),
  );
