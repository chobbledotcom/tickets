import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withLazyLogger } from "#shared/lazy-logger.ts";

describe("withLazyLogger", () => {
  test("runs the callback with the loaded logger", async () => {
    let seen: unknown;
    await withLazyLogger((logger) => {
      seen = logger.logError;
    });
    expect(typeof seen).toBe("function");
  });

  test("swallows a throwing callback so a fire-and-forget caller never rejects", async () => {
    // The caller does `void withLazyLogger(...)`; if this rejected it would be
    // an unhandled rejection. It must resolve instead.
    await withLazyLogger(() => {
      throw new Error("logging blew up");
    });
  });

  test("swallows a rejecting async callback too", async () => {
    // An async callback is assignable to the param; its rejection must be
    // awaited and caught, not leaked as an unhandled rejection.
    await withLazyLogger(() =>
      Promise.reject(new Error("async logging blew up")),
    );
  });
});
