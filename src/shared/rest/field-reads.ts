/** The reads every declared field takes: from a JSON body, from a checked
 *  form, and from a stored row into a catalogue transfer. */

import * as v from "valibot";
import { toCamelCase } from "#shared/column-names.ts";
import { normalizeDatetime } from "#shared/dates.ts";
import {
  optionalDateString,
  parseEach,
  requireDateString,
  writeEntityName,
} from "#shared/rest/crud-parsers.ts";
import {
  byFieldKey,
  type ClosedFields,
  closedFieldErrorOrNull,
  type FieldKind,
  type FieldSpec,
  type FieldSpecs,
  type FieldsInput,
  type FieldsRow,
  type ShownField,
} from "#shared/rest/field-specs.ts";
import { apiRefusal, fieldValueSchema } from "#shared/rest/field-values.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { commaParts } from "#shared/split.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";

/** Read the value one JSON write stores. A create reads the supplied value.
 *  An update without a supplied value keeps the stored one. */
type BodyRead = (
  field: FieldSpec,
  body: Record<string, unknown>,
  stored: unknown,
) => Result<unknown>;

/** Read one name. An update without a name keeps the stored one. */
const nameRead: BodyRead = (field, body, stored) => {
  const name = body[field.key];
  return name === undefined || typeof name === "string"
    ? writeEntityName(name, stored as string | null)
    : errorResult(`${field.key} must be a string`);
};

/** The value a create reads for a field it does not supply. A switch and a
 *  plain text always carry one, because the inputs that hold them require
 *  it. Any other field is left out, so the table applies its column
 *  default at insert. */
const CREATE_VALUES: Partial<Record<FieldKind, (field: FieldSpec) => unknown>> =
  {
    recurringInterval: () => "",
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
  recurringInterval: "",
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
  name: nameRead,
  optionalDatetime: checkedRead,
  price: checkedRead,
  privateText: checkedRead,
  recurringInterval: checkedRead,
  switch: checkedRead,
  text: checkedRead,
  weekdays: checkedRead,
};

/** The box value, or the declared default when the box sends nothing. */
const orDefault = (value: unknown, field: FieldSpec): unknown =>
  value ?? field.default;

/** A local time box as the stored UTC time. An empty box stays empty. */
const formTime = (value: unknown, field: FieldSpec): string =>
  value === "" ? "" : normalizeDatetime(value as string, field.key);

/** The value one checked form box stores. A switch box sends "1" when it is
 *  on. A price box holds an amount in major units, and its own check refused
 *  anything else. A time box holds a local time. */
const FORM_READS: Record<
  FieldKind,
  (value: unknown, field: FieldSpec) => unknown
