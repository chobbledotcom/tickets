import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  CHECKOUT_RECOVERY_DATABASE_CALLS,
  CHECKOUT_RECOVERY_EXTERNAL_CALLS,
  CHECKOUT_RECOVERY_FOLLOW_UP_DATABASE_CALLS,
  MAX_CHECKOUT_RECOVERY_DATABASE_CALLS,
  MAX_CHECKOUT_RECOVERY_EXTERNAL_CALLS,
} from "#shared/payment-recovery-costs.ts";

test("reserves stage attempts and both checkout recovery queue queries", () => {
  expect(CHECKOUT_RECOVERY_DATABASE_CALLS).toEqual({
    paid: 22,
    pending: 5,
    refunding: 23,
  });
  expect(CHECKOUT_RECOVERY_FOLLOW_UP_DATABASE_CALLS).toBe(1);
  expect(MAX_CHECKOUT_RECOVERY_DATABASE_CALLS).toBe(25);
});

test("reserves each provider's physical checkout recovery calls", () => {
  expect(CHECKOUT_RECOVERY_EXTERNAL_CALLS).toEqual({
    square: 5,
    stripe: 9,
    sumup: 4,
  });
  expect(MAX_CHECKOUT_RECOVERY_EXTERNAL_CALLS).toBe(9);
});
