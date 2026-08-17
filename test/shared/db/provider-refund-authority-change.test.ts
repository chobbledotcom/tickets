import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { transitionRefundAuthority } from "#shared/db/provider-refund-authority-change.ts";
import { gbp } from "#test-utils/payment-state.ts";
import { readyRefundForTest } from "#test-utils/refund-authority.ts";

test("a refund authority can never store a non-positive capture", async () => {
  const row = {
    captured: gbp(0),
    id: 1,
    referenceIndex: "zero-capture",
    refunded: gbp(0),
    revision: 1,
    state: readyRefundForTest("keyless"),
  };

  await expect(
    transitionRefundAuthority(row, 120, gbp(0), (state) => state),
  ).rejects.toThrow("Refund authority captured amount must be positive");
});
