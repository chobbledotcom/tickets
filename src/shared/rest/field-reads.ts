/** The reads every declared field takes: from a JSON body, from a checked
 *  form, and from a stored row into a catalogue transfer. */

import * as v from "valibot";
import { toCamelCase } from "#db/table.ts";
import {
  optionalDateString,
  parseEach,
  requireDateString,
  writeEntityName,
} from "#shared/rest/crud-parsers.ts";
import {
  byFieldKey,
  type DoorInput,
  type FieldKind,
  type FieldSpec,
  type FieldSpecs,
  type FieldsInput,
  type FieldsRow,
  fieldsOnDoor,
  type ShownField,
} from "#shared/rest/field-specs.ts";
import { apiRefusal, fieldValueSchema } from "#shared/rest/field-values.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";

/** Read the value one JSON write stores. A create reads the supplied value.
 *  An update without a supplied value keeps the stored one. */
type BodyRead = (
  field: FieldSpec,
  body: Record<string, unknown>,
  stored: unknown,
) => Result<unknown>;

/** The supplied text of one key. The schema admits only text or no key. */
const suppliedText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The value a create reads for a field it does not supply. A switch and a
 *  plain text always carry one, because the inputs that hold them require
 *  it. Any other field is left out, so the table applies its column
 *  default at insert. */
const CREATE_VALUES: Partial<Record<FieldKind, (field: FieldSpec) => unknown>> =
  {
    switch: (field) => field.default ?? false,
    text: () => "",
  };

/** The value a JSON `null` writes: an empty value of each text kind. A kind
 *  without one reads `null` as no value. */
const NULL_VALUES: Partial<Record<FieldKind, unknown>> = {
  contactFields: "",
  datetime: "",
  dayPrices: {},
  listingType: "",
  optionalDatetime: "",
  privateText: "",
  text: "",
};

/** The value a field keeps when the body gives none. An update keeps the
 *  stored value, and a create takes the create value of its kind. */
const keptValue = (field: FieldSpec, stored: unknown): unknown =>
  stored ?? CREATE_VALUES[field.kind]?.(field);

/** Read one supplied value through the field's value rule. */
const checkedRead: BodyRead = (field, body, stored) => {
  const value = body[field.key];
  if (value === undefined) return okResult(keptValue(field, stored));
  if (value === null) {
    return okResult(NULL_VALUES[field.kind] ?? keptValue(field, stored));
  }
  return v.is(fieldValueSchema(field), value)
    ? okResult(value)
    : errorResult(apiRefusal(field));
};

const BODY_READS: Record<FieldKind, BodyRead> = {
  contactFields: checkedRead,
  count: checkedRead,
  date: (field, body, stored) =>
    stored === null
      ? requireDateString(body, field.key)
      : optionalDateString(body, field.key, stored as string),
  datetime: checkedRead,
  dayPrices: checkedRead,
  durationDays: checkedRead,
  listingType: checkedRead,
  name: (field, body, stored) =>
    writeEntityName(suppliedText(body[field.key]), stored as string | null),
  optionalDatetime: checkedRead,
  price: checkedRead,
  privateText: checkedRead,
  switch: checkedRead,
  text: checkedRead,
  weekdays: checkedRead,
};

/** The box value, or the declared default when the box sends nothing. */
const orDefault = (value: unknown, field: FieldSpec): unknown =>
  value ?? field.default;

/** The value one checked form box stores. A switch box sends "1" when it is
 *  on. */
const FORM_READS: Record<
  FieldKind,
  (value: unknown, field: FieldSpec) => unknown
> = {
  contactFields: orDefault,
  count: orDefault,
  date: (value, field) =>
    parseDateStringOrThrow(value as string, `the ${field.key} form box`),
  datetime: orDefault,
  dayPrices: orDefault,
  durationDays: orDefault,
  listingType: orDefault,
  name: (value) => value,
  optionalDatetime: orDefault,
  price: orDefault,
  privateText: orDefault,
  switch: (value) => value === "1",
  text: orDefault,
  weekdays: orDefault,
};

/** Key each value that a field read by its input name. A field that read no
 *  value is left out, so a write keeps its stored value or column default. */
const asInput = <Fields extends FieldSpecs>(
  values: readonly (readonly [string, unknown])[],
): FieldsInput<Fields> =>
  // Each entry is the value its own kind read.
  Object.fromEntries(
    values.flatMap(([key, value]) =>
      value === undefined ? [] : [[toCamelCase(key), value]],
    ),
  ) as FieldsInput<Fields>;

/** Read one JSON write into the input the fields declare. The first field
 *  that refuses answers. `stored` is null on create. */
export const readBody = <Fields extends FieldSpecs>(
  fields: Fields,
  body: Record<string, unknown>,
  stored: object | null,
): Result<FieldsInput<Fields>> => {
  const read = parseEach((field: Fields[number]) => {
    const value = BODY_READS[field.kind](
      field,
      body,
      // A stored row holds a column for each of its declared fields.
      stored === null ? null : (stored as Record<string, unknown>)[field.key],
    );
    return value.ok ? okResult([field.key, value.value] as const) : value;
  })(fields);
  return read.ok ? okResult(asInput<Fields>(read.value)) : read;
};

/** The create and update mappers a record's JSON API takes. */
export const bodyMappers = <const Fields extends FieldSpecs>(
  fields: Fields,
) => ({
  toCreateInput: (body: Record<string, unknown>) =>
    readBody(fields, body, null),
  toUpdateInput: (body: Record<string, unknown>, stored: FieldsRow<Fields>) =>
    readBody(fields, body, stored),
});

/** Read the form door's fields of one checked form into their input. */
export const formFieldsInput = <const Fields extends FieldSpecs>(
  fields: Fields,
  values: object,
): DoorInput<Fields, "form"> =>
  // Each entry is the value its own kind read from its own box.
  asInput<Fields>(
    fieldsOnDoor(fields, "form").map((field) => [
      field.key,
      FORM_READS[field.kind](
        (values as Record<string, unknown>)[field.key],
        field,
      ),
    ]),
  ) as unknown as DoorInput<Fields, "form">;

/** Read one checked form into the input the fields declare. */
export const formInput =
  <const Fields extends readonly ShownField[]>(fields: Fields) =>
  (values: Record<Fields[number]["key"], string>): FieldsInput<Fields> =>
    asInput<Fields>(
      Object.entries(
        byFieldKey(fields, (field) =>
          FORM_READS[field.kind](
            values[field.key as Fields[number]["key"]],
            field,
          ),
        ),
      ),
    );

/** True when a stored value carries nothing a transfer must keep. */
const TRANSFER_SKIPS: Partial<Record<FieldKind, (value: unknown) => boolean>> =
  {
    dayPrices: (value) => Object.keys(value as object).length === 0,
  };

/** The transfer values of one stored row, keyed by input name. `withheld`
 *  names the columns the reader cannot see. */
export const transferValues = <const Fields extends FieldSpecs>(
  fields: Fields,
  row: object,
  withheld: readonly string[] = [],
): Record<string, unknown> =>
  Object.fromEntries(
    fieldsOnDoor(fields, "transfer").flatMap((field) => {
      // A stored row holds a column for each of its declared fields.
      const value = (row as Record<string, unknown>)[field.key];
      const skip = TRANSFER_SKIPS[field.kind];
      return withheld.includes(field.key) ||
        value === undefined ||
        skip?.(value)
        ? []
        : [[toCamelCase(field.key), value]];
    }),
  );
