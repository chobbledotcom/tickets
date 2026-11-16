/**
 * Built sites — stores records of sites created via the admin builder.
 * Site data (name, bunny URL) is encrypted in a single blob for privacy.
 */

import { execute, resultRows } from "#db/client.ts";
import { readOneRow, readRows } from "#db/read.ts";
import {
  deleteRow,
  findRow,
  findRowPrimary,
  insertRow,
  updateRowStatement,
} from "#db/record-table.ts";
import { retryWrite } from "#db/retry-write.ts";
import { desc, equal } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { tableCache } from "#db/table-cache.ts";
import { compareByName } from "#shared/name-order.ts";
import { nowIso } from "#shared/now.ts";
import { requestCache } from "#shared/request-cache.ts";
import {
  blobToSiteFields,
  buildSiteDataBlobFromInput,
  parseSiteDataBlob,
} from "./built-sites/blob.ts";
import {
  builtSitePlainColumns,
  plainColumnValues,
} from "./built-sites/fields.ts";
import {
  type BuiltSite,
  type BuiltSiteBlobInput,
  type BuiltSitePlainFields,
  type BuiltSiteUpdate,
  type DbProvider,
  DEFAULT_UPDATE_TIER,
  type HostingProvider,
  type UpdateTier,
} from "./built-sites/types.ts";

/** A stored built-site row, with its blob decrypted. */
export type BuiltSiteRow = DecodedRowOf<"built_sites">;

/** The columns of the site fields that `input` names, with the blob built from
 *  them. */
const siteColumns = (
  input: Partial<BuiltSitePlainFields> & Partial<BuiltSiteBlobInput>,
) => ({
  ...plainColumnValues(input),
  site_data: buildSiteDataBlobFromInput(input),
});

/** Convert a stored row to a BuiltSite. */
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

/** Every built site, in name order, cached for the request. */
export const builtSites = tableCache(
  tables.built_sites,
  requestCache(async () => {
    const rows = await readRows(
      from(tables.built_sites)
        .orderBy((site) => [desc(site.created)])
        .everyColumn(),
    );
    return rows.map(rowToBuiltSite).sort(compareByName);
  }),
);

/** The built site with this id, or null. */
export const findBuiltSiteById = async (
  id: number,
): Promise<BuiltSite | null> => {
  const row = await findRow(tables.built_sites, id);
  return row ? rowToBuiltSite(row) : null;
};

/** The built site with this id, read from the primary, or null. */
export const findBuiltSiteByIdPrimary = async (
  id: number,
): Promise<BuiltSite | null> => {
  const row = await findRowPrimary(tables.built_sites, id);
  return row ? rowToBuiltSite(row) : null;
};

/** The built site with this id, read from the primary. Throws when the row
 * is gone, because every caller holds an id it just read or wrote. */
export const requireBuiltSiteByIdPrimary = async (
  id: number,
): Promise<BuiltSite> => {
  const site = await findBuiltSiteByIdPrimary(id);
  if (!site) throw new Error(`Built site ${id} not found`);
  return site;
};

/** Store one revision-fenced change to a built site. Returns the stored row,
 * or null when the revision moved underneath us and the write must retry. */
const storeBuiltSiteChanges = async (
  id: number,
  existing: BuiltSite,
  changes: BuiltSiteUpdate,
): Promise<BuiltSiteRow | null> => {
  const [row] = resultRows(
    await execute(
      await updateRowStatement(
        tables.built_sites,
        id,
        siteColumns({
          ...existing,
          ...changes,
          siteDataRevision: existing.siteDataRevision + 1,
        }),
        (site) => equal(site.site_data_revision, existing.siteDataRevision),
      ),
    ),
  );
  return row ?? null;
};

/** Apply `changes` only while the row still sits at `expectedRevision`; a
 * concurrent write that moved it returns false, with no retry. */
export const updateBuiltSiteIfUnchanged = async (
  id: number,
  expectedRevision: number,
  changes: BuiltSiteUpdate,
): Promise<boolean> => {
  const existing = await findBuiltSiteByIdPrimary(id);
  if (!existing || existing.siteDataRevision !== expectedRevision) return false;
  return (await storeBuiltSiteChanges(id, existing, changes)) !== null;
};

/** Update a whole built-site record without overwriting a concurrent blob write. */
export const updateBuiltSite = (
  id: number,
  changesFor: (existing: BuiltSite) => BuiltSiteUpdate | null,
): Promise<BuiltSite | null> =>
  retryWrite(`Could not update built site ${String(id)}`, async () => {
    const existing = await findBuiltSiteByIdPrimary(id);
    if (!existing) return { value: null };
    const changes = changesFor(existing);
    if (!changes) return { value: existing };
    const stored = await storeBuiltSiteChanges(id, existing, changes);
    // A null row means the revision moved: signal retryWrite, not "stored
    // nothing", or a losing edit would drop silently.
    if (!stored) return null;
    return { value: rowToBuiltSite(stored) };
  });

/** Store a new built site from the fields that `input` names. A field that it
 *  leaves out takes its empty value. */
export const createBuiltSite = async (
  input: Partial<BuiltSitePlainFields> & Partial<BuiltSiteBlobInput>,
): Promise<BuiltSite> =>
  rowToBuiltSite(
    await insertRow(tables.built_sites, {
      ...siteColumns(input),
      created: nowIso(),
    }),
  );

/** Remove one built site. */
export const deleteBuiltSite = (id: number): Promise<void> =>
  deleteRow(tables.built_sites, id);

/** Insert a new built site record */
export const insertBuiltSite = (
  name: string,
  siteUrl: string,
  dbUrl = "",
  dbToken = "",
  assignable = false,
  hostingId = "",
  updates: UpdateTier = DEFAULT_UPDATE_TIER,
  hostingProvider: HostingProvider = "bunny",
  dbProvider: DbProvider = "bunny",
  scheduledTaskKey: string | null = null,
): Promise<BuiltSite> =>
  createBuiltSite({
    assignable,
    dbProvider,
    dbToken,
    dbUrl,
    hostingId,
    hostingProvider,
    name,
    scheduledTaskKey,
    siteUrl,
    updates,
  });

/** Get all assignable built sites */
export const getAssignableBuiltSites = async (): Promise<BuiltSite[]> => {
  const all = await builtSites.getAll();
  return all.filter((s) => s.assignable);
};

/** Look up a built site by renewal token index (HMAC blind index) */
export const getBuiltSiteByRenewalTokenIndex = async (
  tokenIndex: string,
): Promise<BuiltSite | null> => {
  const row = await readOneRow(
    from(tables.built_sites)
      .where({ renewal_token_index: tokenIndex })
      .limit(1)
      .everyColumn(),
  );
  return row ? rowToBuiltSite(row) : null;
};

/** Update built site renewal state: token index, deadline, and renewal blob together */
export const updateBuiltSiteRenewalState = (
  siteId: number,
  updates: {
    renewalTokenIndex?: string | null;
    readOnlyFrom?: string;
    renewalToken?: string;
  },
): Promise<BuiltSite | null> =>
  updateBuiltSite(siteId, (existing) => ({
    renewalToken: updates.renewalToken ?? existing.renewalToken,
    ...(updates.renewalTokenIndex !== undefined
      ? { renewalTokenIndex: updates.renewalTokenIndex }
      : {}),
    ...(updates.readOnlyFrom !== undefined
      ? { readOnlyFrom: updates.readOnlyFrom }
      : {}),
  }));
