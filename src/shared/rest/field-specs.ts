/**
 * One declaration of a record's writable fields. The declaration is a list,
 * so the form order and the refusal order are the list order. Each field
 * names its kind. The stored row, the write input, and the API write views
 * derive here. The table columns, the form boxes, and the reads derive in
 * their own layers. Each layer reads a table keyed by the kind. A new kind
 * that one layer forgets is a compile error.
 */

import {
  dateField,
  optionalTextField,
  switchField,
  textField,
} from "#shared/rest/api-body-fields.ts";
import type { DateString } from "#shared/validation/date-string.ts";

/** One declared field. `key` is its column and its API key. `header`,
 *  `label`, `hint`, and `placeholder` name catalog entries: the list column
 *  header and the form box texts. A record with its own form leaves them
 *  out. */
export type FieldSpec = {
  readonly header?: string;
  readonly hint?: string;
  readonly key: string;
  readonly kind: FieldKind;
  readonly label?: string;
  readonly placeholder?: string;
};

export type FieldSpecs = readonly FieldSpec[];

/** The wire views of each kind. A name is required text. A date is a
 *  calendar date text. A switch and a text are optional. */
const API_FIELDS = {
  date: dateField,
  name: textField,
  switch: switchField,
  text: optionalTextField,
} as const;

/** The kinds of field a record can declare. */
export type FieldKind = keyof typeof API_FIELDS;

/** The kinds the shared form and the shared list can show. */
export type ShownKind = "date" | "name";

/** A field the shared form and the shared list show, with their texts. */
export type ShownField = FieldSpec & {
  readonly header: string;
  readonly kind: ShownKind;
  readonly label: string;
};

/** The value each kind stores. */
export type StoredValue = {
  date: string;
  name: string;
  switch: boolean;
  text: string;
};

/** The value each kind carries into a write: a date is checked first. */
export type InputValue = Omit<StoredValue, "date"> & { date: DateString };

/** A stored column name as its input key: `start_date` becomes `startDate`. */
type InputKey<Key extends string> = Key extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<InputKey<Tail>>}`
  : Key;

/** The kind of the field that declares one key. */
type KindOf<Fields extends FieldSpecs, Key> = Extract<
  Fields[number],
  { key: Key }
>["kind"];

/** The stored value of every declared field, keyed by column. */
export type FieldsStored<Fields extends FieldSpecs> = {
  [Key in Fields[number]["key"]]: StoredValue[KindOf<Fields, Key>];
};

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

/** One value per declared field, keyed by its column. */
export const byFieldKey = <const Fields extends FieldSpecs, Value>(
  fields: Fields,
  build: (field: Fields[number]) => Value,
): Record<Fields[number]["key"], Value> =>
  // Each declared key holds the value built from its own field.
  Object.fromEntries(
    fields.map((field: Fields[number]) => [field.key, build(field)]),
  ) as Record<Fields[number]["key"], Value>;

/** One value per declared field, typed by the kind of each field. `Values`
 *  names the value each kind gives. */
export type ByFieldKind<
  Fields extends FieldSpecs,
  Values extends Record<FieldKind, unknown>,
> = { [Key in Fields[number]["key"]]: Values[KindOf<Fields, Key>] };

/** One value per declared field, built from the entry of its own kind. */
export const byFieldKind = <
  const Fields extends FieldSpecs,
  Values extends Record<FieldKind, unknown>,
>(
  fields: Fields,
  build: (field: Fields[number]) => Values[FieldKind],
): ByFieldKind<Fields, Values> =>
  // Each key holds the value its own kind gives.
  byFieldKey(fields, build) as ByFieldKind<Fields, Values>;

/** The create and update wire views each kind gives. */
type ApiViews = {
  [Kind in FieldKind]: ReturnType<(typeof API_FIELDS)[Kind]>;
};

/** The wire views of every field, ready for `apiBodyPair` and `idRow`. */
export const apiFieldsOf = <const Fields extends FieldSpecs>(fields: Fields) =>
  byFieldKind<Fields, ApiViews>(fields, (field) =>
    API_FIELDS[field.kind](field.key),
  );
