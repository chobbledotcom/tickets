import { fn } from "@std/expect/fn";

/** A mock the routes can call and the tests can assert on: the production
 *  signature with the mock's call records. */
export type MockOf<F extends (...args: never[]) => unknown> = F & {
  calls: unknown[];
};

/**
 * A mock function the routes can call and the tests can assert on with
 * `@std/expect`'s `toHaveBeenCalled*` matchers. The builtin `fn` is typed
 * loosely; this re-claims the implementation's signature. The one unsafe cast
 * lives here, not at every call site.
 */
export const mockFn = <F extends (...args: never[]) => unknown>(
  impl: F,
): MockOf<F> => fn(impl as never) as MockOf<F>;
