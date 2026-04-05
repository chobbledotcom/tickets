/**
 * Functional programming utilities
 * Curried functions for array operations and composition
 */

// --- Pipe type helpers ---

/** A single-arg function (used as a constraint for pipe/pipeAsync generics) */
// deno-lint-ignore no-explicit-any
type Fn = (arg: any) => any;

/** Validates that each fn's return type is assignable to the next fn's parameter */
type ValidChain<Fns extends Fn[]> = Fns extends [Fn]
  ? true
  : Fns extends [
        infer A extends Fn,
        infer B extends Fn,
        ...infer Rest extends Fn[],
      ]
    ? ReturnType<A> extends Parameters<B>[0]
      ? ValidChain<[B, ...Rest]>
      : false
    : true;

/** Extracts the return type of the last fn in a tuple */
type LastReturn<Fns extends Fn[]> = Fns extends [...Fn[], infer L extends Fn]
  ? ReturnType<L>
  : never;

/** Computes pipe's return type, returning a non-callable error type on mismatch */
type PipeReturn<Fns extends [Fn, ...Fn[]]> =
  ValidChain<Fns> extends true
    ? (arg: Parameters<Fns[0]>[0]) => LastReturn<Fns>
    : (invalid: never) => never;

/**
 * Compose functions left-to-right (pipe)
 * Uses recursive conditional types for arbitrary-length type safety.
 */
export function pipe<A>(): (a: A) => A;
export function pipe<Fns extends [Fn, ...Fn[]]>(
  ...fns: [...Fns]
): PipeReturn<Fns>;
export function pipe(
  ...fns: Array<(arg: unknown) => unknown>
): (value: unknown) => unknown {
  return (value: unknown): unknown => fns.reduce((acc, fn) => fn(acc), value);
}

/**
 * Curried filter
 */
export const filter =
  <T>(predicate: (item: T) => boolean) =>
  (array: T[]): T[] =>
    array.filter(predicate);

/**
 * Curried map
 */
export const map =
  <T, U>(fn: (item: T) => U) =>
  (array: T[]): U[] =>
    array.map(fn);

/**
 * Curried flatMap
 */
export const flatMap =
  <T, U>(fn: (item: T) => U[]) =>
  (array: T[]): U[] =>
    array.flatMap(fn);

/**
 * Curried reduce
 */
export const reduce =
  <T, U>(fn: (acc: U, item: T) => U, initial: U) =>
  (array: T[]): U =>
    array.reduce(fn, initial);

/**
 * Non-mutating sort with comparator
 */
export const sort =
  <T>(comparator: (a: T, b: T) => number) =>
  (array: T[]): T[] =>
    [...array].sort(comparator);

/**
 * Remove duplicate values (by reference/value equality)
 */
export const unique = <T>(array: T[]): T[] => [...new Set(array)];

/**
 * Remove duplicates by a key function
 */
