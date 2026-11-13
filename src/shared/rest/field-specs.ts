/**
 * One declaration of a record's writable fields. The declaration is a list,
 * so the form order and the refusal order are the list order. Each field
 * names its kind. The stored row, the write input, and the API write views
 * derive here. The table columns, the form boxes, and the reads derive in
 * their own layers. Each layer reads a table keyed by the kind. A new kind
 * that one layer forgets is a compile error.
 */

import {
  type BodyField,
  dateField,
  textField,
} from "#shared/rest/api-body-fields.ts";
import type { DateString } from "#shared/validation/date-string.ts";

/** One declared field. `key` is its column and its API key. `header`,
 *  `label`, `hint`, and `placeholder` name catalog entries: the list column
 *  header and the form box texts. */
export type FieldSpec = {
  readonly header: string;
  readonly hint?: string;
  readonly key: string;
  readonly kind: FieldKind;
  readonly label: string;
  readonly placeholder?: string;
};

export type FieldSpecs = readonly FieldSpec[];

/** The wire views of each kind. A name is required text. A date is a
 *  calendar date text. */
const API_FIELDS = { date: dateField, name: textField } as const;

/** The kinds of field a record can declare. */
export type FieldKind = keyof typeof API_FIELDS;

/** The value each kind carries into a write: a date is checked first. */
type InputValue = { date: DateString; name: string };

/** A stored column name as its input key: `start_date` becomes `startDate`. */
type InputKey<Key extends string> = Key extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<InputKey<Tail>>}`
  : Key;

/** The stored text of every declared field, keyed by column. Every kind
 *  stores text. */
export type FieldsStored<Fields extends FieldSpecs> = Record<
  Fields[number]["key"],
  string
>;

/** The stored row the fields declare, with its id. */
export type FieldsRow<Fields extends FieldSpecs> = FieldsStored<Fields> & {
  id: number;
};

/** The write input the fields declare, keyed in camelCase. */
export type FieldsInput<Fields extends FieldSpecs> = {
  [Field in Fields[number] as InputKey<
    Field["key"]
  >]: InputValue[Field["kind"]];
};

/** The create and update wire views of every field, keyed by column. */
type ApiFieldsOf<Fields extends FieldSpecs> = {
  [Key in Fields[number]["key"]]: ReturnType<
    (typeof API_FIELDS)[Extract<Fields[number], { key: Key }>["kind"]]
  >;
};

/** One value per declared field, keyed by its column. */
export const byFieldKey = <const Fields extends FieldSpecs, Value>(
  fields: Fields,
  build: (field: Fields[number]) => Value,
): Record<Fields[number]["key"], Value> =>
  // Each declared key holds the value built from its own field.
  Object.fromEntries(
    fields.map((field: Fields[number]) => [field.key, build(field)]),
  ) as Record<Fields[number]["key"], Value>;

/** The wire views of every field, ready for `apiBodyPair` and `idRow`. */
export const apiFieldsOf = <const Fields extends FieldSpecs>(
  fields: Fields,
): ApiFieldsOf<Fields> =>
  // Each key holds the view its own kind builds, so the record is the
  // mapped type above.
  byFieldKey(
    fields,
    (field): BodyField => API_FIELDS[field.kind](field.key),
  ) as ApiFieldsOf<Fields>;
