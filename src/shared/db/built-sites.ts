/**
 * Built sites — stores records of sites created via the admin builder.
 * Site data (name, bunny URL) is encrypted in a single blob for privacy.
 */

import type { InValue } from "@libsql/client";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  inPlaceholders,
  queryAll,
  queryOne,
  rowExists,
} from "#shared/db/client.ts";
import type { ColumnDef, Table, TableSchema } from "#shared/db/table.ts";
import { cachedTable, col, defineTable } from "#shared/db/table.ts";
import { nowIso } from "#shared/now.ts";

/**
 * The release channels a built site can opt into, ordered most- to
 * least-eager. The array order IS the rank (its index): an alpha site takes
 * every deploy, a beta site takes beta + release, a release site only stable
 * releases. So a site on tier S accepts a deploy published at tier T exactly
 * when `indexOf(S) <= indexOf(T)` — see {@link siteAcceptsDeployTier}.
 */
export const UPDATE_TIERS = ["alpha", "beta", "release"] as const;

/** One of the {@link UPDATE_TIERS} release channels. */
export type UpdateTier = (typeof UPDATE_TIERS)[number];

/** Default channel for a new built site — the most conservative (stable only). */
export const DEFAULT_UPDATE_TIER: UpdateTier = "release";

/** Narrow an arbitrary string to an {@link UpdateTier}. */
export const isUpdateTier = (value: string): value is UpdateTier =>
  (UPDATE_TIERS as readonly string[]).includes(value);

/**
 * True when a site on `siteTier` should receive a deploy published at
 * `deployTier`. A release deploy reaches every site, a beta deploy reaches beta
 * + alpha sites, an alpha deploy only alpha sites — i.e. the site's channel must
 * be at the deploy's tier or more eager.
 */
export const siteAcceptsDeployTier = (
  siteTier: UpdateTier,
  deployTier: UpdateTier,
): boolean =>
  UPDATE_TIERS.indexOf(siteTier) <= UPDATE_TIERS.indexOf(deployTier);

/** Encrypted site-data blob version */
const SITE_DATA_BLOB_VERSION = 1;

/** Encrypted site data blob shape */
export interface SiteDataBlob {
  /** Database URL (optional, absent in older blobs) */
  d?: string;
  /** Site name */
  n: string;
  /** Renewal token (optional, present when renewal access exists) */
  rt?: string;
  /** Bunny edge script ID (optional, absent in older blobs) */
  s?: string;
  /** Database token (optional, absent in older blobs) */
  t?: string;
  /** Bunny URL (default hostname) */
  u: string;
  v: typeof SITE_DATA_BLOB_VERSION;
}

/** Built site row as stored in the database */
export interface BuiltSiteRow {
  assignable: number;
  assigned_attendee_id: number | null;
  assigned_listing_id: number | null;
  created: string;
  id: number;
  read_only_from: string;
  renewal_token_index: string | null;
  site_data: string;
  /** Release channel — a CHECK constraint keeps this a valid UpdateTier. */
  updates: UpdateTier;
}

type BuiltSitePlainInput = {
  assignable?: number;
  assignedAttendeeId?: number | null;
  assignedListingId?: number | null;
  renewalTokenIndex?: string | null;
  readOnlyFrom?: string;
  updates?: UpdateTier;
};

/** Built site input for creating a new row */
export type BuiltSiteInput = BuiltSitePlainInput & {
  siteData: string;
};

/** Decrypted built site for display */
export interface BuiltSite {
  assignable: boolean;
  assignedAttendeeId: number | null;
  assignedListingId: number | null;
  bunnyScriptId: string;
  bunnyUrl: string;
  created: string;
  dbToken: string;
  dbUrl: string;
  id: number;
  name: string;
  readOnlyFrom: string;
  /** Plain renewal token from the site-data blob when renewal access exists. Null when not provisioned. */
  renewalToken: string | null;
  renewalTokenIndex: string | null;
  /** Release channel this site opts into (see {@link UPDATE_TIERS}). */
  updates: UpdateTier;
}

/** Form input for CRUD operations. `updates` is optional — programmatic
 * inserts (e.g. auto-assignment) omit it and fall back to DEFAULT_UPDATE_TIER. */
