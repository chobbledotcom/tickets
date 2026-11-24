// effects: pure
/**
 * The values that a new row takes for the fields that a write leaves out. A
 * new row starts from these values. A field then keeps its declared default
 * where the table has a different default or none.
 */

import {
  definedByFieldKey,
  type FieldKind,
  type FieldSpec,
  type FieldSpecs,
} from "#shared/rest/field-specs.ts";

/** The first value of a field of each kind. A kind that a new row must give,
 *  or that the table does not store, gives undefined. */
const NEW_ROW_VALUES: Record<FieldKind, (field: FieldSpec) => unknown> = {
  contactFields: (field) => field.default,
  count: (field) => field.default,
  date: () => undefined,
  datetime: () => "",
  dayPrices: () => undefined,
  durationDays: (field) => field.default,
  listingType: (field) => field.default,
  name: () => undefined,
  optionalDatetime: () => undefined,
  price: (field) => field.default,
  privateText: () => "",
  recurringInterval: (field) => field.default,
  sealedText: () => undefined,
  switch: (field) => field.default === true,
  text: () => undefined,
  // A new list must not share the array of the declaration.
  weekdays: (field) =>
    Array.isArray(field.default) ? [...field.default] : undefined,
};

/** The starting value of each field of a new row, by field name. */
export const newRowDefaults = (
  fields: FieldSpecs,
): Readonly<Record<string, unknown>> =>
  definedByFieldKey(fields, (field) => NEW_ROW_VALUES[field.kind](field));
