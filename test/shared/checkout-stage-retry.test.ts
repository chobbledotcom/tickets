import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkoutStageRetryDelay } from "#shared/checkout-stage-retry.ts";

test("backs checkout recovery off to a six-hour cap", () => {
  expect([0, 1, 2, 3, 4, 20].map(checkoutStageRetryDelay)).toEqual([
    300_000, 900_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000,
  ]);
});
