import type { RecordChanges } from "#db/record-table.ts";
import type {
  BuiltSite,
  BuiltSitePlainFields,
  DbProvider,
  HostingProvider,
  UpdateTier,
} from "./types.ts";

const passthrough = <T>(value: T): T => value;
const nullable = <T>(value: T | null): T | null => value ?? null;

/** A plain column that stores the value of the site as it is. */
const plainColumn = <
  DbKey extends string,
  SiteKey extends keyof BuiltSite & string,
  Value extends string | number,
>(
  dbKey: DbKey,
  siteKey: SiteKey,
) => ({
  dbKey,
  fromRow: passthrough<Value>,
  siteKey,
  toInput: passthrough<Value>,
});

/** The app↔db mappings every 0/1 boolean column shares. */
const boolFlagMappings = {
  fromRow: (value: number): boolean => Boolean(value),
  toInput: (value: boolean): number => (value ? 1 : 0),
} as const;

export const builtSitePlainColumns = [
  {
    dbKey: "assignable",
    ...boolFlagMappings,
    siteKey: "assignable",
  },
  {
    dbKey: "assigned_attendee_id",
    fromRow: nullable<number>,
    siteKey: "assignedAttendeeId",
    toInput: nullable<number>,
  },
  {
    dbKey: "assigned_listing_id",
    fromRow: nullable<number>,
    siteKey: "assignedListingId",
    toInput: nullable<number>,
  },
  plainColumn<
    "database_key_rotation_started",
    "databaseKeyRotationStarted",
    number
  >("database_key_rotation_started", "databaseKeyRotationStarted"),
  plainColumn<"read_only_from", "readOnlyFrom", string>(
    "read_only_from",
    "readOnlyFrom",
  ),
  {
    dbKey: "renewal_token_index",
    fromRow: nullable<string>,
    siteKey: "renewalTokenIndex",
    toInput: nullable<string>,
  },
  plainColumn<"site_data_revision", "siteDataRevision", number>(
    "site_data_revision",
    "siteDataRevision",
  ),
  {
    dbKey: "updates",
    fromRow: passthrough<UpdateTier>,
    siteKey: "updates",
    toInput: passthrough<UpdateTier>,
  },
] as const;

export const builtSiteBlobColumns = [
  {
    blobKey: "n",
    defaultValue: "",
    required: true,
    siteKey: "name",
  },
  {
    blobKey: "u",
    defaultValue: "",
    required: true,
    siteKey: "siteUrl",
  },
  {
    blobKey: "d",
    defaultValue: "",
    required: false,
    siteKey: "dbUrl",
  },
  {
    blobKey: "t",
    defaultValue: "",
    required: false,
    siteKey: "dbToken",
  },
  {
    blobKey: "s",
    defaultValue: "",
    required: false,
    siteKey: "hostingId",
  },
  {
    blobKey: "hp",
    defaultValue: "bunny" as HostingProvider,
    required: false,
    siteKey: "hostingProvider",
  },
  {
    blobKey: "dp",
    defaultValue: "bunny" as DbProvider,
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

/** The plain columns of the site fields that `input` names. Each column maps
 *  its own field, so the values are the stored values of the columns. */
export const plainColumnValues = (
  input: Partial<BuiltSitePlainFields>,
): RecordChanges<"built_sites"> =>
  Object.fromEntries(
    builtSitePlainColumns.flatMap((column) => {
      if (!Object.hasOwn(input, column.siteKey)) return [];
      const value = input[column.siteKey] as never;
      return [[column.dbKey, column.toInput(value)]];
    }),
  ) as RecordChanges<"built_sites">;
