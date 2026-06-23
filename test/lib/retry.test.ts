import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
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

  test("waits for the backoff delay before the next attempt", async () => {
    const time = new FakeTime();
    try {
      let attempts = 0;
      const promise = retryWithBackoff(
        () => {
          attempts++;
          return attempts < 2
            ? Promise.reject(new Error("transient"))
            : Promise.resolve("ok");
        },
        [1000],
        () => {},
      );
      // Flush microtasks: the first attempt has failed and is now parked on the
      // 1000ms backoff, so the retry must not have run yet.
      await time.tickAsync(0);
      expect(attempts).toBe(1);
      // Only once the backoff elapses does the next attempt fire.
      await time.tickAsync(1000);
      expect(await promise).toBe("ok");
      expect(attempts).toBe(2);
    } finally {
      time.restore();
    }
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
