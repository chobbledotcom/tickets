import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { LegacyPaymentChargeSchema } from "#shared/db/payments/types.ts";
import { paymentCharge } from "#test/shared/payment-runtime/fixtures.ts";
import { currentCharges } from "#test-utils/current-charge.ts";

const legacyCharge = () =>
  v.parse(LegacyPaymentChargeSchema, {
    createdAt: 1,
    id: 7,
    observedAt: 1,
    paymentId: "pay-legacy",
    providerReference: "hyb:1:sealed",
    providerRefundedAt: null,
    refundState: "unknown",
    source: "processed_payments",
    updatedAt: 1,
  });

describe("the charges a fixture says have money on them", () => {
  test("hands back every charge that was really taken", () => {
    const charges = [paymentCharge({ id: 1 }), paymentCharge({ id: 2 })];

    expect(currentCharges(charges)).toEqual(charges);
  });

  test("hands back an empty list when there are no charges", () => {
    expect(currentCharges([])).toEqual([]);
  });

  test("names the charge that came over from the old payment tables", () => {
    expect(() => currentCharges([legacyCharge()])).toThrow(
      "Charge 7 has no money on it",
    );
  });

  test("refuses as soon as one charge among several has no money", () => {
    expect(() => currentCharges([paymentCharge(), legacyCharge()])).toThrow(
      "Charge 7 has no money on it",
    );
  });
});
