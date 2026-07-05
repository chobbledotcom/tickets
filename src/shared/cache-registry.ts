/**
 * Global cache stats registry.
 * Cache modules register stat providers at load time;
 * the debug footer reads them at render time.
 */

/** A single cache's stats snapshot */
export type CacheStat = {
  readonly name: string;
  readonly entries: number;
  readonly capacity?: number;
};

type CacheStatProvider = () => CacheStat;

const providers: CacheStatProvider[] = [];

/** Register a cache stat provider (called at module load time) */
export const registerCache = (provider: CacheStatProvider): void => {
  providers.push(provider);
};

/** Collect stats from all registered caches */
export const getAllCacheStats = (): CacheStat[] => providers.map((p) => p());

/**
 * Table → cache invalidation registry.
 *
 * A cache declares the physical tables whose mutation should clear it (its own
 * table, plus any table a DB trigger writes through to — e.g. the listings
 * cache depends on `listing_attendees` because triggers there maintain the
 * listings aggregate columns). The db client inspects every write statement's
 * target table and fires the registered invalidators, so no write path has to
 * remember to invalidate by hand. Inverting the dependency this way (caches
 * push their invalidator in at load time) keeps the low-level client free of
 * any static import of the cache modules.
 *
 * Column-gated registrations narrow the UPDATE case: a dependency with
 * `whenColumns` only fires when the UPDATE assigns at least one listed column.
 * INSERT, DELETE, and REPLACE always fire regardless of the gate, because a
 * row entering or leaving always shifts the aggregates.
 */

/** Verb of a mutating SQL statement */
export type WriteVerb = "delete" | "insert" | "replace" | "update";

/** Context extracted from a write statement for column-gated invalidation */
export type WriteInfo = {
  verb: WriteVerb;
  /** Lower-cased columns assigned by an UPDATE SET clause; empty for non-updates */
  columns: ReadonlySet<string>;
};

type Invalidator = () => void;
type Registration = {
  invalidate: Invalidator;
  /** If set, an UPDATE only fires when it assigns at least one of these columns.
   * INSERT / DELETE / REPLACE always fire. */
  whenColumns?: ReadonlySet<string> | undefined;
};

const invalidatorsByTable = new Map<string, Set<Registration>>();

const setsIntersect = (
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean => {
  for (const v of a) if (b.has(v)) return true;
  return false;
};

/**
 * Register `invalidate` to run whenever any of `tables` is written.
 *
 * Pass `opts.whenColumns` to gate a dependency on specific UPDATE columns:
 * the invalidator is skipped for UPDATEs that don't assign any listed column
 * (INSERT / DELETE / REPLACE still always fire).
 */
export const registerTableInvalidation = (
  tables: readonly string[],
  invalidate: Invalidator,
  opts?: { whenColumns?: readonly string[] | undefined },
): void => {
  const whenColumns = opts?.whenColumns ? new Set(opts.whenColumns) : undefined;
  const registration: Registration = { invalidate, whenColumns };
  for (const table of tables) {
    const set = invalidatorsByTable.get(table) ?? new Set<Registration>();
    set.add(registration);
    invalidatorsByTable.set(table, set);
  }
};

/** Fire registered cache invalidators for `table`, respecting column gates. */
export const invalidateCachesForWrite = (
  table: string,
  info: WriteInfo,
): void => {
  const set = invalidatorsByTable.get(table);
  if (!set) return;
  for (const reg of set) {
    if (
      info.verb === "update" &&
      reg.whenColumns !== undefined &&
      !setsIntersect(info.columns, reg.whenColumns)
    ) {
      continue;
    }
    reg.invalidate();
  }
};

/** Fire every cache invalidator registered against `table` (no-op if none).
 * Treats the write as unconditional (INSERT semantics): always fires column-gated entries too. */
export const invalidateCachesForTable = (table: string): void =>
  invalidateCachesForWrite(table, { columns: new Set(), verb: "insert" });

/** A `dependsOn` entry accepted by `cachedTable` / `cachedEntityTable`. */
export type DependsOnEntry =
  | string
  | { table: string; whenColumns?: readonly string[] };

/**
 * Register `invalidate` to fire whenever `ownTable` or any `deps` entry is
 * written. Plain string entries are unconditional; object entries may carry
 * `whenColumns` to gate on specific UPDATE columns (INSERT/DELETE always fire).
 * Centralises the registration loop shared by `cachedTable` and `cachedEntityTable`.
 */
export const registerDependencies = (
  ownTable: string,
  deps: ReadonlyArray<DependsOnEntry>,
  invalidate: () => void,
): void => {
  registerTableInvalidation([ownTable], invalidate);
  for (const dep of deps) {
    if (typeof dep === "string") {
      registerTableInvalidation([dep], invalidate);
    } else {
      registerTableInvalidation([dep.table], invalidate, {
        whenColumns: dep.whenColumns,
      });
    }
  }
};

/** Reset the registry (for testing) */
export const resetCacheRegistry = (): void => {
  providers.length = 0;
  invalidatorsByTable.clear();
};
