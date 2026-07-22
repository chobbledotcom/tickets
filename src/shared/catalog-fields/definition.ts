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

const matchesTransfer = (value: unknown, transfer: TransferName) => {
  const kind = TRANSFER_KINDS[transfer];
  if (value === null) return kind === "string";
  return kind === "array"
    ? Array.isArray(value)
    : kind === "object"
      ? typeof value === "object" && !Array.isArray(value)
      : typeof value === kind;
};

const projectedValue = (
  mode: ProjectionMode,
  field: CatalogField,
  values: Record<string, unknown>,
): unknown => {
  const value = values[field[0]];
  switch (mode) {
    case "columns":
      return field[1];
    case "form":
      return field[2] === "boolean" ? value === "1" : (value ?? field[4]);
    case "schema": {
      const schema = values[field[2] as string];
      if (schema === undefined) {
        throw new Error(`Missing catalog schema: ${field[2]}`);
      }
      return schema;
    }
    case "storedApi":
      return value ?? "";
    case "api":
      return matchesTransfer(value, field[2] as TransferName)
        ? (value ?? "")
        : undefined;
    case "transfer":
      return field[2] === "dayPrices" &&
        Object.keys(value as object).length === 0
        ? undefined
        : value;
  }
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
  const requiredUse =
    mode === "form" ? 2 : mode === "api" || mode === "storedApi" ? 1 : 0;
  const pairs = (
    Object.entries(fields) as [keyof Fields, CatalogField][]
  ).flatMap(([key, field]) => {
    const [, column, transfer, use] = field;
    const selected =
      requiredUse === 0
        ? (mode === "columns" ? column : transfer) !== undefined
        : (Number(use) & requiredUse) !== 0;
    if (!selected || excluded.includes(key)) return [];
    const value = projectedValue(
      mode,
      field,
      source as Record<string, unknown>,
    );
    return value === undefined
      ? []
      : [[mode === "columns" ? field[0] : key, value] as const];
  });
  return Object.fromEntries(pairs) as CatalogProjection<Fields, Mode, Source>;
};
