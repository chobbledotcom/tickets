/**
 * Per-request collection cache using AsyncLocalStorage.
 *
 * Each incoming request gets a fresh cache scope. The first call to
 * getAll() fetches from the database; subsequent calls within the same
 * request return the cached result. Writes call invalidate() to clear
 * the cached data so the next read re-fetches.
 *
 * Outside a request context (e.g. tests), every getAll() call fetches
 * directly — no caching is applied.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CollectionCache } from "#fp";

/** Per-request store: maps each cache's unique key to its cached data */
type RequestStore = Map<symbol, unknown[] | Promise<unknown[]>>;

const storage = new AsyncLocalStorage<RequestStore>();

/** Run a function within a per-request cache scope */
export const runWithRequestCache = <T>(fn: () => T): T =>
  storage.run(new Map(), fn);

/**
 * Create a per-request collection cache.
 *
 * Same CollectionCache interface as collectionCache(), but scoped to the
 * current request instead of using a global TTL. This eliminates stale
 * reads across edge isolates — every request starts fresh.
 */
export const requestCache = <T>(
  fetchAll: () => Promise<T[]>,
): CollectionCache<T> => {
  const key = Symbol();

  return {
    getAll: async (): Promise<T[]> => {
      const store = storage.getStore();
      if (!store) return fetchAll();

      const cached = store.get(key);
      if (cached) return cached as T[] | Promise<T[]>;

      let resolve!: (items: T[]) => void;
      let reject!: (error: unknown) => void;
      const promise: Promise<T[]> = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A fire-and-forget prefetch may leave this promise unobserved; an
      // unobserved rejection would kill the isolate.
      promise.catch(() => {});
      store.set(key, promise);
      try {
        const items = await fetchAll();
        // Replace the promise with the resolved array so future
        // reads within this request get the array directly.
        if (store.get(key) === promise) store.set(key, items);
        resolve(items);
        return items;
      } catch (error) {
        // Drop the entry so the next read fetches fresh — a cached
        // rejection would wedge the whole request.
        if (store.get(key) === promise) store.delete(key);
        reject(error);
        throw error;
      }
    },

    invalidate: (): void => {
      storage.getStore()?.delete(key);
    },

    size: (): number => {
      const cached = storage.getStore()?.get(key);
      return Array.isArray(cached) ? cached.length : 0;
    },
  };
};
