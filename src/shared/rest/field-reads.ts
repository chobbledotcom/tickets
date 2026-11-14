/** The two reads every declared field takes into a write: from a JSON body
 *  that the resource schema checked, and from a checked form. */

import { toCamelCase } from "#db/table.ts";
import {
  optionalDateString,
  parseEach,
  requireDateString,
  writeEntityName,
} from "#shared/rest/crud-parsers.ts";
import {
  byFieldKey,
  type FieldKind,
  type FieldSpecs,
  type FieldsInput,
  type FieldsRow,
  type FieldsStored,
  type InputValue,
  type ShownField,
  type ShownKind,
  type StoredValue,
} from "#shared/rest/field-specs.ts";
import { okResult, type Result } from "#shared/result.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";

/** Read the value one JSON write stores. A create reads the supplied value.
 *  An update without a supplied value keeps the stored one. */
type BodyRead<Stored, Input> = (
  body: Record<string, unknown>,
  key: string,
  stored: Stored | null,
) => Result<Input>;

type BodyReads = {
  [Kind in FieldKind]: BodyRead<StoredValue[Kind], InputValue[Kind]>;
};

/** One body read, for a caller that holds its field's kind at run time. */
type AnyBodyRead = BodyRead<StoredValue[FieldKind], unknown>;

/** The supplied text of one key. The schema admits only text or no key. */
const suppliedText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const BODY_READS: BodyReads = {
  date: (body, key, stored) =>
    stored === null
      ? requireDateString(body, key)
      : optionalDateString(body, key, stored),
  name: (body, key, stored) => writeEntityName(suppliedText(body[key]), stored),
  // The schema admits only a boolean or no key. A create defaults to off.
  switch: (body, key, stored) =>
    okResult(typeof body[key] === "boolean" ? body[key] : (stored ?? false)),
  text: (body, key, stored) =>
    okResult(suppliedText(body[key]) ?? stored ?? ""),
};

/** The value one checked form box stores, for each kind the form shows. */
const FORM_READS: {
  [Kind in ShownKind]: (value: string, key: string) => InputValue[Kind];
} = {
  date: (value, key) => parseDateStringOrThrow(value, `the ${key} form box`),
  name: (value) => value,
};

/** Key each value that a field read by its input name. */
const asInput = <Fields extends FieldSpecs>(
  values: readonly (readonly [string, unknown])[],
): FieldsInput<Fields> =>
  // Each entry is the value its own kind read.
  Object.fromEntries(
    values.map(([key, value]) => [toCamelCase(key), value]),
  ) as FieldsInput<Fields>;

/** Read one JSON write into the input the fields declare. The first field
 *  that refuses answers. `stored` is null on create. */
const readBody = <Fields extends FieldSpecs>(
  fields: Fields,
  body: Record<string, unknown>,
  stored: FieldsStored<Fields> | null,
): Result<FieldsInput<Fields>> => {
  const read = parseEach((field: Fields[number]) => {
    // The field's own kind picks the read, so its stored value fits it.
    const read = BODY_READS[field.kind] as AnyBodyRead;
    const value = read(
      body,
      field.key,
      stored === null ? null : stored[field.key as Fields[number]["key"]],
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

/** Read one checked form into the input the fields declare. */
export const formInput =
  <const Fields extends readonly ShownField[]>(fields: Fields) =>
  (values: Record<Fields[number]["key"], string>): FieldsInput<Fields> =>
    asInput<Fields>(
      Object.entries(
        byFieldKey(fields, (field) =>
          FORM_READS[field.kind](
            values[field.key as Fields[number]["key"]],
            field.key,
          ),
        ),
      ),
    );
