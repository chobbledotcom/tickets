/**
 * One declaration of a record's writable fields. The declaration is a list,
 * so the form order and the refusal order are the list order. Each field
 * names its kind. The stored row and the write input derive here. The table
 * columns, the value checks, the form boxes, and the reads derive in their
 * own layers. Each layer reads a table keyed by the kind. A new kind that one
 * layer forgets is a compile error.
 */

import { requiredMapValue } from "#fp";
import { columnName, type SnakeWord } from "#shared/column-names.ts";
import { definedValuesBy } from "#shared/defined-values.ts";
import type { RecurringIntervalChoice } from "#shared/subscriptions/plan.ts";
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
  | "recurringInterval"
  | "sealedText"
  | "switch"
  | "text"
  | "weekdays";

/** The site features that a field can need. With the feature off, every
 *  write refuses the field. */
export type Feature = "attributes" | "builder" | "logistics" | "subscriptions";

/** The writers that a field can be locked against. `nonOwner` is every
 *  writer below the owner. */
export type Lock = "demo" | "editor" | "nonOwner";

/** Why one write cannot set a field. */
export type ClosedReason = Feature | Lock;

/** The facts about one write that decide which fields it can set. */
export type WriteAccess = {
  readonly features: Readonly<Record<Feature, boolean>>;
  readonly locks: Readonly<Record<Lock, boolean>>;
};

/** One declared field. `key` is its form box name and its write input key.
 *  Its column and its API key are the snake_case of `key`. `header`,
 *  `label`, `hint`, and `placeholder` name catalog entries: the list column
 *  header and the form box texts. A record with its own form leaves them
 *  out. `hintPrefix` is literal text before the translated hint.
 *  `exclusive` pairs an either/or checkbox with the other field's key and
 *  the catalog entry that explains the boundary. `default` is the stored
 *  value a create gets when it gives none. `feature` names the site feature
 *  the field needs. `lockedFor` names the writers that cannot set it. `min`
 *  is the smallest whole number a count accepts. `requiredMessageKey` names
 *  the catalog entry for a required box. Each create must supply a
 *  `required` field. */
export type FieldSpec = {
  readonly default?: boolean | number | string | readonly string[];
  /** The other field's key and the catalog key of the refusal that explains
   *  the boundary. Rendered as the `data-exclusive-*` pair. */
  readonly exclusive?: {
    readonly other: string;
    readonly why: string;
  };
  readonly feature?: Feature;
  readonly header?: string;
  readonly hint?: string;
  /** Literal text shown before the translated `hint`. */
  readonly hintPrefix?: string;
  readonly key: string;
  readonly kind: FieldKind;
  readonly label?: string;
  readonly lockedFor?: readonly Lock[];
  /** Set on a text field that holds Markdown. A JSON write keeps the
   *  indentation of the text, because four spaces start a code block. */
  readonly markdown?: true;
  readonly min?: 0 | 1;
  readonly placeholder?: string;
  readonly required?: true;
  /** The catalog key of the refusal for a blank required box. */
  readonly requiredMessageKey?: string;
};

export type FieldSpecs = readonly FieldSpec[];

/** The access rule of one write key: the feature it needs and the writers
 *  it is locked for. A declared field carries one. So does a body key that
 *  links other records and is not a column. */
export type KeyAccess = Pick<FieldSpec, "feature" | "key" | "lockedFor">;

/** The kinds the shared form can render as a box. */
export type FormFieldKind = "date" | "name" | "sealedText" | "switch" | "text";

/** A declared field with the facts its form box reads. */
export type FormField = FieldSpec & {
  readonly kind: FormFieldKind;
  readonly label: string;
};

/** The kinds the shared form and the shared list can show. */
export type ShownKind = Extract<FormFieldKind, "date" | "name" | "sealedText">;

/** A field the shared form and the shared list show, with the list header. */
export type ShownField = FormField & {
  readonly header: string;
  readonly kind: ShownKind;
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
  recurringInterval: RecurringIntervalChoice;
  sealedText: string;
  switch: boolean;
  text: string;
  weekdays: string[];
};

/** The value each kind carries into a write: a date is checked first. */
export type InputValue = Omit<StoredValue, "date"> & { date: DateString };