export type BuiltSiteFormInput = Pick<
  BuiltSite,
  "name" | "bunnyUrl" | "dbUrl" | "dbToken" | "bunnyScriptId" | "assignable"
> & { updates?: UpdateTier };

const idCol = col.generated<number>();
const createdCol = col.withDefault(() => nowIso());

const assignableCol = {} as ColumnDef<number>;
const nullCol = col.withDefault<number | null>(() => null);
const nullStrCol = col.withDefault<string | null>(() => null);

type BuiltSitePlainFields = Pick<
  BuiltSite,
  | "assignable"
  | "assignedAttendeeId"
  | "assignedListingId"
  | "readOnlyFrom"
  | "renewalTokenIndex"
  | "updates"
>;

const passthrough = <T>(value: T): T => value;
const nullable = <T>(value: T | null): T | null => value ?? null;

const builtSitePlainColumns = [
  {
    dbKey: "assignable",
    formDefault: false,
    fromRow: (value: number): boolean => Boolean(value),
    inputKey: "assignable",
    schema: assignableCol,
    siteKey: "assignable",
    toInput: (value: boolean): number => (value ? 1 : 0),
  },
  {
    dbKey: "assigned_attendee_id",
    fromRow: nullable<number>,
    inputKey: "assignedAttendeeId",
    schema: nullCol,
    siteKey: "assignedAttendeeId",
    toInput: nullable<number>,
  },
  {
    dbKey: "assigned_listing_id",
    fromRow: nullable<number>,
    inputKey: "assignedListingId",
    schema: nullCol,
    siteKey: "assignedListingId",
    toInput: nullable<number>,
  },
  {
    dbKey: "read_only_from",
    fromRow: passthrough<string>,
    inputKey: "readOnlyFrom",
    schema: col.withDefault(() => ""),
    siteKey: "readOnlyFrom",
    toInput: passthrough<string>,
  },
  {
    dbKey: "renewal_token_index",
    fromRow: nullable<string>,
    inputKey: "renewalTokenIndex",
    schema: nullStrCol,
    siteKey: "renewalTokenIndex",
    toInput: nullable<string>,
  },
  {
    dbKey: "updates",
    formDefault: DEFAULT_UPDATE_TIER,
    fromRow: passthrough<UpdateTier>,
    inputKey: "updates",
    schema: col.withDefault<UpdateTier>(() => DEFAULT_UPDATE_TIER),
    siteKey: "updates",
    toInput: passthrough<UpdateTier>,
  },
] as const;

type BuiltSitePlainColumn = (typeof builtSitePlainColumns)[number];

const crudSchemaFor = <Column extends { siteKey: keyof BuiltSite }>(
  columns: readonly Column[],
): Pick<TableSchema<BuiltSite>, Column["siteKey"]> =>
  Object.fromEntries(columns.map(({ siteKey }) => [siteKey, {}])) as Pick<
    TableSchema<BuiltSite>,
    Column["siteKey"]
  >;

const builtSitePlainSchema = Object.fromEntries(
  builtSitePlainColumns.map(({ dbKey, schema }) => [dbKey, schema]),
) as Pick<TableSchema<BuiltSiteRow>, BuiltSitePlainColumn["dbKey"]>;

const builtSiteCrudPlainSchema = crudSchemaFor(builtSitePlainColumns);

const rawBuiltSiteSchema = {
  ...builtSitePlainSchema,
  created: createdCol,
  id: idCol,
  site_data: col.encrypted<string>(encrypt, decrypt),
} satisfies TableSchema<BuiltSiteRow>;

const builtSiteSelectColumns = Object.keys(rawBuiltSiteSchema).join(", ");

const rawBuiltSitesTable = defineTable<BuiltSiteRow, BuiltSiteInput>({
  name: "built_sites",
  primaryKey: "id",
  schema: rawBuiltSiteSchema,
});

type BuiltSiteBlobFields = Pick<
  BuiltSite,
  "bunnyScriptId" | "bunnyUrl" | "dbToken" | "dbUrl" | "name" | "renewalToken"
>;

type BuiltSiteBlobInput = Omit<BuiltSiteBlobFields, "renewalToken"> & {
  renewalToken?: string | null;
};

