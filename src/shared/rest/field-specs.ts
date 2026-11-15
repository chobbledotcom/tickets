/**
 * One declaration of a record's writable fields. The declaration is a list,
 * so the form order and the refusal order are the list order. Each field
 * names its kind. The stored row and the write input derive here. The table
 * columns, the value checks, the form boxes, and the reads derive in their
 * own layers. Each layer reads a table keyed by the kind. A new kind that one
 * layer forgets is a compile error.
 */

import type { DateString } from "#shared/validation/date-string.ts";
import type { DayPrices, ListingFields, ListingType } from "#types";

/** The kinds of field a record can declare. */
export type FieldKind =
  | "contactFields"
  | "count"
  | "date"
  | "datetime"
  | "dayPrices"
  | "durationDays"
  | "listingType"
  | "name"
  | "optionalDatetime"
  | "price"
  | "privateText"
  | "switch"
  | "text"
  | "weekdays";

/** The places that read a field with the shared reads: the JSON API, the
 *  dashboard form, and catalogue transfer. */
export type Door = "api" | "form" | "transfer";

/** One declared field. `key` is its column and its API key. `header`,
 *  `label`, `hint`, and `placeholder` name catalog entries: the list column
 *  header and the form box texts. A record with its own form leaves them
 *  out. `default` is the stored value a create gets when it gives none.
 *  `doors` names the shared reads that take the field: all of them when it is
 *  absent. `min` is the smallest whole number a count accepts. A `required`
 *  field must be in each transfer. */
export type FieldSpec = {
  readonly default?: boolean | number | string | readonly string[];
  readonly doors?: readonly Door[];
  readonly header?: string;
  readonly hint?: string;
  readonly key: string;
  readonly kind: FieldKind;
  readonly label?: string;
  readonly min?: 0 | 1;
  readonly placeholder?: string;
  readonly required?: true;
};

export type FieldSpecs = readonly FieldSpec[];

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
  contactFields: ListingFields;
  count: number;
  date: string;
  datetime: string;
  dayPrices: DayPrices;
  durationDays: number;
  listingType: ListingType;
  name: string;
  optionalDatetime: string | null;
  price: number;
  privateText: string;
  switch: boolean;
  text: string;
  weekdays: string[];
};

/** The value each kind carries into a write: a date is checked first. */
export type InputValue = Omit<StoredValue, "date"> & { date: DateString };

/** A stored column name as its input key: `start_date` becomes `startDate`. */
export type InputKey<Key extends string> =
  Key extends `${infer Head}_${infer Tail}`
    ? `${Head}${Capitalize<InputKey<Tail>>}`
    : Key;

/** The kind of the field that declares one key. */
type KindOf<Fields extends FieldSpecs, Key> = Extract<
  Fields[number],
  { key: Key }
>["kind"];

/** The stored value of every declared field, keyed by column. */
export type FieldsStored<Fields extends FieldSpecs> = ByFieldKind<
  Fields,
  StoredValue
>;

/** One value per field of the union, keyed by input name. `Values` names
 *  the value each kind gives. */
export type ByInputKey<
  Field extends FieldSpec,
  Values extends Record<FieldKind, unknown>,
> = { [Each in Field as InputKey<Each["key"]>]: Values[Each["kind"]] };

/** The stored row the fields declare, with its id. */
export type FieldsRow<Fields extends FieldSpecs> = FieldsStored<Fields> & {
  id: number;
};

/** The write input the fields declare, keyed in camelCase. */
export type FieldsInput<Fields extends FieldSpecs> = ByInputKey<
  Fields[number],
  InputValue
>;

/** The write input the fields declare, each field optional. A write that
 *  leaves a field out keeps its stored value or takes its column default. */
export type OptionalFieldsInput<Fields extends FieldSpecs> = {
  [Key in keyof FieldsInput<Fields>]?: FieldsInput<Fields>[Key] | undefined;
};

/** The fields that one door reads. */
export type OnDoor<Fields extends FieldSpecs, Through extends Door> = Exclude<
  Fields[number],
  { readonly doors: readonly Exclude<Door, Through>[] }
>;

/** The write input of the fields one door reads, keyed in camelCase. */
export type DoorInput<
  Fields extends FieldSpecs,
  Through extends Door,
> = ByInputKey<OnDoor<Fields, Through>, InputValue>;

/** The JSON body keys one door's fields accept, each one optional. */
export type FieldsBody<Fields extends FieldSpecs> = {
  [Field in OnDoor<Fields, "api"> as Field["key"]]?: StoredValue[Field["kind"]];
};

/** True when one door reads the field. */
const readsThrough = (door: Door, field: FieldSpec): boolean =>
  field.doors === undefined || field.doors.includes(door);

/** The fields that one door reads, in declaration order. */
export const fieldsOnDoor = <
  const Fields extends FieldSpecs,
  Through extends Door,
>(
  fields: Fields,
  door: Through,
): readonly OnDoor<Fields, Through>[] =>
  fields.filter((field): field is OnDoor<Fields, Through> =>
    readsThrough(door, field),
  );

/** The declared field of one key. A caller names a key of its own list. */
export const fieldOfKey = <
  const Fields extends FieldSpecs,
  Key extends Fields[number]["key"],
>(
  fields: Fields,
  key: Key,
): Extract<Fields[number], { key: Key }> => {
  const field = fields.find((each) => each.key === key);
  if (field === undefined) throw new Error(`No declared field ${key}`);
  // The field found by its key is the one the key names.
  return field as Extract<Fields[number], { key: Key }>;
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
