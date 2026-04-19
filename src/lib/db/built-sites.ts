/**
 * Built sites — stores records of sites created via the admin builder.
 * Site data (name, bunny URL) is encrypted in a single blob for privacy.
 */

import type { InValue } from "@libsql/client";
import { registerCache } from "#lib/cache-registry.ts";
import { decrypt, encrypt } from "#lib/crypto/encryption.ts";
import { queryAll, queryOne } from "#lib/db/client.ts";
import type { ColumnDef, Table } from "#lib/db/table.ts";
import { col, defineTable, withCacheInvalidation } from "#lib/db/table.ts";
import { nowIso } from "#lib/now.ts";
import { requestCache } from "#lib/request-cache.ts";

/** Encrypted site data blob shape */
export interface SiteDataBlob {
  /** Database URL (optional, absent in older blobs) */
  d?: string;
  /** Site name */
  n: string;
  /** Bunny edge script ID (optional, absent in older blobs) */
  s?: string;
  /** Database token (optional, absent in older blobs) */
  t?: string;
  /** Bunny URL (default hostname) */
  u: string;
  v: 1;
}

/** Built site row as stored in the database */
export interface BuiltSiteRow {
  assignable: number;
  assigned_attendee_id: number | null;
  assigned_event_id: number | null;
  created: string;
  id: number;
  site_data: string;
}

/** Built site input for creating a new row */
export type BuiltSiteInput = {
  siteData: string;
  assignable?: number;
  assignedAttendeeId?: number | null;
  assignedEventId?: number | null;
};

/** Decrypted built site for display */
export interface BuiltSite {
  assignable: boolean;
  assignedAttendeeId: number | null;
  assignedEventId: number | null;
  bunnyScriptId: string;
  bunnyUrl: string;
  created: string;
  dbToken: string;
  dbUrl: string;
  id: number;
  name: string;
}

/** Form input for CRUD operations */
export type BuiltSiteFormInput = Pick<
  BuiltSite,
  "name" | "bunnyUrl" | "dbUrl" | "dbToken" | "bunnyScriptId" | "assignable"
>;

const idCol = col.generated<number>();
const createdCol = col.withDefault(() => nowIso());

const assignableCol = col.withDefault(() => 0);
const nullCol = col.withDefault<number | null>(() => null);

const rawBuiltSitesTable = defineTable<BuiltSiteRow, BuiltSiteInput>({
  name: "built_sites",
  primaryKey: "id",
  schema: {
    assignable: assignableCol,
    assigned_attendee_id: nullCol,
    assigned_event_id: nullCol,
    created: createdCol,
    id: idCol,
    site_data: col.encrypted<string>(encrypt, decrypt),
  },
});

/** Build the encrypted site data blob */
export const buildSiteDataBlob = (
  name: string,
  bunnyUrl: string,
  dbUrl = "",
  dbToken = "",
  bunnyScriptId = "",
): string =>
  JSON.stringify({
    n: name,
    u: bunnyUrl,
    v: 1,
    ...(dbUrl ? { d: dbUrl } : {}),
    ...(dbToken ? { t: dbToken } : {}),
    ...(bunnyScriptId ? { s: bunnyScriptId } : {}),
  } satisfies SiteDataBlob);

/** Build raw table input from individual fields */
const toRawInput = (
  name: string,
  bunnyUrl: string,
  dbUrl: string,
  dbToken: string,
  bunnyScriptId: string,
  assignable: boolean,
): BuiltSiteInput => ({
  assignable: assignable ? 1 : 0,
  siteData: buildSiteDataBlob(name, bunnyUrl, dbUrl, dbToken, bunnyScriptId),
});

/** Parse a decrypted site data blob */
export const parseSiteDataBlob = (json: string): SiteDataBlob =>
  JSON.parse(json) as SiteDataBlob;

/** Convert a raw DB row (after decryption) to a BuiltSite */
const rowToBuiltSite = (row: BuiltSiteRow): BuiltSite => {
  const blob = parseSiteDataBlob(row.site_data);
  return {
    assignable: Boolean(row.assignable),
    assignedAttendeeId: row.assigned_attendee_id ?? null,
    assignedEventId: row.assigned_event_id ?? null,
    bunnyScriptId: blob.s ?? "",
    bunnyUrl: blob.u,
    created: row.created,
    dbToken: blob.t ?? "",
    dbUrl: blob.d ?? "",
    id: row.id,
    name: blob.n,
  };
};

const builtSitesCache = requestCache(() =>
  queryAndDecrypt("SELECT * FROM built_sites ORDER BY created DESC"),
);

registerCache(() => ({ entries: builtSitesCache.size(), name: "built_sites" }));

