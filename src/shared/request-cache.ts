/**
 * Per-request collection cache using AsyncLocalStorage.
 *
 * Each incoming request gets a fresh cache scope. The first call to
 * getAll() fetches from the database; subsequent calls within the same
 * request return the cached result. Writes call invalidate() to clear
 * the cached data. Refills use the primary while replicas catch up, including
 * when the next read happens in the request reached through a redirect.
 *
 * {@link requestBatchCache} is the same idea for lookups that arrive in
 * batches: it remembers each id it has already looked up this request, so a
 * later batch only asks the database for the ids nobody has fetched yet.
 *
 * Outside a request context (e.g. tests), every getAll() call fetches
 * directly — no caching is applied.
 */

import { createPrimaryCacheRefill } from "#db/primary-reads.ts";
/* jscpd:ignore-start -- imports */
import { type CollectionCache, requiredMapValue, unique } from "#fp";
import type { CacheInvalidation } from "#shared/cache-registry.ts";
import { createScope } from "#shared/request-scoped.ts";

/* jscpd:ignore-end */

/** Per-request store: maps each cache's unique key to its cached data */
type RequestStore = Map<symbol, unknown>;

interface RequestCollectionCache<T> extends CollectionCache<T> {
  invalidate: (cause?: CacheInvalidation) => void;
  /** Hand this request's cache an answer that has already been read — by a
   * batch that asked several small reads at once — so `getAll` serves it
   * instead of querying. Outside a request there is nowhere to keep it, so the
   * next `getAll` reads for itself. */
  prime: (items: T[]) => void;
}

const cacheScope = createScope<RequestStore>();

/** Run a function within a per-request cache scope */
export const runWithRequestCache = <T>(fn: () => T): T =>
  cacheScope.run(new Map(), fn);

/** The slot one cache keeps its data in for the current request, plus the
 * refill and invalidate every cache shares. Outside a request (or in a leaked
 * context that already ended — see createScope) `read` and `write` do nothing,
 * so callers fetch fresh instead of serving a finished request's data. */
const cacheSlot = <S>() => {
  const key = Symbol();
  const primaryRefill = createPrimaryCacheRefill();
  return {
    inScope: (): boolean => cacheScope.current() !== undefined,
    invalidate: (cause: CacheInvalidation = "manual"): void => {
      primaryRefill.afterInvalidation(cause === "write");
      cacheScope.current()?.delete(key);
    },
    primaryRefill,
    read: (): S | undefined => cacheScope.current()?.get(key) as S | undefined,
    remove: (): void => {
      cacheScope.current()?.delete(key);
    },
    write: (value: S): void => {
      cacheScope.current()?.set(key, value);
    },
  };
};

/** Keep an unobserved promise's rejection from killing the isolate. A cached
 * promise may be handed to nobody — a fire-and-forget prefetch, or a shared
 * batch fetch answering ids this caller never asked for. */
const ignoreUnobserved = (promise: Promise<unknown>): void => {
  promise.catch(() => {});
};

/**
 * Create a per-request collection cache.
 *
 * Same CollectionCache interface as collectionCache(), but scoped to the
 * current request instead of using a global TTL. This eliminates stale
 * reads across edge isolates — every request starts fresh.
 */
export const requestCache = <T>(
  fetchAll: () => Promise<T[]>,
): RequestCollectionCache<T> => {
  const slot = cacheSlot<T[] | Promise<T[]>>();

  return {
    getAll: async (): Promise<T[]> => {
      if (!slot.inScope()) return slot.primaryRefill.fetch(fetchAll);

      const cached = slot.read();
      if (cached) return cached;

      let resolve!: (items: T[]) => void;
      let reject!: (error: unknown) => void;
      const promise: Promise<T[]> = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      ignoreUnobserved(promise);
      slot.write(promise);
      try {
        const items = await slot.primaryRefill.fetch(fetchAll);
        // Replace the promise with the resolved array so future
        // reads within this request get the array directly.
        if (slot.read() === promise) slot.write(items);
        resolve(items);
        return items;
      } catch (error) {
        // Drop the entry so the next read fetches fresh — a cached
        // rejection would wedge the whole request.
        if (slot.read() === promise) slot.remove();
        reject(error);
        throw error;
      }
    },

    invalidate: slot.invalidate,

    prime: (items: T[]): void => slot.write(items),

    size: (): number => {
      const cached = slot.read();
      return Array.isArray(cached) ? cached.length : 0;
    },
  };
};

/** A lookup that answers a whole batch of ids in one go. */
export type BatchLookup<T> = (ids: number[]) => Promise<Map<number, T>>;

/** A per-request memo for lookups that arrive in batches. */
export interface RequestBatchCache<T> {
  /** The value for every id asked for. Only the ids this request has not
   * looked up yet reach `fetchMany`. */
  getMany: (ids: readonly number[]) => Promise<Map<number, T>>;
  invalidate: (cause?: CacheInvalidation) => void;
}

/**
 * Create a per-request memo for a batch lookup.
 *
 * `fetchMany` must answer for every id it is given — a missing id is a bug in
 * the loader, not an empty result, so it throws rather than caching a hole.
 *
 * Page rendering asks the same loaders for overlapping id sets over and over
 * (a listing's groups for two listings, then for all fourteen, then for the
 * same fourteen again). Whole-set caching misses every time the set differs;
 * remembering ids one at a time turns those repeats into one query for the
 * ids nobody has asked for yet.
 */
export const requestBatchCache = <T>(
  fetchMany: BatchLookup<T>,
): RequestBatchCache<T> => {
  const slot = cacheSlot<Map<number, Promise<T>>>();

  /** This request's remembered ids, or undefined outside a request. */
  const remembered = (): Map<number, Promise<T>> | undefined => {
    if (!slot.inScope()) return;
    const existing = slot.read();
    if (existing) return existing;
    const fresh = new Map<number, Promise<T>>();
    slot.write(fresh);
    return fresh;
  };

  /** Fetch the ids nobody has asked for yet, and remember each one. */
  const rememberMissing = (
    values: Map<number, Promise<T>>,
    missing: number[],
  ): void => {
    const fetched = slot.primaryRefill.fetch(() => fetchMany(missing));
    const answerFor = async (id: number): Promise<T> =>
      requiredMapValue(await fetched, id, `Missing batch result for id ${id}`);
    for (const id of missing) {
      const value = answerFor(id);
      // A failed fetch must not stay remembered, or it would wedge the rest of
      // the request. This also observes the rejection: one shared fetch
      // answers several ids, and a caller that asked for only some leaves the
      // others unobserved, which would otherwise kill the isolate.
      value.catch(() => {
        if (values.get(id) === value) values.delete(id);
      });
      values.set(id, value);
    }
  };

  return {
    getMany: async (ids) => {
      const wanted = unique([...ids]);
      const values = remembered();
      if (!values) return slot.primaryRefill.fetch(() => fetchMany(wanted));

      const missing = wanted.filter((id) => !values.has(id));
      if (missing.length > 0) rememberMissing(values, missing);
      const answered = await Promise.all(
        wanted.map(
          async (id): Promise<[number, T]> => [
            id,
            await requiredMapValue(values, id, `Missing memo for id ${id}`),
          ],
        ),
      );
      return new Map(answered);
    },

    invalidate: slot.invalidate,
  };
};
