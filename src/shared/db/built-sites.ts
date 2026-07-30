/**
 * Built sites — stores records of sites created via the admin builder.
 * Site data (name, bunny URL) is encrypted in a single blob for privacy.
 */

import type { InValue } from "@libsql/client";
/* jscpd:ignore-start */
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { queryAll, queryOne, rowExistsForIdList } from "#shared/db/client.ts";
import { retryWrite } from "#shared/db/retry-write.ts";
import type { Table, TableSchema } from "#shared/db/table.ts";
import { cachedTable, col, defineTable } from "#shared/db/table.ts";
import {
  blobToSiteFields,
  buildSiteDataBlobFromInput,
  parseSiteDataBlob,
} from "./built-sites/blob.ts";
import {
  builtSiteCrudBlobSchema,
  builtSiteCrudPlainSchema,
  builtSiteFormMappings,
  builtSiteInputKeyMap,
  builtSitePlainColumns,
  builtSitePlainSchema,
  createdCol,
  emptyBuiltSiteFormInput,
  idCol,
  mapPlainFields,
  plainSiteInput,
} from "./built-sites/fields.ts";
import {
  type BuiltSite,
  type BuiltSiteBlobInput,
  type BuiltSiteFormInput,
  type BuiltSiteInput,
  type BuiltSitePlainFields,
  type BuiltSiteRow,
  type BuiltSiteUpdate,
  type DbProvider,
  DEFAULT_UPDATE_TIER,
  type HostingProvider,
  type UpdateTier,
} from "./built-sites/types.ts";

/* jscpd:ignore-end */

const rawBuiltSiteSchema = {
  ...builtSitePlainSchema,
  created: createdCol,
  id: idCol,
  site_data: col.encrypted(encrypt, decrypt),
} satisfies TableSchema<BuiltSiteRow>;

const builtSiteSelectColumns = Object.keys(rawBuiltSiteSchema).join(", ");

const rawBuiltSitesTable = defineTable<BuiltSiteRow, BuiltSiteInput>({
  name: "built_sites",
  primaryKey: "id",
  schema: rawBuiltSiteSchema,
});

/** Build raw table input from site-shaped fields */
const toRawInput = (
  input: Partial<BuiltSitePlainFields> & Partial<BuiltSiteBlobInput>,
): BuiltSiteInput => ({
  ...plainSiteInput(input),
  siteData: buildSiteDataBlobFromInput(input),
});

const toDbColumnValues = (
  input: Partial<BuiltSitePlainFields> & Partial<BuiltSiteBlobInput>,
): Record<string, InValue> => ({
  ...mapPlainFields(input, "dbKey"),
  site_data: buildSiteDataBlobFromInput(input),
});

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

