import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bookingNeedsPayment } from "#shared/booking/payment-needed.ts";

describe("bookingNeedsPayment", () => {
  const cases = [
    {
      customUnitPrice: 200,
      expected: false,
      name: "does not charge when payments are disabled",
      paymentsEnabled: false,
      unitPrice: 100,
    },
    {
      customUnitPrice: undefined,
      expected: true,
      name: "charges for a priced listing",
      paymentsEnabled: true,
      unitPrice: 1,
    },
    {
      customUnitPrice: undefined,
      expected: false,
      name: "does not charge for a free listing",
      paymentsEnabled: true,
      unitPrice: 0,
    },
    {
      customUnitPrice: 1,
      expected: true,
      name: "charges for a positive custom price",
      paymentsEnabled: true,
      unitPrice: 0,
    },
    {
      customUnitPrice: 0,
      expected: false,
      name: "does not charge for a zero custom price on a free listing",
      paymentsEnabled: true,
      unitPrice: 0,
    },
  ] as const;

  for (const testCase of cases) {
    test(testCase.name, () => {
      expect(
        bookingNeedsPayment(
          testCase.paymentsEnabled,
          testCase.unitPrice,
          testCase.customUnitPrice,
        ),
      ).toBe(testCase.expected);
    });
  }
});
