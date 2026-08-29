import type { BlindIndex, EnvKeyEncrypted } from "#crypto/sealed.ts";
import { executeUpdate, resetAggregates } from "#db/client.ts";
import {
  createKeyedCache,
  type KeyedCache,
  type KeyedCacheConfig,
} from "#db/keyed-cache.ts";
import { type ColumnDef, col, type Table } from "#db/table.ts";
import {
  type DependsOnEntry,
  registerCache,
  registerDependencies,
  registerTableInvalidation,
} from "#shared/cache-registry.ts";

// Re-exported for users.ts, which caches a table-less query and so wires the
// cache by hand rather than through cachedEntityTable.
export { createKeyedCache, registerCache, registerTableInvalidation };

/** Input shared by ordered tables whose only required value is a name. */
export interface NamedSortOrderInput {
  name: string;
  sortOrder?: number;
}

/**
 * A write to the table, or to a `dependsOn` table whose triggers feed it,
 * clears the cache automatically at the db-client layer.
 *
 * `Cached` lets the cache hold a richer row than the table writes, such as
 * listings cached with attendee counts.
 *
 * A `whenColumns` gate narrows the UPDATE case only. INSERT and DELETE always
 * clear.
 */
export const cachedEntityTable = <Row, Input, Cached = Row>(
  name: string,
  table: Table<Row, Input>,
  config: KeyedCacheConfig<Cached>,
  dependsOn: readonly DependsOnEntry[] = [],
): { cache: KeyedCache<Cached>; table: Table<Row, Input> } => {
  const cache = createKeyedCache(config);
  registerCache(() => ({ entries: cache.size(), name }));
  registerDependencies(table.name, dependsOn, cache.invalidate);
  return { cache, table };
};

/** Stored values of the trigger-maintained aggregate columns `F`, keyed by column. */
export type AggregateValues<F extends string> = Record<F, number>;

/** Per-column comparison of each aggregate `F`'s stored value against its
 * rebuilt-from-source value — what the "recalculate aggregates" tools return. */
export type AggregateRecalculation<F extends string> = Record<
  F,
  { current: number; recalculated: number }
>;

/** The two owner-facing repairs every trigger-maintained aggregate column set
 * needs: write the numbers the operator typed, and rebuild chosen columns from
 * the rows they count. */
export type AggregateRepairs<F extends string> = {
  reset: (entityId: number, fields: readonly F[]) => Promise<void>;
  update: (entityId: number, values: AggregateValues<F>) => Promise<void>;
};

/**
 * Both repairs for one table's aggregate columns, given the SQL that recounts
 * each one. Every aggregate family declares its table and its per-column
 * recount here rather than writing the same two wrappers again.
 */
export const aggregateRepairs = <F extends string>(
  table: string,
  resetSql: Record<F, string>,
): AggregateRepairs<F> => ({
  reset: (entityId, fields) =>
    resetAggregates(table, entityId, fields, resetSql),
  update: async (entityId, values) => {
    await executeUpdate(table, { ...values }, { id: entityId });
  },
});

type EncryptFn = (v: string) => Promise<EnvKeyEncrypted>;
type DecryptFn = (v: EnvKeyEncrypted) => Promise<string>;

/** Encrypted `slug` + its plaintext blind-index `slug_index` (the permalink
 * pair shared by pages and news posts). */
export const encryptedSlugSchema = (
  encrypt: EncryptFn,
  decrypt: DecryptFn,
) => ({
  slug: col.encrypted(encrypt, decrypt),
  slug_index: col.simple<BlindIndex>(),
});

/** Shared encrypted `name` column for tables that store a display name. */
export const encryptedNameSchema = (
  encrypt: EncryptFn,
  decrypt: DecryptFn,
) => ({
  name: col.encrypted(encrypt, decrypt),
});

/** Give an encrypted-column schema builder a generated `id` column as well —
 * the shared opener of the "id plus encrypted fields" table schemas below. */
const withGeneratedId =
  <Schema>(buildSchema: (encrypt: EncryptFn, decrypt: DecryptFn) => Schema) =>
  (
    encrypt: EncryptFn,
    decrypt: DecryptFn,
  ): Schema & { id: ColumnDef<number> } => ({
    id: col.generated<number>(),
    ...buildSchema(encrypt, decrypt),
  });

/** Shared columns for tables with a generated id plus the encrypted slug pair. */
export const idAndEncryptedSlugSchema = withGeneratedId(encryptedSlugSchema);

/** Shared columns for tables with a generated id plus an encrypted name. */
export const idAndEncryptedNameSchema = withGeneratedId(encryptedNameSchema);

/** Shared generated `id` + plaintext `created` stamp columns. `created` stays
 * unencrypted so SQL can order and prune by time without decrypting. */
export const idAndCreatedSchema = (now: () => string) => ({
  created: col.withDefault(now),
  id: col.generated<number>(),
});

/** Shared encrypted SEO/content columns for operator-authored pages
 * (site pages, news posts): the markdown body plus the meta pair. */
export const encryptedSeoContentSchema = (
  encrypt: EncryptFn,
  decrypt: DecryptFn,
) => ({
  content: col.encryptedText(encrypt, decrypt),
  meta_description: col.encryptedText(encrypt, decrypt),
  meta_title: col.encryptedText(encrypt, decrypt),
});
