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
  const store = new AsyncLocalStorage<T>();
  const fallback = initial();
  return {
    current: () => store.getStore() ?? fallback,
    run: (fn) => store.run(initial(), fn),
  };
};
