/**
 * Built sites — stores records of sites created via the admin builder.
 * Site data (name, bunny URL) is encrypted in a single blob for privacy.
 */

import type { InValue } from "@libsql/client";
import { registerCache } from "#lib/cache-registry.ts";
import { decrypt, encrypt } from "#lib/crypto/encryption.ts";
import { queryAll } from "#lib/db/client.ts";
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
}

/** Built site row as stored in the database */
export interface BuiltSiteRow {
  id: number;
  site_data: string;
  created: string;
}

/** Built site input for creating a new row */
export type BuiltSiteInput = {
  siteData: string;
};

/** Decrypted built site for display */
export interface BuiltSite {
  id: number;
  name: string;
  bunnyUrl: string;
  created: string;
}

/** Form input for CRUD operations */
export type BuiltSiteFormInput = {
  name: string;
  bunnyUrl: string;
};

const idCol = col.generated<number>();
const createdCol = col.withDefault(() => nowIso());

const rawBuiltSitesTable = defineTable<BuiltSiteRow, BuiltSiteInput>({
  name: "built_sites",
  primaryKey: "id",
  schema: {
    id: idCol,
    site_data: col.encrypted<string>(encrypt, decrypt),
    created: createdCol,
  },
});

/** Build the encrypted site data blob */
export const buildSiteDataBlob = (name: string, bunnyUrl: string): string =>
  JSON.stringify({ v: 1, n: name, u: bunnyUrl } satisfies SiteDataBlob);

/** Parse a decrypted site data blob */
export const parseSiteDataBlob = (json: string): SiteDataBlob =>
  JSON.parse(json) as SiteDataBlob;

/** Convert a raw DB row (after decryption) to a BuiltSite */
const rowToBuiltSite = (row: BuiltSiteRow): BuiltSite => {
  const blob = parseSiteDataBlob(row.site_data);
  return { id: row.id, name: blob.n, bunnyUrl: blob.u, created: row.created };
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
    created: createdCol,
  },
  inputKeyMap: { name: "name", bunny_url: "bunnyUrl" },

  insert: async (input: BuiltSiteFormInput): Promise<BuiltSite> => {
    const row = await builtSitesTable.insert({
      siteData: buildSiteDataBlob(input.name, input.bunnyUrl),
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
    // Row exists (checked above), so update always returns non-null
    const row = (await builtSitesTable.update(id, {
      siteData: buildSiteDataBlob(name, bunnyUrl),
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
      site_data: buildSiteDataBlob(input.name ?? "", input.bunnyUrl ?? ""),
    }),
};

/** Insert a new built site record */
export const insertBuiltSite = (
  name: string,
  bunnyUrl: string,
): Promise<BuiltSiteRow> =>
  builtSitesTable.insert({ siteData: buildSiteDataBlob(name, bunnyUrl) });

/** Get all built sites, decrypted and sorted by name */
export const getAllBuiltSites = (): Promise<BuiltSite[]> =>
  builtSitesCache.getAll();