const builtSiteBlobColumns = [
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
    formDbKey: "bunny_url",
    required: true,
    siteKey: "bunnyUrl",
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
    formDbKey: "bunny_script_id",
    required: false,
    siteKey: "bunnyScriptId",
  },
  {
    blobKey: "rt",
    defaultValue: null,
    required: false,
    siteKey: "renewalToken",
  },
] as const;

type BuiltSiteBlobColumn = (typeof builtSiteBlobColumns)[number];

const builtSiteCrudBlobSchema =
  crudSchemaFor<BuiltSiteBlobColumn>(builtSiteBlobColumns);

type BuiltSiteFormMapping = {
  dbKey: string;
  defaultValue: boolean | string;
  siteKey: keyof BuiltSiteFormInput;
};

const builtSiteFormMappings: BuiltSiteFormMapping[] = [
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

const builtSiteInputKeyMap = Object.fromEntries(
  builtSiteFormMappings.map(({ dbKey, siteKey }) => [dbKey, siteKey]),
) as Record<string, string>;

const emptyBuiltSiteFormInput = (): BuiltSiteFormInput =>
  Object.fromEntries(
    builtSiteFormMappings.map(({ defaultValue, siteKey }) => [
      siteKey,
      defaultValue,
    ]),
  ) as BuiltSiteFormInput;

const buildSiteDataBlobFromInput = (
  input: Partial<BuiltSiteBlobInput>,
): string => {
  const blob = Object.fromEntries([
    ["v", SITE_DATA_BLOB_VERSION],
    ...builtSiteBlobColumns.flatMap((column) => {
      const value = (input[column.siteKey as keyof BuiltSiteBlobInput] ??
        column.defaultValue) as string | null;
      return column.required || value ? [[column.blobKey, value]] : [];
    }),
  ]) as unknown as SiteDataBlob;
  return JSON.stringify(blob);
};

const blobToSiteFields = (blob: SiteDataBlob): BuiltSiteBlobFields =>
  Object.fromEntries(
    builtSiteBlobColumns.map((column) => [
      column.siteKey,
      column.required
        ? blob[column.blobKey as keyof SiteDataBlob]
        : (blob[column.blobKey as keyof SiteDataBlob] ?? column.defaultValue),
    ]),
  ) as BuiltSiteBlobFields;

const mapPlainFields = <Key extends "dbKey" | "inputKey">(
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

/** Build raw table input from site-shaped fields */
const toRawInput = (
  input: Partial<BuiltSitePlainFields> & Partial<BuiltSiteBlobInput>,
): BuiltSiteInput => ({
  ...(mapPlainFields(input, "inputKey") as Partial<BuiltSitePlainInput>),
  siteData: buildSiteDataBlobFromInput(input),
});

const toDbColumnValues = (
  input: Partial<BuiltSitePlainFields> & Partial<BuiltSiteBlobInput>,
): Record<string, InValue> => ({
  ...mapPlainFields(input, "dbKey"),
  site_data: buildSiteDataBlobFromInput(input),
});

/** Parse a decrypted site data blob */
export const parseSiteDataBlob = (json: string): SiteDataBlob =>
  JSON.parse(json) as SiteDataBlob;

/** Convert a raw DB row (after decryption) to a BuiltSite */
const rowToBuiltSite = (row: BuiltSiteRow): BuiltSite => {
  const blob = parseSiteDataBlob(row.site_data);
  return {
    ...(Object.fromEntries(
      builtSitePlainColumns.map((column) => [
        column.siteKey,
        column.fromRow(row[column.dbKey] as never),
      ]),
    ) as BuiltSitePlainFields),
    ...blobToSiteFields(blob),
    created: row.created,
    id: row.id,
  };
};

const builtSitesCache = cachedTable({
  fetchAll: () =>
    queryAndDecrypt(
      `SELECT ${builtSiteSelectColumns} FROM built_sites ORDER BY created DESC`,
    ),
  name: "built_sites",
  table: rawBuiltSitesTable,
});

/** Query and decrypt built site rows */
const queryAndDecrypt = async (sql: string): Promise<BuiltSite[]> => {
  const rows = await queryAll<BuiltSiteRow>(sql);
  const decrypted = await Promise.all(
    rows.map((row) => rawBuiltSitesTable.fromDb(row)),
  );
  const sites = decrypted.map(rowToBuiltSite);
  sites.sort((a, b) => a.name.localeCompare(b.name));
  return sites;
};

/** Raw table with cache invalidation on writes */
export const builtSitesTable = builtSitesCache.table;

/**
 * CRUD-compatible table adapter that presents BuiltSite (with individual fields)
 * while storing data as an encrypted blob underneath.
 */
export const builtSitesCrudTable: Table<BuiltSite, BuiltSiteFormInput> = {
  deleteById: (id: InValue): Promise<void> => builtSitesTable.deleteById(id),

  findAll: (): Promise<BuiltSite[]> => builtSitesCache.getAll(),

  findById: async (id: InValue): Promise<BuiltSite | null> => {
    // findById already decrypts via fromDb internally
    const row = await rawBuiltSitesTable.findById(id);
    if (!row) return null;
    return rowToBuiltSite(row);
  },

  fromDb: (row: BuiltSite): Promise<BuiltSite> => Promise.resolve(row),
  inputKeyMap: builtSiteInputKeyMap,

  insert: async (input: BuiltSiteFormInput): Promise<BuiltSite> => {
    const row = await builtSitesTable.insert(toRawInput(input));
    return rowToBuiltSite(row);
  },
  name: "built_sites",
  primaryKey: "id",
  // The CRUD adapter is a façade over the raw table — the built-site blob
  // is always reconstructed from BuiltSiteFormInput, so rowToInput just picks
  // the exposed camelCase fields off an already-decrypted BuiltSite.
  rowToInput: (
    row: BuiltSite,
    _exclude?: readonly string[],
  ): Partial<BuiltSiteFormInput> =>
    Object.fromEntries(
      builtSiteFormMappings.map(({ siteKey }) => [siteKey, row[siteKey]]),
    ) as Partial<BuiltSiteFormInput>,
  schema: {
    ...builtSiteCrudPlainSchema,
    ...builtSiteCrudBlobSchema,
    created: createdCol,
    id: idCol,
  },

  toDbValues: (
    input: BuiltSiteFormInput | Partial<BuiltSiteFormInput>,
  ): Promise<Record<string, InValue>> =>
    Promise.resolve(
      toDbColumnValues({ ...emptyBuiltSiteFormInput(), ...input }),
    ),

  update: async (
    id: InValue,
    input: Partial<BuiltSiteFormInput>,
  ): Promise<BuiltSite | null> => {
    const existing = await builtSitesCrudTable.findById(id);
    if (!existing) return null;
    const row = (await builtSitesTable.update(
      id,
      toRawInput({ ...existing, ...input }),
    )) as BuiltSiteRow;
    return rowToBuiltSite(row);
  },
};

/** Normalize a site's bunny URL to its absolute origin — scheme + host only,
 * with any path, query, hash, or trailing slash dropped — so callers can safely
 * append a path. bunnyUrl may be stored as a bare hostname, so a default scheme
 * is added first (scheme detection is case-insensitive, so an `HTTPS://` URL
 * isn't mistaken for a hostname); `new URL(...).origin` then collapses anything
 * past the host and lower-cases the scheme. */
export const siteBaseUrl = (siteUrl: string): string => {
  const withScheme = /^https?:\/\//i.test(siteUrl)
    ? siteUrl
    : `https://${siteUrl}`;
  return new URL(withScheme).origin;
};

/**
 * Atomically claim the least-recently-poked built site and return its id and
 * bunny URL — the scheduler pokes it to trigger its prune. A single UPDATE picks
 * the row via its WHERE subquery and stamps `last_pruned` in the same statement,
 * so two overlapping cron pokes can't both grab the same site: SQLite serialises
 * the writes and the second claim sees the first's fresh stamp, stepping on to
 * the next site. `last_pruned` empty ('') sorts first, so never-poked sites go
 * before any dated one and the master walks every site in round-robin order.
 * The stamp lands before the caller pokes the site, so a slow or failing site
 * doesn't stall the rotation. Returns null when there are no built sites.
 */
export const claimNextBuiltSiteForPrune = async (): Promise<{
  id: number;
  bunnyUrl: string;
} | null> => {
  const row = await queryOne<{ id: number; site_data: string }>(
    `UPDATE built_sites AS builtSite SET last_pruned = ?
     WHERE builtSite.id = (
       SELECT candidate.id FROM built_sites AS candidate
       ORDER BY candidate.last_pruned ASC, candidate.id ASC
       LIMIT 1
     )
     RETURNING id, site_data`,
    [nowIso()],
  );
  if (!row) return null;
  const bunnyUrl = parseSiteDataBlob(await decrypt(row.site_data)).u;
  return { bunnyUrl, id: row.id };
};

/** Insert a new built site record */
export const insertBuiltSite = (
  name: string,
  bunnyUrl: string,
  dbUrl = "",
  dbToken = "",
  assignable = false,
  bunnyScriptId = "",
  updates: UpdateTier = DEFAULT_UPDATE_TIER,
): Promise<BuiltSiteRow> =>
  builtSitesTable.insert(
    toRawInput({
      assignable,
      bunnyScriptId,
      bunnyUrl,
      dbToken,
      dbUrl,
      name,
      updates,
    }),
  );

/** Get all built sites, decrypted and sorted by name */
export const getAllBuiltSites = (): Promise<BuiltSite[]> =>
  builtSitesCache.getAll();

/** Get all assignable built sites */
export const getAssignableBuiltSites = async (): Promise<BuiltSite[]> => {
  const all = await getAllBuiltSites();
  return all.filter((s) => s.assignable);
};

/**
 * True when a built site is assigned to this attendee on any of the listings.
 * Used to forbid marking an assigned built-site line no-quantity: the assignment
 * (and the live public /renew/ path that resolves the site token with no
 * listing_attendees check) would otherwise survive behind a hidden line. One
 * query over all the IDs; callers pass a non-empty list.
 */
export const hasAssignedBuiltSite = (
  attendeeId: number,
  listingIds: number[],
): Promise<boolean> =>
  rowExists(
    `SELECT 1 FROM built_sites
     WHERE assigned_attendee_id = ?
       AND assigned_listing_id IN (${inPlaceholders(listingIds)}) LIMIT 1`,
    [attendeeId, ...listingIds],
  );

const withBuiltSiteForUpdate = async <T>(
  siteId: number,
  update: (existing: BuiltSite) => Promise<T>,
): Promise<T | null> => {
  const existing = await builtSitesCrudTable.findById(siteId);
  return existing ? update(existing) : null;
};

/** Assign a built site to an attendee/listing — sets assignable=0 and stores IDs */
export const assignBuiltSite = (
  siteId: number,
  attendeeId: number,
  listingId: number,
): Promise<BuiltSite | null> => {
  return withBuiltSiteForUpdate(siteId, async () => {
    const row = (await builtSitesTable.update(siteId, {
      assignable: 0,
      assignedAttendeeId: attendeeId,
      assignedListingId: listingId,
    })) as BuiltSiteRow;
    return rowToBuiltSite(row);
  });
};

/** Look up a built site by renewal token index (HMAC blind index) */
export const getBuiltSiteByRenewalTokenIndex = async (
  tokenIndex: string,
): Promise<BuiltSite | null> => {
  const rows = await queryAll<BuiltSiteRow>(
    `SELECT ${builtSiteSelectColumns} FROM built_sites WHERE renewal_token_index = ?`,
    [tokenIndex],
  );
  if (rows.length === 0) return null;
  const decrypted = await rawBuiltSitesTable.fromDb(rows[0]!);
  return rowToBuiltSite(decrypted);
};

/** Update built site renewal state: token index, deadline, and renewal blob together */
export const updateBuiltSiteRenewalState = (
  siteId: number,
  updates: {
    renewalTokenIndex?: string | null;
    readOnlyFrom?: string;
    renewalToken?: string;
  },
): Promise<BuiltSite | null> => {
  return withBuiltSiteForUpdate(siteId, async (existing) => {
    const token = updates.renewalToken ?? existing.renewalToken ?? undefined;
    const row = (await builtSitesTable.update(siteId, {
      siteData: buildSiteDataBlobFromInput({
        ...existing,
        renewalToken: token,
      }),
      ...(updates.renewalTokenIndex !== undefined
        ? { renewalTokenIndex: updates.renewalTokenIndex }
        : {}),
      ...(updates.readOnlyFrom !== undefined
        ? { readOnlyFrom: updates.readOnlyFrom }
        : {}),
    })) as BuiltSiteRow;
    return rowToBuiltSite(row);
  });
};