export const builtSites = cachedTable({
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

const findBuiltSiteById = async (id: InValue): Promise<BuiltSite | null> => {
  const row = await rawBuiltSitesTable.findById(id);
  return row ? rowToBuiltSite(row) : null;
};

export const findBuiltSiteByIdPrimary = async (
  id: InValue,
): Promise<BuiltSite | null> => {
  const row = await rawBuiltSitesTable.findByIdPrimary!(id);
  return row ? rowToBuiltSite(row) : null;
};

/** Update a whole built-site record without overwriting a concurrent blob write. */
export const updateBuiltSite = (
  id: InValue,
  changesFor: (existing: BuiltSite) => BuiltSiteUpdate | null,
): Promise<BuiltSite | null> => {
  const updateStatement = rawBuiltSitesTable.updateStatement;
  return retryWrite(`Could not update built site ${String(id)}`, async () => {
    const existing = await findBuiltSiteByIdPrimary(id);
    if (!existing) return { value: null };
    const changes = changesFor(existing);
    if (!changes) return { value: existing };
    const nextRevision = existing.siteDataRevision + 1;
    const statement = await updateStatement(
      id,
      toRawInput({
        ...existing,
        ...changes,
        siteDataRevision: nextRevision,
      }),
      { args: [existing.siteDataRevision], sql: "site_data_revision = ?" },
    );
    const stored = await queryOne<BuiltSiteRow>(statement.sql, statement.args);
    if (stored) {
      return { value: rowToBuiltSite(await rawBuiltSitesTable.fromDb(stored)) };
    }
    return null;
  });
};

/**
 * CRUD-compatible table adapter that presents BuiltSite (with individual fields)
 * while storing data as an encrypted blob underneath.
 */
export const builtSitesCrudTable: Table<BuiltSite, BuiltSiteFormInput> = {
  columns: rawBuiltSitesTable.columns,
  deleteById: (id: InValue): Promise<void> => builtSites.table.deleteById(id),

  findAll: (): Promise<BuiltSite[]> => builtSites.getAll(),

  findById: findBuiltSiteById,

  findByIds: async (ids: InValue[]): Promise<(BuiltSite | null)[]> =>
    (await rawBuiltSitesTable.findByIds(ids)).map((row) =>
      row === null ? null : rowToBuiltSite(row),
    ),

  // findByIdPrimary is intentionally omitted: it is optional on Table (like
  // insertStatement/updateStatement) and only used on the transactional
  // afterWrite write-back path, which this façade resource never takes.

  fromDb: (row: BuiltSite): Promise<BuiltSite> => Promise.resolve(row),
  inputKeyMap: builtSiteInputKeyMap,

  insert: async (input: BuiltSiteFormInput): Promise<BuiltSite> => {
    const row = await builtSites.table.insert(toRawInput(input));
    return rowToBuiltSite(row);
  },
  name: "built_sites",
  primaryKey: "id",
  // The façade's rows are already decrypted (its fromDb is identity), so a
  // single column's stored value is already its readable value.
  readColumn: <K extends keyof BuiltSite & string>(
    _col: K,
    value: BuiltSite[K],
  ): Promise<BuiltSite[K]> => Promise.resolve(value),

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
  ): Promise<BuiltSite | null> => updateBuiltSite(id, () => input),
};

/** Normalize a site's bunny URL to its absolute origin — scheme + host only,
 * with any path, query, hash, or trailing slash dropped — so callers can safely
 * append a path. siteUrl may be stored as a bare hostname, so a default scheme
 * is added first (scheme detection is case-insensitive, so an `HTTPS://` URL
 * isn't mistaken for a hostname); `new URL(...).origin` then collapses anything
 * past the host and lower-cases the scheme. */
export const siteBaseUrl = (siteUrl: string): string => {
  const withScheme = /^https?:\/\//i.test(siteUrl)
    ? siteUrl
    : `https://${siteUrl}`;
  return new URL(withScheme).origin;
};

/** Insert a new built site record */
export const insertBuiltSite = async (
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
): Promise<BuiltSiteRow> =>
  await builtSites.table.insert(
    toRawInput({
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
    }),
  );

/** Get all assignable built sites */
export const getAssignableBuiltSites = async (): Promise<BuiltSite[]> => {
  const all = await builtSites.getAll();
  return all.filter((s) => s.assignable);
};

/**
 * True when a built site is assigned to this attendee on any of the listings.
 * Used to forbid marking an assigned built-site line no-quantity: the assignment
 * (and the live public /renew/ path that resolves the site token with no
 * listing_attendees check) would otherwise survive behind a hidden line. One
 * query over all the IDs; callers pass a non-empty list.
 */
export const hasAssignedBuiltSite = rowExistsForIdList(
  (listingIdPlaceholders) =>
    `SELECT 1 FROM built_sites
     WHERE assigned_attendee_id = ?
       AND assigned_listing_id IN (${listingIdPlaceholders}) LIMIT 1`,
);

/** Assign a built site to an attendee/listing — sets assignable=0 and stores IDs */
export const assignBuiltSite = (
  siteId: number,
  attendeeId: number,
  listingId: number,
): Promise<BuiltSite | null> =>
  updateBuiltSite(siteId, () => ({
    assignable: false,
    assignedAttendeeId: attendeeId,
    assignedListingId: listingId,
  }));

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
