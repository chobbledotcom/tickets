import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Spy, spy } from "@std/testing/mock";

/**
 * Scoped `console.error` spy — call inside a describe block. Every classified
 * server error ends in `logError` → `console.error`, so asserting on the spy is
 * how a test proves an error path *logged*, not just returned a failure value
 * (a removed logError call is otherwise unobservable).
 */
/** Spy on one console method for each test in the block, restoring it after.
 * The single place a test suite takes console output over. */
export const useConsoleSpy = (method: "debug" | "error"): (() => Spy) => {
  let consoleSpy: Spy;
  beforeEach(() => {
    consoleSpy = spy(console, method);
  });
  afterEach(() => {
    consoleSpy.restore();
  });
  return () => consoleSpy;
};

export const setupErrorSpy = (): {
  readonly calls: Spy["calls"];
  lastMessage: () => string | undefined;
  contains: (needle: string) => boolean;
} => {
  const errorSpy = useConsoleSpy("error");
  return {
    get calls() {
      return errorSpy().calls;
    },
    contains: (needle: string) =>
      errorSpy().calls.some((call) => String(call.args[0]).includes(needle)),
    lastMessage: () => errorSpy().calls.at(-1)?.args[0] as string | undefined,
  };
};
