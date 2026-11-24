/**
 * The fields each documented write accepts. The rows come from the field list
 * or the body schema that the server reads. The docs page therefore cannot
 * leave out a field that the server accepts.
 */

import type * as v from "valibot";
import { columnName } from "#shared/column-names.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { objectEntries } from "#shared/rest/api-body-fields.ts";
import { readBody } from "#shared/rest/field-reads.ts";
import type {
  FieldKind,
  FieldSpec,
  FieldSpecs,
} from "#shared/rest/field-specs.ts";
import { RecurringIntervalSchema } from "#shared/subscriptions/plan.ts";
import { ListingTypeSchema, MAX_DURATION_DAYS } from "#types";
import { TEXT } from "./value-forms.ts";

/** The form of one field's value. The docs page has one text for each form. */
export type ValueForm =
  | { form: "contact_fields" }
  | { form: "date" }
  | { form: "day_prices" }
  | { form: "list_of"; of: ValueForm }
  | { form: "number" }
  | { form: "object"; names: readonly string[] }
  | { form: "one_of"; names: readonly string[] }
  | { form: "or_empty"; of: ValueForm }
  | { form: "or_null"; of: ValueForm }
  | { form: "price" }
  | { form: "switch" }
  | { form: "text" }
  | { form: "time" }
  | { form: "whole_number"; min: number }
  | { form: "whole_number_range"; max: number; min: number };

/** One documented field. `defaultJson` is the value a create stores when the
 *  body leaves the field out, as JSON text. It is null when the body must
 *  supply the field, when the stored value is empty, and on an update, which
 *  keeps the stored value. */
export type FieldDocRow = {
  defaultJson: string | null;
  key: string;
  required: boolean;
  value: ValueForm;
};

/** The field rows of one resource's create and its update. */
export type FieldDocs = {
  create: readonly FieldDocRow[];
  update: readonly FieldDocRow[];
};

const TIME: ValueForm = { form: "time" };

/** The value form of each field kind. */
const KIND_FORMS: Record<FieldKind, (field: FieldSpec) => ValueForm> = {
  contactFields: () => ({ form: "contact_fields" }),
  count: (field) => ({ form: "whole_number", min: field.min ?? 0 }),
  date: () => ({ form: "date" }),
  datetime: () => ({ form: "or_empty", of: TIME }),
  dayPrices: () => ({ form: "day_prices" }),
  durationDays: () => ({
    form: "whole_number_range",
    max: MAX_DURATION_DAYS,
    min: 1,
  }),
  listingType: () => ({ form: "one_of", names: ListingTypeSchema.options }),
  name: () => TEXT,
  optionalDatetime: () => ({ form: "or_null", of: TIME }),
  price: () => ({ form: "price" }),
  privateText: () => TEXT,
  recurringInterval: () => ({
    form: "or_empty",
    of: { form: "one_of", names: RecurringIntervalSchema.options },
  }),
  sealedText: () => TEXT,
  switch: () => ({ form: "switch" }),
  text: () => TEXT,
  weekdays: () => ({
    form: "list_of",
    of: { form: "one_of", names: VALID_DAY_NAMES },
  }),
};

/** JSON text of a value, or null when there is no value to show. */
const jsonOrNull = (value: unknown): string | null =>
  value === undefined || value === "" ? null : JSON.stringify(value);

/** The create row of one declared field. The JSON read of an empty body
 *  decides: a refusal means the body must supply the field. */
const createRow = (field: FieldSpec): FieldDocRow => {
  const read = readBody([field], {}, null, new Map());
  return {
    defaultJson: read.ok
      ? jsonOrNull(field.default ?? Object.values(read.value)[0])
      : null,
    key: columnName(field.key),
    required: !read.ok,
    value: KIND_FORMS[field.kind](field),
  };
};

/** A body key that a write declares for itself, such as a list of linked ids
 *  or a booking line. */
export type ExtraField = {
  /** The one verb that takes the key. Absent means both verbs take it. */
  only?: "create" | "update";
  /** The key a create cannot go without. An update never requires a key. */
  required?: boolean;
  value: ValueForm;
};

/** The body keys a write declares for itself, by key. */
export type ExtraFieldMap = Readonly<Record<string, ExtraField>>;

