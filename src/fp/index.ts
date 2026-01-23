/**
 * Functional programming utilities
 * Curried functions for array operations and composition
 */

/**
 * Compose functions left-to-right (pipe)
 * Supports type transformations through the chain
 */
export function pipe<A>(): (a: A) => A;
export function pipe<A, B>(fn1: (a: A) => B): (a: A) => B;
export function pipe<A, B, C>(fn1: (a: A) => B, fn2: (b: B) => C): (a: A) => C;
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
      return cache.get(key) as ReturnType<T>;
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

/**
 * Async pipe - compose async functions left-to-right
 * Each function receives the result of the previous one
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
