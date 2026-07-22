import type * as v from "valibot";
import type { ColumnDef } from "#shared/db/table.ts";

type CatalogField = readonly [
  string,
  object | undefined,
  string?,
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

export type CatalogFieldValues<Fields extends CatalogFieldSet> = {
  -readonly [Key in keyof Fields]: FieldValue<Fields[Key]>;
};

export type OptionalCatalogFieldValues<Fields extends CatalogFieldSet> = {
  -readonly [Key in keyof Fields]?: FieldValue<Fields[Key]> | undefined;
};

export type CatalogApiBody<Fields extends CatalogFieldSet> = {
  [Key in keyof Fields as Fields[Key][3] extends 1 | 3
    ? Fields[Key][0]
    : never]?: FieldValue<Fields[Key]>;
};

type FormValues<Fields extends CatalogFieldSet> = Pick<
  CatalogFieldValues<Fields>,
  {
    [Key in keyof Fields]: Fields[Key][3] extends 2 | 3 ? Key : never;
  }[keyof Fields]
>;

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

const USE_BY_MODE = {
  api: 1,
  columns: 0,
  form: 2,
  schema: 0,
  storedApi: 1,
  transfer: 0,
} as const;

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
      : Partial<CatalogFieldValues<Fields>>;

const matchesTransfer = (value: unknown, transfer: string) =>
  transfer === "boolean"
    ? typeof value === "boolean"
    : transfer === "bookableDays"
      ? Array.isArray(value)
      : /Int|Price|^price$|^duration/.test(transfer)
        ? typeof value === "number"
        : typeof value === "string";

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
    case "schema":
      return values[field[2] as string];
    case "storedApi":
      return value ?? "";
    case "api":
      if (value === null) return "";
      return matchesTransfer(value, field[2] as string) ? value : undefined;
    case "transfer":
      return field[2] === "dayPrices" &&
        Object.keys(value as object).length === 0
        ? undefined
        : value;
  }
};

export const projectCatalogFields = <
  const Fields extends CatalogFieldSet,
  const Mode extends ProjectionMode,
  const Source extends object,
>(
  fields: Fields,
  mode: Mode,
  source: Source,
  excluded: readonly (keyof Fields)[] = [],
): CatalogProjection<Fields, Mode, Source> => {
  const values = source as Record<string, unknown>;
  const requiredUse = USE_BY_MODE[mode];
  const pairs = (Object.entries(fields) as [string, CatalogField][]).flatMap(
    ([key, field]) => {
      const [, column, transfer, use] = field;
      const selected =
        requiredUse === 0
          ? (mode === "columns" ? column : transfer) !== undefined
          : (Number(use) & requiredUse) !== 0;
      if (!selected || excluded.includes(key)) return [];
      const value = projectedValue(mode, field, values);
      return value === undefined
        ? []
        : [[mode === "columns" ? field[0] : key, value] as const];
    },
  );
  return Object.fromEntries(pairs) as CatalogProjection<Fields, Mode, Source>;
};
