import type { InValue } from "@libsql/client";
import type { ColumnDef, TableSchema } from "#shared/db/table.ts";
import { col } from "#shared/db/table.ts";
import { nowIso } from "#shared/now.ts";
import {
  type BuiltSite,
  type BuiltSiteFormInput,
  type BuiltSitePlainFields,
  type BuiltSitePlainInput,
  type BuiltSiteRow,
  type DbProvider,
  DEFAULT_UPDATE_TIER,
  type HostingProvider,
  type UpdateTier,
} from "./types.ts";

export const idCol = col.generated<number>();
export const createdCol = col.withDefault(() => nowIso());

const assignableCol = {} as ColumnDef<number>;
const nullCol = col.withDefault<number | null>(() => null);
const nullStrCol = col.withDefault<string | null>(() => null);
const passthrough = <T>(value: T): T => value;
const nullable = <T>(value: T | null): T | null => value ?? null;

export const builtSitePlainColumns = [
  {
    dbKey: "assignable",
    formDefault: false,
    fromRow: (value: number): boolean => Boolean(value),
    schema: assignableCol,
    siteKey: "assignable",
    toInput: (value: boolean): number => (value ? 1 : 0),
  },
  {
    dbKey: "assigned_attendee_id",
    fromRow: nullable<number>,
    schema: nullCol,
    siteKey: "assignedAttendeeId",
    toInput: nullable<number>,
  },
  {
    dbKey: "assignment_effect",
    fromRow: nullable<string>,
    schema: nullStrCol,
    siteKey: "assignmentEffect",
    toInput: nullable<string>,
  },
  {
    dbKey: "assigned_listing_id",
    fromRow: nullable<number>,
    schema: nullCol,
    siteKey: "assignedListingId",
    toInput: nullable<number>,
  },
  {
    dbKey: "read_only_from",
    fromRow: passthrough<string>,
    schema: col.withDefault(() => ""),
    siteKey: "readOnlyFrom",
    toInput: passthrough<string>,
  },
  {
    dbKey: "renewal_token_index",
    fromRow: nullable<string>,
    schema: nullStrCol,
    siteKey: "renewalTokenIndex",
    toInput: nullable<string>,
  },
  {
    dbKey: "site_data_revision",
    fromRow: passthrough<number>,
    schema: col.withDefault(() => 0),
    siteKey: "siteDataRevision",
    toInput: passthrough<number>,
  },
  {
    dbKey: "updates",
    formDefault: DEFAULT_UPDATE_TIER,
    fromRow: passthrough<UpdateTier>,
    schema: col.withDefault<UpdateTier>(() => DEFAULT_UPDATE_TIER),
    siteKey: "updates",
    toInput: passthrough<UpdateTier>,
  },
] as const;

export type BuiltSitePlainColumn = (typeof builtSitePlainColumns)[number];

const crudSchemaFor = <Column extends { siteKey: keyof BuiltSite }>(
  columns: readonly Column[],
): Pick<TableSchema<BuiltSite>, Column["siteKey"]> =>
  Object.fromEntries(columns.map(({ siteKey }) => [siteKey, {}])) as Pick<
    TableSchema<BuiltSite>,
    Column["siteKey"]
  >;

export const builtSitePlainSchema = Object.fromEntries(
  builtSitePlainColumns.map(({ dbKey, schema }) => [dbKey, schema]),
) as Pick<TableSchema<BuiltSiteRow>, BuiltSitePlainColumn["dbKey"]>;

export const builtSiteCrudPlainSchema = crudSchemaFor(builtSitePlainColumns);

export const builtSiteBlobColumns = [
  {
    blobKey: "n",
    defaultValue: "",
    formDbKey: "name",
    required: true,
    siteKey: "name",
  },
  {
    blobKey: "u",
    defaultValue: "",
    formDbKey: "site_url",
    required: true,
    siteKey: "siteUrl",
  },
  {
    blobKey: "d",
    defaultValue: "",
    formDbKey: "db_url",
    required: false,
    siteKey: "dbUrl",
  },
  {
    blobKey: "t",
    defaultValue: "",
    formDbKey: "db_token",
    required: false,
    siteKey: "dbToken",
  },
  {
    blobKey: "s",
    defaultValue: "",
    formDbKey: "hosting_id",
    required: false,
    siteKey: "hostingId",
  },
  {
    blobKey: "hp",
    defaultValue: "bunny" as HostingProvider,
    formDbKey: "hosting_provider",
    required: false,
    siteKey: "hostingProvider",
  },
  {
    blobKey: "dp",
    defaultValue: "bunny" as DbProvider,
    formDbKey: "db_provider",
    required: false,
    siteKey: "dbProvider",
  },
  {
    blobKey: "rt",
    defaultValue: null,
    required: false,
    siteKey: "renewalToken",
  },
  {
    blobKey: "sk",
    defaultValue: null,
    required: false,
    siteKey: "scheduledTaskKey",
  },
] as const;

type BuiltSiteBlobColumn = (typeof builtSiteBlobColumns)[number];
export const builtSiteCrudBlobSchema =
  crudSchemaFor<BuiltSiteBlobColumn>(builtSiteBlobColumns);

type BuiltSiteFormMapping = {
  dbKey: string;
  defaultValue: boolean | string;
  siteKey: keyof BuiltSiteFormInput;
};

export const builtSiteFormMappings: BuiltSiteFormMapping[] = [
  ...builtSitePlainColumns.flatMap((column) =>
    "formDefault" in column
      ? [
          {
            dbKey: column.dbKey,
            defaultValue: column.formDefault,
            siteKey: column.siteKey,
          },
        ]
      : [],
  ),
  ...builtSiteBlobColumns.flatMap((column) =>
    "formDbKey" in column
      ? [
          {
            dbKey: column.formDbKey,
            defaultValue: column.defaultValue,
            siteKey: column.siteKey,
          },
        ]
      : [],
  ),
];

export const builtSiteInputKeyMap = Object.fromEntries(
  builtSiteFormMappings.map(({ dbKey, siteKey }) => [dbKey, siteKey]),
) as Record<string, string>;

export const emptyBuiltSiteFormInput = (): BuiltSiteFormInput =>
  Object.fromEntries(
    builtSiteFormMappings.map(({ defaultValue, siteKey }) => [
      siteKey,
      defaultValue,
    ]),
  ) as BuiltSiteFormInput;

export const mapPlainFields = <Key extends "dbKey" | "siteKey">(
  input: Partial<BuiltSitePlainFields>,
  key: Key,
): Partial<Record<BuiltSitePlainColumn[Key], InValue>> =>
  Object.fromEntries(
    builtSitePlainColumns.flatMap((column) => {
      if (!Object.hasOwn(input, column.siteKey)) return [];
      const value = input[column.siteKey] as never;
      return [[column[key], column.toInput(value)]];
    }),
  ) as Partial<Record<BuiltSitePlainColumn[Key], InValue>>;

export const plainSiteInput = (
  input: Partial<BuiltSitePlainFields>,
): Partial<BuiltSitePlainInput> =>
  mapPlainFields(input, "siteKey") as Partial<BuiltSitePlainInput>;
