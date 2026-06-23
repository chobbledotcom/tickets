import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { retryWithBackoff } from "#shared/retry.ts";

describe("retryWithBackoff", () => {
  test("returns the result without invoking onError when fn succeeds first try", async () => {
    let onErrorCalls = 0;
    const result = await retryWithBackoff(
      () => Promise.resolve("ok"),
      [1, 1],
      () => {
        onErrorCalls++;
      },
    );
    expect(result).toBe("ok");
    expect(onErrorCalls).toBe(0);
  });

  test("retries after a failure and resolves, reporting willRetry", async () => {
    let attempts = 0;
    const seen: boolean[] = [];
    const result = await retryWithBackoff(
      () => {
        attempts++;
        return attempts < 3
          ? Promise.reject(new Error("transient"))
          : Promise.resolve("recovered");
      },
      [1, 1],
      (_error, { willRetry }) => {
        seen.push(willRetry);
      },
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
    expect(seen).toEqual([true, true]);
  });

  test("rethrows the last error once the backoffs are exhausted", async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        () => {
          attempts++;
          return Promise.reject(new Error("never settles"));
        },
        [1, 1],
        () => {},
      ),
    ).rejects.toThrow("never settles");
    // One initial attempt plus one per backoff entry.
    expect(attempts).toBe(3);
  });

  test("aborts immediately when onError throws", async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        () => {
          attempts++;
          return Promise.reject(new Error("non-retryable"));
        },
        [1, 1],
        (error) => {
          throw error;
        },
      ),
    ).rejects.toThrow("non-retryable");
    expect(attempts).toBe(1);
  });

  test("lets onError swap in a different error on the final attempt", async () => {
    await expect(
      retryWithBackoff(
        () => Promise.reject(new Error("raw")),
        [],
        (_error, { willRetry }) => {
          if (!willRetry) throw new Error("friendly");
        },
      ),
    ).rejects.toThrow("friendly");
  });
});
