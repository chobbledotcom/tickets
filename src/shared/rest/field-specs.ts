/**
 * One declaration of a record's writable fields. The declaration is a list,
 * so the form order and the refusal order are the list order. Each field
 * names its kind. The stored row and the write input derive here. The table
 * columns, the value checks, the form boxes, and the reads derive in their
 * own layers. Each layer reads a table keyed by the kind. A new kind that one
 * layer forgets is a compile error.
 */

import { requiredMapValue } from "#fp";
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

/** The site features that a field can need. With the feature off, every
 *  write refuses the field. */
export type Feature = "builder" | "logistics";

/** The writers that a field can be locked against. */
export type Lock = "demo" | "editor";

/** Why one write cannot set a field. */
export type ClosedReason = Feature | Lock;

/** The facts about one write that decide which fields it can set. */
export type WriteAccess = {
  readonly demo: boolean;
  readonly editor: boolean;
  readonly features: Readonly<Record<Feature, boolean>>;
};

/** One declared field. `key` is its column and its API key. `header`,
 *  `label`, `hint`, and `placeholder` name catalog entries: the list column
 *  header and the form box texts. A record with its own form leaves them
 *  out. `default` is the stored value a create gets when it gives none.
 *  `feature` names the site feature the field needs. `lockedFor` names the
 *  writers that cannot set it. `min` is the smallest whole number a count
 *  accepts. Each create must supply a `required` field. */
export type FieldSpec = {
  readonly default?: boolean | number | string | readonly string[];
  readonly feature?: Feature;
  readonly header?: string;
  readonly hint?: string;
  readonly key: string;
  readonly kind: FieldKind;
  readonly label?: string;
  readonly lockedFor?: readonly Lock[];
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

/** The JSON body keys the fields accept, each one optional. */
export type FieldsBody<Fields extends FieldSpecs> = {
  [Field in Fields[number] as Field["key"]]?: StoredValue[Field["kind"]];
};

/** Why one write cannot set the field. Null means the write can set it. */
const closedReasonOrNull =
  (access: WriteAccess) =>
  (field: FieldSpec): ClosedReason | null => {
    if (field.feature !== undefined && !access.features[field.feature]) {
      return field.feature;
    }
    return field.lockedFor?.find((lock) => access[lock]) ?? null;
  };

/** The fields that one write cannot set, keyed by column, with the reason. */
export type ClosedFields = ReadonlyMap<string, ClosedReason>;

/** The fields that one write cannot set. */
export const closedFields = (
  fields: FieldSpecs,
  access: WriteAccess,
): ClosedFields =>
  new Map(
    fields.flatMap((field) => {
      const reason = closedReasonOrNull(access)(field);
      return reason === null ? [] : [[field.key, reason] as const];
    }),
  );

/** The refusal for a closed field that a JSON body or a transfer supplies. */
const CLOSED_REFUSALS: Record<ClosedReason, (key: string) => string> = {
  builder: (key) => `${key} needs site building turned on`,
  demo: (key) => `${key} cannot be set in the demo`,
  editor: (key) => `editors cannot set ${key}`,
  logistics: (key) => `${key} needs logistics turned on`,
};

/** The refusal for the first closed field that the values supply. Null
 *  means the values supply no closed field. */
export const closedFieldErrorOrNull = (
  closed: ClosedFields,
  suppliedKeys: readonly string[],
): string | null => {
  const key = suppliedKeys.find((each) => closed.has(each));
  return key === undefined
    ? null
    : CLOSED_REFUSALS[requiredMapValue(closed, key, "Missing closed field")](
        key,
      );
};

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
