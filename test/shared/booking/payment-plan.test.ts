import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { planBookingPayment } from "#booking/payment-plan.ts";

describe("planBookingPayment", () => {
  const cases = [
    {
      expected: { kind: "checkout", unitPrice: 1 },
      input: {
        customUnitPrice: undefined,
        paymentsEnabled: true,
        quantity: 2,
        unitPrice: 1,
      },
      name: "opens checkout at the listing price",
    },
    {
      expected: { kind: "checkout", unitPrice: 150 },
      input: {
        customUnitPrice: 150,
        paymentsEnabled: true,
        quantity: 2,
        unitPrice: 100,
      },
      name: "opens checkout at the custom price",
    },
    {
      expected: { kind: "direct", remainingBalance: 0 },
      input: {
        customUnitPrice: 0,
        paymentsEnabled: true,
        quantity: 2,
        unitPrice: 100,
      },
      name: "honours an explicit free custom price",
    },
    {
      expected: { kind: "direct", remainingBalance: 200 },
      input: {
        customUnitPrice: undefined,
        paymentsEnabled: false,
        quantity: 2,
        unitPrice: 100,
      },
      name: "records the listing price as owed without a provider",
    },
    {
      expected: { kind: "direct", remainingBalance: 450 },
      input: {
        customUnitPrice: 150,
        paymentsEnabled: false,
        quantity: 3,
        unitPrice: 100,
      },
      name: "records the custom price as owed without a provider",
    },
    {
      expected: { kind: "direct", remainingBalance: 0 },
      input: {
        customUnitPrice: undefined,
        paymentsEnabled: false,
        quantity: 2,
        unitPrice: 0,
      },
      name: "keeps a provider-less free booking at zero balance",
    },
  ] as const;

  for (const testCase of cases) {
    test(testCase.name, () => {
      expect(planBookingPayment(testCase.input)).toEqual(testCase.expected);
    });
  }
});
