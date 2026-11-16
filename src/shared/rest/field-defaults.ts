// effects: pure
/**
 * The values that a new row takes for the fields that a write leaves out. A
 * new row starts from these values. A field then keeps its declared default
 * where the table has a different default or none.
 */

import type {
  FieldKind,
  FieldSpec,
  FieldSpecs,
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
  switch: (field) => field.default === true,
  text: () => undefined,
  // A new list must not share the array of the declaration.
  weekdays: (field) =>
    Array.isArray(field.default) ? [...field.default] : undefined,
};

/** The starting value of each field of a new row, by column. */
export const newRowDefaults = (
  fields: FieldSpecs,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const value = NEW_ROW_VALUES[field.kind](field);
      return value === undefined ? [] : [[field.key, value]];
    }),
  );