export const uniqueBy =
  <T>(fn: (item: T) => unknown) =>
  (array: T[]): T[] => {
    const seen = new Set<unknown>();
    const result: T[] = [];
    for (const item of array) {
      const key = fn(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
    return result;
  };

/**
 * Remove null and undefined values from array
 */
export const compact = <T>(array: (T | null | undefined)[]): T[] =>
  array.filter((x): x is T => x !== null && x !== undefined);

/**
 * Lazy evaluation - compute once on first call, cache forever.
 * Use instead of `let x = null; const getX = () => x ??= compute();`
 */
export const once = <T>(fn: () => T): (() => T) => {
  let computed = false;
  let value: T;
  return (): T => {
    if (!computed) {
      value = fn();
      computed = true;
    }
    return value;
  };
};

/**
 * Resettable lazy reference - like once() but can be reset for testing.
 * Returns [get, set] tuple where set(null) resets to uncomputed state.
 */
export const lazyRef = <T>(
  fn: () => T,
): [get: () => T, set: (value: T | null) => void] => {
  let computed = false;
  let value: T;
  const get = (): T => {
    if (!computed) {
      value = fn();
      computed = true;
    }
    return value;
  };
  const set = (newValue: T | null): void => {
    if (newValue === null) {
      computed = false;
    } else {
      value = newValue;
      computed = true;
    }
  };
  return [get, set];
};

/**
 * Resource management pattern (like Haskell's bracket or try-with-resources).
 * Ensures cleanup happens even if the operation throws.
 *
 * @example
 * const withConnection = bracket(
 *   () => openConnection(),
 *   (conn) => conn.close()
 * );
 * const result = await withConnection(async (conn) => conn.query('SELECT 1'));
 */
export const bracket =
  <R>(acquire: () => R | Promise<R>, release: (r: R) => void | Promise<void>) =>
  async <T>(use: (r: R) => T | Promise<T>): Promise<T> => {
    const resource = await acquire();
    try {
      return await use(resource);
    } finally {
      await release(resource);
    }
  };

/**
 * Narrow an unknown value to string, defaulting to "" if not a string.
 * Replaces `typeof x === "string" ? x : ""` at type boundaries.
 */
export const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * Join an array of strings into a single string (curried reduce shorthand).
 * Replaces the common pattern: reduce((acc: string, s: string) => acc + s, "")
 */
export const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/**
 * Split an array into chunks of a given size
 */
export const chunk =
  (size: number) =>
  <T>(array: T[]): T[][] => {
    const result: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      result.push(array.slice(i, i + size));
    }
    return result;
  };

/**
 * Map over a promise-returning function in parallel (Promise.all)
 */
export const mapParallel =
  <T, U>(fn: (item: T) => Promise<U>) =>
  (array: T[]): Promise<U[]> =>
    Promise.all(array.map(fn));

/** Collection cache returned by collectionCache() */
export type CollectionCache<T> = {
  getAll: () => Promise<T[]>;
  invalidate: () => void;
  size: () => number;
};

/**
 * Create an in-memory collection cache with TTL.
 * Loads all items via fetchAll on first access or after invalidation/expiry,
 * then serves from memory until the TTL expires or invalidate() is called.
 * Accepts an optional clock function for testing.
 *
 * Uses a generation counter to prevent a race condition where a concurrent
 * fetchAll() that started before an invalidation could overwrite the cache
 * with stale data.
 */
export const collectionCache = <T>(
  fetchAll: () => Promise<T[]>,
  ttlMs: number,
  now: () => number = Date.now,
): CollectionCache<T> => {
  const [getState, setState] = lazyRef<{ items: T[] | null; time: number }>(
    () => ({ items: null, time: 0 }),
  );
  let generation = 0;
  return {
    getAll: async (): Promise<T[]> => {
      const state = getState();
      if (state.items !== null && now() - state.time < ttlMs) {
        return state.items;
      }
      const gen = generation;
      const items = await fetchAll();
      if (gen === generation) {
        setState({ items, time: now() });
      }
      return items;
    },
    invalidate: (): void => {
      generation++;
      setState(null);
    },
    size: (): number => getState().items?.length ?? 0,
  };
};

/** TTL cache returned by ttlCache() */
export type TtlCache<K, V> = {
  get: (key: K) => V | undefined;
  set: (key: K, value: V) => void;
  clear: () => void;
  size: () => number;
};

/**
 * Create a TTL (Time-To-Live) cache.
 * Entries expire after ttlMs milliseconds.
 * Accepts an optional clock function for testing.
 */
export const ttlCache = <K, V>(
  ttlMs: number,
  now: () => number = Date.now,
): TtlCache<K, V> => {
  const cache = new Map<K, { value: V; cachedAt: number }>();
  return {
    get: (key: K): V | undefined => {
      const entry = cache.get(key);
      if (!entry) return undefined;
      if (now() - entry.cachedAt > ttlMs) {
        cache.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set: (key: K, value: V): void => {
      cache.set(key, { value, cachedAt: now() });
    },
    clear: (): void => {
      cache.clear();
    },
    size: (): number => cache.size,
  };
};
