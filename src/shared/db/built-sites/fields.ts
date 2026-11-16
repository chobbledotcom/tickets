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

/** A plain column that stores the value of the site through `convert`, the
 *  same way in both directions. */
const plainColumn = <
  DbKey extends string,
  SiteKey extends keyof BuiltSite & string,
  Value,
>(
  dbKey: DbKey,
  siteKey: SiteKey,
  convert: (value: Value) => Value,
) => ({ dbKey, fromRow: convert, siteKey, toInput: convert });

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
  plainColumn("assigned_attendee_id", "assignedAttendeeId", nullable<number>),
  plainColumn("assigned_listing_id", "assignedListingId", nullable<number>),
  plainColumn(
    "database_key_rotation_started",
    "databaseKeyRotationStarted",
    passthrough<number>,
  ),
  plainColumn("read_only_from", "readOnlyFrom", passthrough<string>),
  plainColumn("renewal_token_index", "renewalTokenIndex", nullable<string>),
  plainColumn("site_data_revision", "siteDataRevision", passthrough<number>),
  plainColumn("updates", "updates", passthrough<UpdateTier>),
] as const;

/** One field of the site data blob. It names its short key in the blob and the
 *  site field that it fills. It says whether every blob holds it, and the
 *  value that it takes when the blob leaves it out. */
const blobColumn = <Value extends string | null>(
  blobKey: string,
  siteKey: keyof BuiltSite & string,
  required: boolean,
  defaultValue: Value,
) => ({ blobKey, defaultValue, required, siteKey });

export const builtSiteBlobColumns = [
  blobColumn("n", "name", true, ""),
  blobColumn("u", "siteUrl", true, ""),
  blobColumn("d", "dbUrl", false, ""),
  blobColumn("t", "dbToken", false, ""),
  blobColumn("s", "hostingId", false, ""),
  blobColumn<HostingProvider>("hp", "hostingProvider", false, "bunny"),
  blobColumn<DbProvider>("dp", "dbProvider", false, "bunny"),
  blobColumn("rt", "renewalToken", false, null),
  blobColumn("sk", "scheduledTaskKey", false, null),
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
