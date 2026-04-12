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
  v: 1;
  /** Site name */
  n: string;
  /** Bunny URL (default hostname) */
  u: string;
  /** Database URL (optional, absent in older blobs) */
  d?: string;
  /** Database token (optional, absent in older blobs) */
  t?: string;
  /** Assigned attendee ID (set when site is assigned to a booking) */
  ai?: number;
  /** Assigned event ID (set when site is assigned to a booking) */
  ei?: number;
}

/** Built site row as stored in the database */
export interface BuiltSiteRow {
  id: number;
  site_data: string;
  assignable: number;
  created: string;
}

/** Built site input for creating a new row */
export type BuiltSiteInput = {
  siteData: string;
  assignable?: number;
};

/** Decrypted built site for display */
export interface BuiltSite {
  id: number;
  name: string;
  bunnyUrl: string;
  dbUrl: string;
  dbToken: string;
  assignable: boolean;
  assignedAttendeeId: number | null;
  assignedEventId: number | null;
  created: string;
}

/** Form input for CRUD operations */
export type BuiltSiteFormInput = {
  name: string;
  bunnyUrl: string;
  dbUrl: string;
  dbToken: string;
  assignable: boolean;
};

const idCol = col.generated<number>();
const createdCol = col.withDefault(() => nowIso());

const assignableCol = col.withDefault(() => 0);

const rawBuiltSitesTable = defineTable<BuiltSiteRow, BuiltSiteInput>({
  name: "built_sites",
  primaryKey: "id",
  schema: {
    id: idCol,
    site_data: col.encrypted<string>(encrypt, decrypt),
    assignable: assignableCol,
    created: createdCol,
  },
});

/** Build the encrypted site data blob */
export const buildSiteDataBlob = (
  name: string,
  bunnyUrl: string,
  dbUrl = "",
  dbToken = "",
  assignedAttendeeId?: number,
  assignedEventId?: number,
): string =>
  JSON.stringify({
    v: 1,
    n: name,
    u: bunnyUrl,
    ...(dbUrl ? { d: dbUrl } : {}),
    ...(dbToken ? { t: dbToken } : {}),
    ...(assignedAttendeeId ? { ai: assignedAttendeeId } : {}),
    ...(assignedEventId ? { ei: assignedEventId } : {}),
  } satisfies SiteDataBlob);

/** Parse a decrypted site data blob */
export const parseSiteDataBlob = (json: string): SiteDataBlob =>
  JSON.parse(json) as SiteDataBlob;

/** Convert a raw DB row (after decryption) to a BuiltSite */
const rowToBuiltSite = (row: BuiltSiteRow): BuiltSite => {
  const blob = parseSiteDataBlob(row.site_data);
  return {
    id: row.id,
    name: blob.n,
    bunnyUrl: blob.u,
    dbUrl: blob.d ?? "",
    dbToken: blob.t ?? "",
    assignable: Boolean(row.assignable),
    assignedAttendeeId: blob.ai ?? null,
    assignedEventId: blob.ei ?? null,
    created: row.created,
  };
};

const builtSitesCache = requestCache(() =>
  queryAndDecrypt("SELECT * FROM built_sites ORDER BY created DESC"),
);

registerCache(() => ({ name: "built_sites", entries: builtSitesCache.size() }));

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
  name: "built_sites",
  primaryKey: "id",
  schema: {
    id: idCol,
    name: {} as ColumnDef<string>,
    bunnyUrl: {} as ColumnDef<string>,
    dbUrl: {} as ColumnDef<string>,
    dbToken: {} as ColumnDef<string>,
    assignable: {} as ColumnDef<boolean>,
    assignedAttendeeId: {} as ColumnDef<number | null>,
    assignedEventId: {} as ColumnDef<number | null>,
    created: createdCol,
  },
  inputKeyMap: {
    name: "name",
    bunny_url: "bunnyUrl",
    db_url: "dbUrl",
    db_token: "dbToken",
    assignable: "assignable",
  },

  insert: async (input: BuiltSiteFormInput): Promise<BuiltSite> => {
    const row = await builtSitesTable.insert({
      siteData: buildSiteDataBlob(
        input.name,
        input.bunnyUrl,
        input.dbUrl,
        input.dbToken,
      ),
      assignable: input.assignable ? 1 : 0,
    });
    // insert() returns the row with unencrypted input values, so parse directly
    return rowToBuiltSite(row);
  },

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
    const assignable = input.assignable ?? existing.assignable;
    // Row exists (checked above), so update always returns non-null
    const row = (await builtSitesTable.update(id, {
      siteData: buildSiteDataBlob(
        name,
        bunnyUrl,
        dbUrl,
        dbToken,
        existing.assignedAttendeeId ?? undefined,
        existing.assignedEventId ?? undefined,
      ),
      assignable: assignable ? 1 : 0,
    })) as BuiltSiteRow;
    // update() returns the row with unencrypted input values, so parse directly
    return rowToBuiltSite(row);
  },

  findById: async (id: InValue): Promise<BuiltSite | null> => {
    // findById already decrypts via fromDb internally
    const row = await rawBuiltSitesTable.findById(id);
    if (!row) return null;
    return rowToBuiltSite(row);
  },

  deleteById: (id: InValue): Promise<void> => builtSitesTable.deleteById(id),

  findAll: (): Promise<BuiltSite[]> => builtSitesCache.getAll(),

  fromDb: (row: BuiltSite): Promise<BuiltSite> => Promise.resolve(row),

  toDbValues: (
    input: BuiltSiteFormInput | Partial<BuiltSiteFormInput>,
  ): Promise<Record<string, InValue>> =>
    Promise.resolve({
      site_data: buildSiteDataBlob(
        input.name ?? "",
        input.bunnyUrl ?? "",
        input.dbUrl ?? "",
        input.dbToken ?? "",
      ),
      assignable: input.assignable ? 1 : 0,
    }),
};

/** Insert a new built site record */
export const insertBuiltSite = (
  name: string,
  bunnyUrl: string,
  dbUrl = "",
  dbToken = "",
  assignable = false,
): Promise<BuiltSiteRow> =>
  builtSitesTable.insert({
    siteData: buildSiteDataBlob(name, bunnyUrl, dbUrl, dbToken),
    assignable: assignable ? 1 : 0,
  });

/** Get all built sites, decrypted and sorted by name */
export const getAllBuiltSites = (): Promise<BuiltSite[]> =>
  builtSitesCache.getAll();

/** Count assignable sites (fast SQL, no decryption) */
export const countAssignableSites = async (): Promise<number> => {
  const row = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM built_sites WHERE assignable = 1",
  );
  return row?.cnt ?? 0;
};

/** Get all assignable built sites */
export const getAssignableBuiltSites = async (): Promise<BuiltSite[]> => {
  const all = await getAllBuiltSites();
  return all.filter((s) => s.assignable);
};

/** Assign a built site to an attendee/event — sets assignable=0 and stores IDs in blob */
export const assignBuiltSite = async (
  siteId: number,
  attendeeId: number,
  eventId: number,
): Promise<BuiltSite | null> => {
  const existing = await builtSitesCrudTable.findById(siteId);
  if (!existing) return null;
  const row = (await builtSitesTable.update(siteId, {
    siteData: buildSiteDataBlob(
      existing.name,
      existing.bunnyUrl,
      existing.dbUrl,
      existing.dbToken,
      attendeeId,
      eventId,
    ),
    assignable: 0,
  })) as BuiltSiteRow;
  return rowToBuiltSite(row);
};
