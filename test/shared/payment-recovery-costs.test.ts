import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  CHECKOUT_RECOVERY_EXTERNAL_CALLS,
  MAX_CHECKOUT_RECOVERY_EXTERNAL_CALLS,
} from "#shared/payment-recovery-costs.ts";

test("reserves each provider's physical checkout recovery calls", () => {
  expect(CHECKOUT_RECOVERY_EXTERNAL_CALLS).toEqual({
    square: 5,
    stripe: 9,
    sumup: 4,
  });
  expect(MAX_CHECKOUT_RECOVERY_EXTERNAL_CALLS).toBe(9);
});
