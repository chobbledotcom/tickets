/**
 * Built sites — stores records of sites created via the admin builder.
 * Site data (name, bunny URL) is encrypted in a single blob for privacy.
 */

import { decrypt, encrypt } from "#lib/crypto/encryption.ts";
import { queryAll } from "#lib/db/client.ts";
import { col, defineTable } from "#lib/db/table.ts";
import { nowIso } from "#lib/now.ts";

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

export const builtSitesTable = defineTable<BuiltSiteRow, BuiltSiteInput>({
  name: "built_sites",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    site_data: col.encrypted<string>(encrypt, decrypt),
    created: col.withDefault(() => nowIso()),
  },
});

/** Build the encrypted site data blob */
export const buildSiteDataBlob = (name: string, bunnyUrl: string): string =>
  JSON.stringify({ v: 1, n: name, u: bunnyUrl } satisfies SiteDataBlob);

/** Parse a decrypted site data blob */
export const parseSiteDataBlob = (json: string): SiteDataBlob =>
  JSON.parse(json) as SiteDataBlob;

/** Insert a new built site record */
export const insertBuiltSite = (
  name: string,
  bunnyUrl: string,
): Promise<BuiltSiteRow> =>
  builtSitesTable.insert({ siteData: buildSiteDataBlob(name, bunnyUrl) });

/** Get all built sites, decrypted and sorted by name */
export const getAllBuiltSites = async (): Promise<BuiltSite[]> => {
  const rows = await queryAll<BuiltSiteRow>(
    "SELECT * FROM built_sites ORDER BY created DESC",
  );
  const decrypted = await Promise.all(
    rows.map((row) => builtSitesTable.fromDb(row)),
  );
  const sites = decrypted.map((row) => {
    const blob = parseSiteDataBlob(row.site_data);
    return {
      id: row.id,
      name: blob.n,
      bunnyUrl: blob.u,
      created: row.created,
    };
  });
  sites.sort((a, b) => a.name.localeCompare(b.name));
  return sites;
};
