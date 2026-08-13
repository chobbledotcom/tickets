import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectClosedCheckoutFailure,
  expectSameThrown,
} from "#test-utils/checkout-failure.ts";

describe("checkout failure assertions", () => {
  test("reject a checkout that did not fail", async () => {
    await expect(
      expectSameThrown(Promise.resolve("created"), "created"),
    ).rejects.toThrow("Expected the checkout to fail");
  });

  test("reject a provider failure that is not an Error", async () => {
    await expect(
      expectClosedCheckoutFailure(Promise.reject("failed"), {
        provider: "stripe",
        reason: "timeout",
      }),
    ).rejects.toThrow("Checkout threw a non-error");
  });
});
