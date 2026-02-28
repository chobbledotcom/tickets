/**
 * Functional programming utilities
 * Curried functions for array operations and composition
 */

// --- Pipe type helpers (used by the 6+ catch-all overload) ---

/** A single-arg function (used as a constraint for pipe/pipeAsync generics) */
// deno-lint-ignore no-explicit-any
type Fn = (arg: any) => any;

/** Validates that each fn's return type is assignable to the next fn's parameter */
type ValidChain<Fns extends Fn[]> = Fns extends [Fn]
  ? true
  : Fns extends
    [infer A extends Fn, infer B extends Fn, ...infer Rest extends Fn[]]
    ? ReturnType<A> extends Parameters<B>[0] ? ValidChain<[B, ...Rest]>
      : false
    : true;

/** Extracts the return type of the last fn in a tuple */
type LastReturn<Fns extends Fn[]> = Fns extends [...Fn[], infer L extends Fn]
  ? ReturnType<L>
  : never;

/** Computes pipe's return type, returning a non-callable error type on mismatch */
type PipeReturn<Fns extends [Fn, ...Fn[]]> = ValidChain<Fns> extends true
  ? (arg: Parameters<Fns[0]>[0]) => LastReturn<Fns>
  : (invalid: never) => never;

/**
 * Compose functions left-to-right (pipe)
 * Overloads 1-5 use bidirectional inference for optimal generic resolution.
 * The recursive catch-all handles 6+ functions with full type safety.
 */
export function pipe<A>(): (a: A) => A;
export function pipe<A, B>(fn1: (a: A) => B): (a: A) => B;
export function pipe<A, B, C>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
): (a: A) => C;
export function pipe<A, B, C, D>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
): (a: A) => D;
export function pipe<A, B, C, D, E>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
): (a: A) => E;
export function pipe<A, B, C, D, E, F>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D,
  fn4: (d: D) => E,
  fn5: (e: E) => F,
): (a: A) => F;
export function pipe<Fns extends [Fn, Fn, Fn, Fn, Fn, Fn, ...Fn[]]>(
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
 * Sort by a key or getter function
 */
export const sortBy =
  <T>(keyOrFn: keyof T | ((item: T) => string | number)) =>
  (array: T[]): T[] => {
    const getValue = (item: T): string | number =>
      typeof keyOrFn === "function"
        ? keyOrFn(item)
        : (item[keyOrFn] as string | number);

    return [...array].sort((a, b) => {
      const aVal = getValue(a);
      const bVal = getValue(b);
      if (aVal < bVal) return -1;
      if (aVal > bVal) return 1;
      return 0;
    });
  };

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
 * Remove falsy values from array
 */
export const compact = <T>(
  array: (T | null | undefined | false | 0 | "")[],
): T[] => array.filter(Boolean) as T[];

/**
 * Group array items by a key function
 */
export const groupBy =
  <T>(fn: (item: T) => string) =>
  (array: T[]): Record<string, T[]> => {
    const result: Record<string, T[]> = {};
    for (const item of array) {
      const key = fn(item);
      if (!result[key]) {
        result[key] = [];
      }
      result[key].push(item);
    }
    return result;
  };

/**
 * Memoize a function (cache results)
 */
export const memoize = <T extends (...args: Parameters<T>) => ReturnType<T>>(
  fn: T,
): T => {
  const cache = new Map<string, ReturnType<T>>();
  return ((...args: Parameters<T>): ReturnType<T> => {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key)!;
    }
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }) as T;
};

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
 * Pick specific keys from an object
 */
export const pick =
  <T extends object, K extends keyof T>(keys: K[]) =>
  (obj: T): Pick<T, K> => {
    const result = {} as Pick<T, K>;
    for (const key of keys) {
      if (key in obj) {
        result[key] = obj[key];
      }
    }
    return result;
  };

/**
 * Check if value is not null or undefined
 */
export const isDefined = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;

/**
 * Identity function
 */
export const identity = <T>(value: T): T => value;

/**
 * Result type for operations that can fail with a Response
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/**
 * Create a successful result
 */
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/**
 * Create a failed result
 */
export const err = (response: Response): Result<never> => ({
  ok: false,
  response,
});

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

// --- Async pipe type helpers (used by the 5+ catch-all overload) ---

/** A single-arg async function */
// deno-lint-ignore no-explicit-any
type AsyncFn = (arg: any) => Promise<any>;