/** Invalidate the built sites cache */
export const invalidateBuiltSitesCache = (): void => {
  builtSitesCache.invalidate();
};

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
export const builtSitesTable = withCacheInvalidation(
  rawBuiltSitesTable,
  invalidateBuiltSitesCache,
);

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
  inputKeyMap: {
    assignable: "assignable",
    bunny_script_id: "bunnyScriptId",
    bunny_url: "bunnyUrl",
    db_token: "dbToken",
    db_url: "dbUrl",
    name: "name",
  },

  insert: async (input: BuiltSiteFormInput): Promise<BuiltSite> => {
    const row = await builtSitesTable.insert(
      toRawInput(
        input.name,
        input.bunnyUrl,
        input.dbUrl,
        input.dbToken,
        input.bunnyScriptId,
        input.assignable,
      ),
    );
    // insert() returns the row with unencrypted input values, so parse directly
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
  ): Partial<BuiltSiteFormInput> => ({
    assignable: row.assignable,
    bunnyScriptId: row.bunnyScriptId,
    bunnyUrl: row.bunnyUrl,
    dbToken: row.dbToken,
    dbUrl: row.dbUrl,
    name: row.name,
  }),
  schema: {
    assignable: {} as ColumnDef<boolean>,
    assignedAttendeeId: {} as ColumnDef<number | null>,
    assignedEventId: {} as ColumnDef<number | null>,
    bunnyScriptId: {} as ColumnDef<string>,
    bunnyUrl: {} as ColumnDef<string>,
    created: createdCol,
    dbToken: {} as ColumnDef<string>,
    dbUrl: {} as ColumnDef<string>,
    id: idCol,
    name: {} as ColumnDef<string>,
  },

  toDbValues: (
    input: BuiltSiteFormInput | Partial<BuiltSiteFormInput>,
  ): Promise<Record<string, InValue>> =>
    Promise.resolve({
      assignable: input.assignable ? 1 : 0,
      site_data: buildSiteDataBlob(
        input.name ?? "",
        input.bunnyUrl ?? "",
        input.dbUrl ?? "",
        input.dbToken ?? "",
        input.bunnyScriptId ?? "",
      ),
    }),

  update: async (
    id: InValue,
    input: Partial<BuiltSiteFormInput>,
  ): Promise<BuiltSite | null> => {
    const existing = await builtSitesCrudTable.findById(id);
    if (!existing) return null;
    const name = input.name ?? existing.name;
    const bunnyUrl = input.bunnyUrl ?? existing.bunnyUrl;
    const dbUrl = input.dbUrl ?? existing.dbUrl;
    const dbToken = input.dbToken ?? existing.dbToken;
    const bunnyScriptId = input.bunnyScriptId ?? existing.bunnyScriptId;
    const assignable = input.assignable ?? existing.assignable;
    // Row exists (checked above), so update always returns non-null
    const row = (await builtSitesTable.update(
      id,
      toRawInput(name, bunnyUrl, dbUrl, dbToken, bunnyScriptId, assignable),
    )) as BuiltSiteRow;
    // update() returns the row with unencrypted input values, so parse directly
    return rowToBuiltSite(row);
  },
};

/** Insert a new built site record */
export const insertBuiltSite = (
  name: string,
  bunnyUrl: string,
  dbUrl = "",
  dbToken = "",
  assignable = false,
  bunnyScriptId = "",
): Promise<BuiltSiteRow> =>
  builtSitesTable.insert(
    toRawInput(name, bunnyUrl, dbUrl, dbToken, bunnyScriptId, assignable),
  );

/** Get all built sites, decrypted and sorted by name */
export const getAllBuiltSites = (): Promise<BuiltSite[]> =>
  builtSitesCache.getAll();

/** Count assignable sites (fast SQL, no decryption) */
export const countAssignableSites = async (): Promise<number> => {
  // COUNT(*) always returns exactly one row
  const row = (await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM built_sites WHERE assignable = 1",
    [],
  ))!;
  return row.cnt;
};

/** Get all assignable built sites */
export const getAssignableBuiltSites = async (): Promise<BuiltSite[]> => {
  const all = await getAllBuiltSites();
  return all.filter((s) => s.assignable);
};

/** Assign a built site to an attendee/event — sets assignable=0 and stores IDs */
export const assignBuiltSite = async (
  siteId: number,
  attendeeId: number,
  eventId: number,
): Promise<BuiltSite | null> => {
  const existing = await builtSitesCrudTable.findById(siteId);
  if (!existing) return null;
  const row = (await builtSitesTable.update(siteId, {
    assignable: 0,
    assignedAttendeeId: attendeeId,
    assignedEventId: eventId,
  })) as BuiltSiteRow;
  return rowToBuiltSite(row);
};