> = {
  contactFields: orDefault,
  count: orDefault,
  date: (value, field) =>
    parseDateStringOrThrow(value as string, `the ${field.key} form box`),
  datetime: formTime,
  dayPrices: orDefault,
  durationDays: orDefault,
  listingType: orDefault,
  name: (value) => value,
  optionalDatetime: (value, field) => formTime(value, field) || null,
  price: (value, field) => {
    const amount =
      value === "" ? field.default : parseOptionalMinorUnits(value as string);
    if (amount === null || amount === undefined) {
      throw new Error(`The ${field.key} form box holds no price`);
    }
    return amount;
  },
  privateText: orDefault,
  recurringInterval: orDefault,
  switch: (value) => value === "1",
  text: orDefault,
  weekdays: (value) => commaParts(value as string),
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

/** One JSON write: the body, and the stored row or null on create. */
type BodyWrite = readonly [
  body: Record<string, unknown>,
  stored: object | null,
];

/** Read one field of a JSON write. A create must supply a required field. */
const fieldOfBody = (
  field: FieldSpec,
  ...[body, stored]: BodyWrite
): Result<unknown> => {
  if (stored === null) {
    return field.required && (body[field.key] ?? null) === null
      ? errorResult(`${field.key} is required`)
      : BODY_READS[field.kind](field, body, null);
  }
  // A stored row holds a column for each of its declared fields.
  const kept = (stored as Record<string, unknown>)[field.key];
  return BODY_READS[field.kind](field, body, kept);
};

/** Read one JSON write into the input the fields declare. A closed field
 *  that the body supplies answers first. Then the first field that refuses
 *  answers. `stored` is null on create. */
export const readBody = <Fields extends FieldSpecs>(
  fields: Fields,
  body: Record<string, unknown>,
  stored: object | null,
  closed: ClosedFields,
): Result<FieldsInput<Fields>> => {
  const refusal = closedFieldErrorOrNull(closed, Object.keys(body));
  if (refusal !== null) return errorResult(refusal);
  const read = parseEach((field: Fields[number]) => {
    const value = fieldOfBody(field, body, stored);
    return value.ok ? okResult([field.key, value.value] as const) : value;
  })(fields);
  return read.ok ? okResult(asInput<Fields>(read.value)) : read;
};

/** A field that every writer can set. */
type OpenField = FieldSpec & { feature?: never; lockedFor?: never };

/** No field of an open record is closed to any writer. */
const NOTHING_CLOSED: ClosedFields = new Map();

/** Read one JSON write of a record whose every field is open. The read does
 *  not need to know the writer. */
export const readOpenBody = <const Fields extends readonly OpenField[]>(
  fields: Fields,
  ...write: BodyWrite
): Result<FieldsInput<Fields>> => readBody(fields, ...write, NOTHING_CLOSED);

/** The create and update mappers a record's JSON API takes. */
export const bodyMappers = <const Fields extends readonly OpenField[]>(
  fields: Fields,
) => ({
  toCreateInput: (body: Record<string, unknown>) =>
    readOpenBody(fields, body, null),
  toUpdateInput: (body: Record<string, unknown>, stored: FieldsRow<Fields>) =>
    readOpenBody(fields, body, stored),
});

/** Read the fields that one checked form showed. A field the page did not
 *  show is left out, so the write keeps its stored value or column
 *  default. */
export const formFieldsInput = <const Fields extends FieldSpecs>(
  fields: Fields,
  values: object,
  shown: ReadonlySet<string>,
): FieldsInput<Fields> =>
  // Each entry is the value its own kind read from its own box.
  asInput<Fields>(
    fields
      .filter((field) => shown.has(field.key))
      .map((field) => [
        field.key,
        FORM_READS[field.kind](
          (values as Record<string, unknown>)[field.key],
          field,
        ),
      ]),
  );

/** The declared field keys of the boxes one form page shows. `extra` names
 *  the declared keys that the page shows outside its form definition. */
export const shownFieldKeys = (
  fields: FieldSpecs,
  boxes: readonly { readonly name: string; readonly visible?: boolean }[],
  extra: readonly string[],
): ReadonlySet<string> => {
  const shownBoxes = new Set([
    ...boxes.filter((box) => box.visible !== false).map((box) => box.name),
    ...extra,
  ]);
  return new Set(
    fields.map((field) => field.key).filter((key) => shownBoxes.has(key)),
  );
};

/** The first declared key that a form sends although its page did not show
 *  the box. Null means the form sends only boxes its page showed. */
export const unshownFieldOrNull = (
  fields: FieldSpecs,
  submittedKeys: readonly string[],
  shown: ReadonlySet<string>,
): string | null =>
  fields
    .map((field) => field.key)
    .find((key) => submittedKeys.includes(key) && !shown.has(key)) ?? null;

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
 *  names the fields the reader cannot see or set. A record whose every field
 *  is open withholds none. */
export const transferValues = <const Fields extends FieldSpecs>(
  fields: Fields,
  row: object,
  withheld: ClosedFields = NOTHING_CLOSED,
): Record<string, unknown> =>
  Object.fromEntries(
    fields.flatMap((field) => {
      // A stored row holds a column for each of its declared fields.
      const value = (row as Record<string, unknown>)[field.key];
      const skip = TRANSFER_SKIPS[field.kind];
      return withheld.has(field.key) || value === undefined || skip?.(value)
        ? []
        : [[toCamelCase(field.key), value]];
    }),
  );

/** The refusal for the first closed field that one transfer supplies, named
 *  by its transfer key. Null means the transfer supplies no closed field. */
export const transferClosedErrorOrNull = (
  closed: ClosedFields,
  data: object,
): string | null =>
  closedFieldErrorOrNull(
    new Map([...closed].map(([key, reason]) => [toCamelCase(key), reason])),
    Object.keys(data),
  );