/** Validates that each async fn's Awaited return matches the next fn's parameter */
type ValidAsyncChain<Fns extends AsyncFn[]> = Fns extends [AsyncFn]
  ? true
  : Fns extends
    [infer A extends AsyncFn, infer B extends AsyncFn, ...infer Rest extends AsyncFn[]]
    ? Awaited<ReturnType<A>> extends Parameters<B>[0]
      ? ValidAsyncChain<[B, ...Rest]>
      : false
    : true;

/** Extracts the Awaited return type of the last async fn */
type LastAsyncReturn<Fns extends AsyncFn[]> = Fns extends [
  ...AsyncFn[],
  infer L extends AsyncFn,
] ? Awaited<ReturnType<L>>
  : never;

/** Computes pipeAsync's return type, returning a non-callable error type on mismatch */
type PipeAsyncReturn<Fns extends [AsyncFn, ...AsyncFn[]]> =
  ValidAsyncChain<Fns> extends true
    ? (arg: Parameters<Fns[0]>[0]) => Promise<LastAsyncReturn<Fns>>
    : (invalid: never) => Promise<never>;

/**
 * Async pipe - compose async functions left-to-right
 * Each function receives the awaited result of the previous one.
 * Overloads 1-4 use bidirectional inference; recursive catch-all handles 5+.
 */
export function pipeAsync<A, B>(
  fn1: (a: A) => Promise<B>,
): (a: A) => Promise<B>;
export function pipeAsync<A, B, C>(
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
): (a: A) => Promise<C>;
export function pipeAsync<A, B, C, D>(
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
  fn3: (c: C) => Promise<D>,
): (a: A) => Promise<D>;
export function pipeAsync<A, B, C, D, E>(
  fn1: (a: A) => Promise<B>,
  fn2: (b: B) => Promise<C>,
  fn3: (c: C) => Promise<D>,
  fn4: (d: D) => Promise<E>,
): (a: A) => Promise<E>;
export function pipeAsync<Fns extends [AsyncFn, AsyncFn, AsyncFn, AsyncFn, AsyncFn, ...AsyncFn[]]>(
  ...fns: [...Fns]
): PipeAsyncReturn<Fns>;
export function pipeAsync(
  ...fns: Array<(arg: unknown) => Promise<unknown>>
): (value: unknown) => Promise<unknown> {
  return async (value: unknown): Promise<unknown> => {
    let result = value;
    for (const fn of fns) {
      result = await fn(result);
    }
    return result;
  };
}

/**
 * Map over a promise-returning function (async map)
 */
export const mapAsync =
  <T, U>(fn: (item: T) => Promise<U>) =>
  async (array: T[]): Promise<U[]> => {
    const results: U[] = [];
    for (const item of array) {
      results.push(await fn(item));
    }
    return results;
  };

/** Bounded LRU cache returned by boundedLru() */
export type BoundedLru<K, V> = {
  get: (key: K) => V | undefined;
  set: (key: K, value: V) => void;
  clear: () => void;
  size: () => number;
};

/**
 * Create a bounded LRU (Least Recently Used) cache.
 * Evicts the oldest entry when capacity is reached.
 * Uses Map insertion order for O(1) LRU tracking.
 */
export const boundedLru = <K, V>(maxSize: number): BoundedLru<K, V> => {
  const cache = new Map<K, V>();
  return {
    get: (key: K): V | undefined => {
      const value = cache.get(key);
      if (value !== undefined) {
        // Move to end (most recently used)
        cache.delete(key);
        cache.set(key, value);
      }
      return value;
    },
    set: (key: K, value: V): void => {
      if (cache.has(key)) {
        cache.delete(key);
      } else if (cache.size >= maxSize) {
        cache.delete(cache.keys().next().value!);
      }
      cache.set(key, value);
    },
    clear: (): void => {
      cache.clear();
    },
    size: (): number => cache.size,
  };
};

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
 */
export const collectionCache = <T>(
  fetchAll: () => Promise<T[]>,
  ttlMs: number,
  now: () => number = Date.now,
): CollectionCache<T> => {
  const [getState, setState] = lazyRef<{ items: T[] | null; time: number }>(
    () => ({ items: null, time: 0 }),
  );
  return {
    getAll: async (): Promise<T[]> => {
      const state = getState();
      if (state.items !== null && now() - state.time < ttlMs) {
        return state.items;
      }
      const items = await fetchAll();
      setState({ items, time: now() });
      return items;
    },
    invalidate: (): void => {
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