/** The kind of the field that declares one key. */
export type KindOf<Fields extends FieldSpecs, Key> = Extract<
  Fields[number],
  { key: Key }
>["kind"];

/** One value per field of the union, keyed by input name. `Values` names
 *  the value each kind gives. */
export type ByInputKey<
  Field extends FieldSpec,
  Values extends Record<FieldKind, unknown>,
> = { [Each in Field as Each["key"]]: Values[Each["kind"]] };

/** The stored value of every declared field, keyed by its row field. */
export type FieldsStored<Fields extends FieldSpecs> = ByInputKey<
  Fields[number],
  StoredValue
>;

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
  [Field in Fields[number] as SnakeWord<
    Field["key"]
  >]?: StoredValue[Field["kind"]];
};

/** Why one write cannot set the field. Null means the write can set it. */
const closedReasonOrNull =
  (access: WriteAccess) =>
  (field: KeyAccess): ClosedReason | null => {
    if (field.feature !== undefined && !access.features[field.feature]) {
      return field.feature;
    }
    return field.lockedFor?.find((lock) => access.locks[lock]) ?? null;
  };

/** The fields that one write cannot set, keyed by field name, with the
 *  reason. */
export type ClosedFields = ReadonlyMap<string, ClosedReason>;

/** The fields that one write cannot set. */
export const closedFields = (
  fields: readonly KeyAccess[],
  access: WriteAccess,
): ClosedFields =>
  new Map(
    fields.flatMap((field) => {
      const reason = closedReasonOrNull(access)(field);
      return reason === null ? [] : [[field.key, reason] as const];
    }),
  );

/** The API keys whose feature is off. An API answer leaves these keys
 *  out. */
export const featureClosedKeys = (
  fields: readonly KeyAccess[],
  features: WriteAccess["features"],
): string[] =>
  fields.flatMap((field) =>
    field.feature !== undefined && !features[field.feature]
      ? [columnName(field.key)]
      : [],
  );

/** The closed fields keyed by API key, for a refusal that names the key a
 *  JSON body sent. */
export const apiClosedFields = (closed: ClosedFields): ClosedFields =>
  new Map([...closed].map(([key, reason]) => [columnName(key), reason]));

/** The refusal for a closed field that a JSON body or a transfer supplies. */
const CLOSED_REFUSALS: Record<ClosedReason, (key: string) => string> = {
  attributes: (key) => `${key} needs attributes turned on`,
  builder: (key) => `${key} needs site building turned on`,
  demo: (key) => `${key} cannot be set in the demo`,
  editor: (key) => `editors cannot set ${key}`,
  logistics: (key) => `${key} needs logistics turned on`,
  nonOwner: (key) => `${key} is owner-only`,
  subscriptions: (key) => `${key} needs subscriptions turned on`,
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
    : CLOSED_REFUSALS[requiredMapValue(closed, key)](key);
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

/** One value per declared field, keyed by its field name. */
export const byFieldKey = <const Fields extends FieldSpecs, Value>(
  fields: Fields,
  build: (field: Fields[number]) => Value,
): Record<Fields[number]["key"], Value> =>
  // Each declared key holds the value built from its own field.
  Object.fromEntries(
    fields.map((field: Fields[number]) => [field.key, build(field)]),
  ) as Record<Fields[number]["key"], Value>;

/** The value that `valueFor` gives each declared field, keyed by its field
 *  name. A field whose value is undefined adds no key. */
export const definedByFieldKey = <const Fields extends FieldSpecs>(
  fields: Fields,
  valueFor: (field: Fields[number]) => unknown,
): Record<string, unknown> =>
  definedValuesBy(fields, (field) => field.key, valueFor);

/** One value per declared field, keyed by its column. `Values` names the
 *  value each kind gives. A field of a `Skipped` kind has no key. */
export type ByColumn<
  Fields extends FieldSpecs,
  Values extends Record<FieldKind, unknown>,
  Skipped extends FieldKind = never,
> = {
  [Key in Fields[number]["key"] as KindOf<Fields, Key> extends Skipped
    ? never
    : SnakeWord<Key>]: Values[KindOf<Fields, Key>];
};
