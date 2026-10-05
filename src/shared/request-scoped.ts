/**
 * Request-scoped state, safe against leaked async contexts. Module globals
 * race: one isolate serving two requests has one global, so request B's write
 * clobbers A's while A is parked on an `await`.
 *
 * The runtime adds one trap. It can re-attach a finished request's context to
 * later, unrelated work. A post-request read is meaningless here, because
 * pending work is flushed before the response is sent, so a leaked store is
 * always that trap, and a read treats it as outside a scope.
 *
 * This is the only module allowed to touch `AsyncLocalStorage`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Stores whose scope has already finished — see the module doc. */
const endedStores = new WeakSet<object>();

/** Runs `fn` inside an async scope whose store dies when `fn`'s promise
 * settles. The named type keeps every such runner's signature in one place. */
export type ScopeRunner = <T>(fn: PromiseTask<T>) => Promise<T>;

/** An asynchronous task a scope runner accepts. */
export type PromiseTask<T> = () => Promise<T>;

/**
 * A per-run store bound to the current async scope. The base mechanism every
 * request-scoped module builds on.
 */
export type Scope<S extends object> = {
  /** Run `fn` with `store` bound to the scope. The store dies when `fn`
   * finishes (for an async `fn`, when its promise settles), so it must be a
   * fresh object per call — reusing one throws. */
  run: <T>(store: S, fn: () => T) => T;
  /** The current scope's store while it is still running: `undefined` outside
   * any scope, and `undefined` when the inherited scope already ended (the
   * runtime context leak described in the module doc). */
  current: () => S | undefined;
};

/** Build a {@link Scope}. */
export const createScope = <S extends object>(): Scope<S> => {
  const storage = new AsyncLocalStorage<S>();
  const end = (store: S): void => {
    endedStores.add(store);
  };
  const run = <T>(store: S, fn: () => T): T => {
    if (endedStores.has(store)) {
      throw new Error(
        "Scope store reused after its scope ended — mint a fresh store object for every run",
      );
    }
    let result: T;
    try {
      result = storage.run(store, fn);
    } catch (error) {
      end(store);
      throw error;
    }
    if (result instanceof Promise) {
      return result.finally(() => end(store)) as T;
    }
    end(store);
    return result;
  };
  return {
    current: () => {
      const store = storage.getStore();
      return store === undefined || endedStores.has(store) ? undefined : store;
    },
    run,
  };
};

/** One value carried by the current scope. */
export type ScopedValue<V> = {
  /** Run `fn` with `value` held for the scope. */
  run: <T>(value: V, fn: () => T) => T;
  /** The scope's value, or `fallback()` outside a live scope. A nullish
   * scoped value also reads as the fallback, so hold only values that are
   * never null or undefined. */
  read: () => V;
};

/** Build a {@link ScopedValue} with `fallback` for reads outside any scope. */
export const createScopedValue = <V>(fallback: () => V): ScopedValue<V> => {
  const scope = createScope<{ value: V }>();
  return {
    read: () => scope.current()?.value ?? fallback(),
    run: (value, fn) => scope.run({ value }, fn),
  };
};

/** A scoped on/off switch: `runUnder(fn)` holds the switch on for `fn`'s
 * calls, and `read()` answers whether the current async scope has it on —
 * false outside every scope. The one shape behind every "these calls answer
 * differently inside this scope" flag (a build's dry-run answers, database
 * reads taken on the primary). */
export const createBooleanScope = (): {
  read: () => boolean;
  runUnder: <T>(fn: () => T) => T;
} => {
  const flag = createScopedValue(() => false);
  return {
    read: () => flag.read(),
    runUnder: <T>(fn: () => T): T => flag.run(true, fn),
  };
};
