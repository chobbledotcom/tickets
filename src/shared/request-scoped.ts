/**
 * Request-scoped state, safe against leaked async contexts.
 *
 * A dozen modules keep per-request state — the collection cache, the pending
 * work queue, the locale, the client IP, the query log — set at the request
 * boundary and read deep inside rendering, so it cannot be threaded through as
 * arguments. Module globals race: one edge isolate serving two requests has one
 * global, so request B's write clobbers request A's while A is parked on an
 * `await`. An `AsyncLocalStorage` scope per piece fixes that.
 *
 * The runtime adds one trap: it can re-attach a finished request's context to
 * later, unrelated work. Post-request reads are meaningless here — pending work
 * is flushed before the response is sent — so a store seen after its scope
 * settled is always that leak, and reads treat it as being outside a scope.
 *
 * This is the only module allowed to touch `AsyncLocalStorage`, so the rule
 * cannot be bypassed. Everything else builds on {@link createScope} (a store
 * per `run`), {@link createScopedValue} (one fixed value per scope with a
 * fallback outside it), or {@link createRequestScoped} (a mutable container
 * falling back to a shared ambient one, so a test rendering a component
 * directly keeps simple set-then-read behaviour).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Stores whose scope has already finished — see the module doc. */
const endedStores = new WeakSet<object>();

/** Runs `fn` inside an async scope whose store dies when `fn`'s promise
 * settles. The named type keeps every such runner's signature in one place. */
export type ScopeRunner = <T>(fn: () => Promise<T>) => Promise<T>;

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

/** A request-scoped container plus the helpers its owning module builds on. */
export type RequestScoped<T extends object> = {
  /** Run `fn` with a fresh per-request container bound to the async scope. */
  run: <R>(fn: () => R) => R;
  /** The active request's container, or the ambient fallback outside a scope. */
  current: () => T;
};

/**
 * Build a request-scoped container. `initial` is called to mint a fresh
 * container for each scope (and once for the ambient fallback), so callers must
 * return a new object each time rather than sharing one instance.
 */
export const createRequestScoped = <T extends object>(
  initial: () => T,
): RequestScoped<T> => {
  const scope = createScope<T>();
  const fallback = initial();
  return {
    current: () => scope.current() ?? fallback,
    run: (fn) => scope.run(initial(), fn),
  };
};