const byKey = (rows: FieldDocRow[]): FieldDocRow[] =>
  rows.toSorted((a, b) => a.key.localeCompare(b.key));

/** The create row of one declared body key. */
const extraRow = (key: string, field: ExtraField): FieldDocRow => ({
  defaultJson: null,
  key,
  required: field.required === true,
  value: field.value,
});

/** What an update row says beside its create row: nothing is required, and
 *  the stored value is the default. */
const UPDATE_FACTS = { defaultJson: null, required: false };

/** The rows of a create and of an update, each sorted by key. An update row
 *  is the create row with no requirement: an update can leave every key out,
 *  and it keeps the stored value. */
const fieldDocsOf = (
  create: readonly FieldDocRow[],
  update: readonly FieldDocRow[],
): FieldDocs => ({
  create: byKey([...create]),
  update: byKey(update.map((row) => ({ ...row, ...UPDATE_FACTS }))),
});

/** Whether a verb takes one declared key: the viewer can set it, and no other
 *  verb owns it. */
const takesKey =
  (verb: "create" | "update", closed: ReadonlySet<string>) =>
  ([key, field]: readonly [string, ExtraField]): boolean =>
    !closed.has(key) && (field.only === undefined || field.only === verb);

/** The rows of the body keys that a write declares for itself, after the rows
 *  of its field list. A key that the viewer cannot set has no row. */
export const extraFieldDocs = (
  extras: ExtraFieldMap,
  closed: ReadonlySet<string>,
  listed: readonly FieldDocRow[] = [],
): FieldDocs => {
  const rowsFor = (verb: "create" | "update"): FieldDocRow[] => [
    ...listed,
    ...Object.entries(extras).flatMap((entry) =>
      takesKey(verb, closed)(entry) ? [extraRow(...entry)] : [],
    ),
  ];
  return fieldDocsOf(rowsFor("create"), rowsFor("update"));
};

/** The field rows of a resource that a field list declares. A key that the
 *  viewer cannot set has no row. */
export const specFieldDocs = (
  fields: FieldSpecs,
  extras: ExtraFieldMap,
  closed: ReadonlySet<string>,
): FieldDocs =>
  extraFieldDocs(
    extras,
    closed,
    fields.filter((field) => !closed.has(columnName(field.key))).map(createRow),
  );

/** The valibot schemas a write body is made of. */
type BodyValueSchema =
  | v.ArraySchema<v.GenericSchema, undefined>
  | v.BooleanSchema<undefined>
  | v.NullableSchema<v.GenericSchema, undefined>
  | v.NumberSchema<undefined>
  | v.ObjectSchema<v.ObjectEntries, undefined>
  | v.OptionalSchema<v.GenericSchema, undefined>
  | v.PicklistSchema<readonly string[], undefined>
  | v.StringSchema<undefined>;

/** The value form of one body schema. A schema of a type with no form here
 *  stops the docs page, so a new body shape cannot go undocumented. */
export const schemaForm = (schema: v.GenericSchema): ValueForm => {
  // Valibot names each schema by its type, and each type carries its parts.
  const known = schema as BodyValueSchema;
  switch (known.type) {
    case "array":
      return { form: "list_of", of: schemaForm(known.item) };
    case "boolean":
      return { form: "switch" };
    case "nullable":
      return { form: "or_null", of: schemaForm(known.wrapped) };
    case "number":
      return { form: "number" };
    case "object":
      return { form: "object", names: Object.keys(known.entries) };
    case "optional":
      return schemaForm(known.wrapped);
    case "picklist":
      return { form: "one_of", names: known.options };
    case "string":
      return TEXT;
    default:
      throw new Error(`No documented value form for a ${schema.type} schema`);
  }
};

/** The field rows of one write body schema. */
export const schemaRows = (schema: v.GenericSchema): FieldDocRow[] => {
  const entries = objectEntries(schema);
  if (entries === null) {
    throw new Error(`A documented body must be an object, not ${schema.type}`);
  }
  return byKey(
    Object.entries(entries).map(([key, entry]) => ({
      defaultJson: null,
      key,
      required: entry.type !== "optional",
      value: schemaForm(entry),
    })),
  );
};
