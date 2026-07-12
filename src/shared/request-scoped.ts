/**
 * Request-scoped mutable state with an ambient fallback.
 *
 * A handful of render-time values (iframe mode, the current CSRF token, the
 * saved-form-data stash) are set at the request boundary and read synchronously
 * by deep JSX components, so they can't be threaded through as arguments. They
 * used to live in plain module-global objects, which race under concurrency: a
 * single edge isolate serving two requests at once has one global, so request
 * B's write clobbers request A's value while A is parked on an `await`.
 *
 * `createRequestScoped` fixes that by backing each value with an
 * `AsyncLocalStorage` container. Inside a `run()` scope (established once per
 * request in the `runWith*` chain) each request gets its own container, so
 * concurrent requests never see each other's state. Outside any scope — unit
 * tests that render a component directly, or any non-request rendering — reads
 * and writes fall back to a single ambient container, preserving the simple
 * synchronous set-then-read behaviour those callers have always relied on.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Stores whose scope has already finished.
 *
 * The runtime can re-attach a finished request's async context to later,
 * unrelated work: on Deno 2.5.6 a forced GC at a test boundary deterministically
 * left the test runner's whole continuation chain inside a request context that
 * had ended long before, so every later `getStore()` returned a dead request's
 * state. Post-request reads of request-scoped state are meaningless in this app
 * (pending work is flushed before the response is sent), so a store seen after
 * its scope settled is always this runtime leak — reads must treat it exactly
 * like being outside a scope.
 */
const endedStores = new WeakSet<object>();

/**
 * Run `fn` inside `storage`'s scope with `store`, and mark the store ended once
 * `fn` finishes (for an async `fn`, once its promise settles). After that,
 * {@link liveScopeStore} reads it as absent, so a leaked context can never
 * serve a finished request's state. `store` must be a fresh object per call —
 * a reused one would already be marked ended, so reuse throws.
 */
export const runWithScopeLifetime = <S extends object, T>(
  storage: AsyncLocalStorage<S>,
  store: S,
  fn: () => T,
): T => {
  if (endedStores.has(store)) {
    throw new Error(
      "Scope store reused after its scope ended — mint a fresh store object for every run",
    );
  }
  let result: T;
  try {
    result = storage.run(store, fn);
  } catch (error) {
    endedStores.add(store);
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(() => {
      endedStores.add(store);
    }) as T;
  }
  endedStores.add(store);
  return result;
};

/**
 * The current context's store while its scope is still running: `undefined`
 * outside any scope, and `undefined` when the inherited scope already ended
 * (the runtime context leak described on {@link endedStores}).
 */
export const liveScopeStore = <S extends object>(
  storage: AsyncLocalStorage<S>,
): S | undefined => {
  const store = storage.getStore();
  return store === undefined || endedStores.has(store) ? undefined : store;
};

/** Runs `fn` inside an async scope whose store dies when `fn`'s promise
 * settles. The named type keeps every such runner's signature in one place. */
export type ScopeRunner = <T>(fn: () => Promise<T>) => Promise<T>;

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
  const storage = new AsyncLocalStorage<T>();
  const fallback = initial();
  return {
    current: () => liveScopeStore(storage) ?? fallback,
    run: (fn) => runWithScopeLifetime(storage, initial(), fn),
  };
};
