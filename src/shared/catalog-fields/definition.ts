import type * as v from "valibot";
import type { ColumnDef } from "#shared/db/table.ts";

const TRANSFER_KINDS = {
  bookableDays: "array",
  boolean: "boolean",
  datetime: "string",
  dayPrices: "object",
  durationDays: "number",
  fields: "string",
  listingType: "string",
  maxPrice: "number",
  name: "string",
  nonNegativeInt: "number",
  nullableDatetime: "string",
  positiveInt: "number",
  price: "number",
  requiredPositiveInt: "number",
  string: "string",
} as const satisfies Record<
  string,
  "array" | "boolean" | "number" | "object" | "string"
>;

type TransferName = keyof typeof TRANSFER_KINDS;

type CatalogField = readonly [
  string,
  object | undefined,
  TransferName?,
  (0 | 1 | 2 | 3)?,
  unknown?,
];

type CatalogFieldSet = Record<string, CatalogField>;

type FieldValue<Field extends CatalogField> =
  Field[1] extends ColumnDef<infer Value>
    ? Value
    : Field[2] extends "nullableDatetime"
      ? string | null
      : string;

export type OptionalCatalogFieldValues<Fields extends CatalogFieldSet> = {
  -readonly [Key in keyof Fields]?: FieldValue<Fields[Key]> | undefined;
};

type UsedKeys<Fields extends CatalogFieldSet, Use extends 1 | 2> = {
  [Key in keyof Fields]: Fields[Key][3] extends Use | 3 ? Key : never;
}[keyof Fields];

export type CatalogApiBody<Fields extends CatalogFieldSet> = {
  [Key in UsedKeys<Fields, 1> as Fields[Key][0]]?: FieldValue<Fields[Key]>;
};

type FormValues<Fields extends CatalogFieldSet> = {
  [Key in UsedKeys<Fields, 2>]: FieldValue<Fields[Key]>;
};

type StorageColumns<Fields extends CatalogFieldSet> = {
  [Key in keyof Fields as Fields[Key][1] extends object
    ? Fields[Key][0]
    : never]: Fields[Key][1];
};
type TransferFields<
  Fields extends CatalogFieldSet,
  Schemas extends Record<string, v.GenericSchema>,
> = {
  [Key in keyof Fields as Fields[Key][2] extends keyof Schemas
    ? Key
    : never]: Schemas[Fields[Key][2] & keyof Schemas];
};

type ProjectionMode =
  | "api"
  | "columns"
  | "form"
  | "schema"
  | "storedApi"
  | "transfer";

type CatalogProjection<
  Fields extends CatalogFieldSet,
  Mode extends ProjectionMode,
  Source,
> = Mode extends "columns"
  ? StorageColumns<Fields>
  : Mode extends "schema"
    ? TransferFields<Fields, Source & Record<string, v.GenericSchema>>
    : Mode extends "form"
      ? FormValues<Fields>
      : OptionalCatalogFieldValues<Fields>;

type ProjectionValue = (
  field: CatalogField,
  values: Record<string, unknown>,
) => unknown;
type StoredValueProjection = (field: CatalogField, value: unknown) => unknown;

const matchesTransfer = (value: unknown, transfer: TransferName) => {
  const kind = TRANSFER_KINDS[transfer];
  if (value === null) return kind === "string";
  return kind === "array"
    ? Array.isArray(value)
    : kind === "object"
      ? typeof value === "object" && !Array.isArray(value)
      : typeof value === kind;
};

/** Check an API value's type and any limit named by its catalog field. */
export const isValidCatalogApiValue = (
  field: CatalogField,
  value: unknown,
): boolean =>
  matchesTransfer(value, field[2] as TransferName) &&
  (field[2] !== "nonNegativeInt" ||
    (Number.isSafeInteger(value as number) && (value as number) >= 0));

const schemaValue: ProjectionValue = (field, values) => {
  const schema = values[field[2] as string];
  if (schema === undefined) {
    throw new Error(`Missing catalog schema: ${field[2]}`);
  }
  return schema;
};

const fromStoredValue =
  (project: StoredValueProjection): ProjectionValue =>
  (field, values) =>
    project(field, values[field[0]]);

const PROJECTION_VALUES = {
  api: fromStoredValue((field, value) =>
    matchesTransfer(value, field[2] as TransferName)
      ? (value ?? "")
      : undefined,
  ),
  columns: (field) => field[1],
  form: fromStoredValue((field, value) =>
    field[2] === "boolean" ? value === "1" : (value ?? field[4]),
  ),
  schema: schemaValue,
  storedApi: fromStoredValue((_field, value) => value ?? ""),
  transfer: fromStoredValue((field, value) =>
    field[2] === "dayPrices" && Object.keys(value as object).length === 0
      ? undefined
      : value,
  ),
} satisfies Record<ProjectionMode, ProjectionValue>;

const PROJECTION_USES = {
  api: 1,
  columns: 0,
  form: 2,
  schema: 0,
  storedApi: 1,
  transfer: 0,
} as const satisfies Record<ProjectionMode, 0 | 1 | 2>;

const fieldSupportsProjection = (
  mode: ProjectionMode,
  field: CatalogField,
): boolean => {
  const requiredUse = PROJECTION_USES[mode];
  if (requiredUse !== 0) return (Number(field[3]) & requiredUse) !== 0;
  return (mode === "columns" ? field[1] : field[2]) !== undefined;
};

const projectCatalogField = <Key extends PropertyKey>(
  mode: ProjectionMode,
  source: Record<string, unknown>,
  excluded: readonly Key[],
  [key, field]: [Key, CatalogField],
): readonly (readonly [Key | string, unknown])[] => {
  if (!fieldSupportsProjection(mode, field) || excluded.includes(key))
    return [];
  const value = PROJECTION_VALUES[mode](field, source);
  return value === undefined
    ? []
    : [[mode === "columns" ? field[0] : key, value] as const];
};

export const projectCatalogFields = <
  Fields extends CatalogFieldSet,
  Mode extends ProjectionMode,
  Source extends object,
>(
  fields: Fields,
  mode: Mode,
  source: Source,
  excluded: readonly (keyof Fields)[] = [],
): CatalogProjection<Fields, Mode, Source> => {
  const project = (
    field: [keyof Fields, CatalogField],
  ): readonly (readonly [keyof Fields | string, unknown])[] =>
    projectCatalogField(
      mode,
      source as Record<string, unknown>,
      excluded,
      field,
    );
  const pairs = (
    Object.entries(fields) as [keyof Fields, CatalogField][]
  ).flatMap(project);
  return Object.fromEntries(pairs) as CatalogProjection<Fields, Mode, Source>;
};
