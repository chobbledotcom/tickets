import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { rejectedError, thrownError } from "#test-utils/errors.ts";

describe("exact test errors", () => {
  test("returns a synchronously thrown Error", () => {
    const expected = new Error("expected sync error");
    expect(
      thrownError(() => {
        throw expected;
      }),
    ).toBe(expected);
  });

  test("rejects a synchronously thrown non-Error value", () => {
    expect(() =>
      thrownError(() => {
        throw "not an Error";
      }),
    ).toThrow(/^Expected an Error object$/);
  });

  test("rejects a function that does not throw", () => {
    expect(() => thrownError(() => undefined)).toThrow(
      /^Expected function to throw$/,
    );
  });

  test("returns an asynchronously rejected Error", async () => {
    const expected = new Error("expected async error");
    expect(await rejectedError(Promise.reject(expected))).toBe(expected);
  });

  test("rejects an asynchronously rejected non-Error value", async () => {
    await expect(rejectedError(Promise.reject("not an Error"))).rejects.toThrow(
      /^Expected an Error object$/,
    );
  });

  test("rejects a promise that resolves", async () => {
    await expect(rejectedError(Promise.resolve())).rejects.toThrow(
      /^Expected promise to reject$/,
    );
  });
});
