/**
 * The fields each documented write accepts. The rows come from the field list
 * or the body schema that the server reads. The docs page therefore cannot
 * leave out a field that the server accepts.
 */

import type * as v from "valibot";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { objectEntries } from "#shared/rest/api-body-fields.ts";
import { readBody } from "#shared/rest/field-reads.ts";
import type {
  ClosedReason,
  FieldKind,
  FieldSpec,
  FieldSpecs,
} from "#shared/rest/field-specs.ts";
import { ListingTypeSchema, MAX_DURATION_DAYS } from "#types";

/** The form of one field's value. The docs page has one text for each form. */
export type ValueForm =
  | { form: "contactFields" }
  | { form: "date" }
  | { form: "dayPrices" }
  | { form: "listOf"; of: ValueForm }
  | { form: "number" }
  | { form: "object"; names: readonly string[] }
  | { form: "oneOf"; names: readonly string[] }
  | { form: "orEmpty"; of: ValueForm }
  | { form: "orNull"; of: ValueForm }
  | { form: "price" }
  | { form: "switch" }
  | { form: "text" }
  | { form: "time" }
  | { form: "wholeNumber"; min: number }
  | { form: "wholeNumberRange"; max: number; min: number };

/** Why some writers cannot set a field. */
export type FieldLimit = ClosedReason | "owner";

/** One documented field. `defaultJson` is the value a create stores when the
 *  body leaves the field out, as JSON text. It is null when the body must
 *  supply the field, when the stored value is empty, and on an update, which
 *  keeps the stored value. */
export type FieldDocRow = {
  defaultJson: string | null;
  key: string;
  limits: readonly FieldLimit[];
  required: boolean;
  value: ValueForm;
};

/** The field rows of one resource's create and its update. */
export type FieldDocs = {
  create: readonly FieldDocRow[];
  update: readonly FieldDocRow[];
};

const TIME: ValueForm = { form: "time" };
const TEXT: ValueForm = { form: "text" };

/** The value form of each field kind. */
const KIND_FORMS: Record<FieldKind, (field: FieldSpec) => ValueForm> = {
  contactFields: () => ({ form: "contactFields" }),
  count: (field) => ({ form: "wholeNumber", min: field.min ?? 0 }),
  date: () => ({ form: "date" }),
  datetime: () => ({ form: "orEmpty", of: TIME }),
  dayPrices: () => ({ form: "dayPrices" }),
  durationDays: () => ({
    form: "wholeNumberRange",
    max: MAX_DURATION_DAYS,
    min: 1,
  }),
  listingType: () => ({ form: "oneOf", names: ListingTypeSchema.options }),
  name: () => TEXT,
  optionalDatetime: () => ({ form: "orNull", of: TIME }),
  price: () => ({ form: "price" }),
  privateText: () => TEXT,
  switch: () => ({ form: "switch" }),
  text: () => TEXT,
  weekdays: () => ({
    form: "listOf",
    of: { form: "oneOf", names: VALID_DAY_NAMES },
  }),
};

/** The limits a field declares: the feature it needs, then its locks. */
const limitsOf = (field: FieldSpec): FieldLimit[] => [
  ...(field.feature === undefined ? [] : [field.feature]),
  ...(field.lockedFor ?? []),
];

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
    key: field.key,
    limits: limitsOf(field),
    required: !read.ok,
    value: KIND_FORMS[field.kind](field),
  };
};

/** A body key that no field list declares, such as a list of linked ids. */
export type ExtraField = {
  limits: readonly FieldLimit[];
  /** The one verb that takes the key. Absent means both verbs take it. */
  only?: "update";
  value: ValueForm;
};

const byKey = (rows: FieldDocRow[]): FieldDocRow[] =>
  rows.toSorted((a, b) => a.key.localeCompare(b.key));

/** The field rows of a resource that a field list declares. */
export const specFieldDocs = (
  fields: FieldSpecs,
  extras: Readonly<Record<string, ExtraField>>,
): FieldDocs => {
  const declared = fields.map(createRow);
  const extra = Object.entries(extras).map(([key, field]) => ({
    only: field.only,
    row: {
      defaultJson: null,
      key,
      limits: field.limits,
      required: false,
      value: field.value,
    },
  }));
  return {
    create: byKey([
      ...declared,
      ...extra.filter(({ only }) => only === undefined).map(({ row }) => row),
    ]),
    // An update can leave every field out, and it keeps the stored value.
    update: byKey([...declared, ...extra.map(({ row }) => row)]).map((row) => ({
      ...row,
      defaultJson: null,
      required: false,
    })),
  };
};

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
      return { form: "listOf", of: schemaForm(known.item) };
    case "boolean":
      return { form: "switch" };
    case "nullable":
      return { form: "orNull", of: schemaForm(known.wrapped) };
    case "number":
      return { form: "number" };
    case "object":
      return { form: "object", names: Object.keys(known.entries) };
    case "optional":
      return schemaForm(known.wrapped);
    case "picklist":
      return { form: "oneOf", names: known.options };
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
      limits: [],
      required: entry.type !== "optional",
      value: schemaForm(entry),
    })),
  );
};
