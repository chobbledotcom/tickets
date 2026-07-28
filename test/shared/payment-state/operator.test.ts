import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { LegacyProviderAssignmentReadSchema } from "#shared/payment-state/operator.ts";
import { chargeResource, sessionResource } from "./fixtures.ts";

/** A reading that says which money an old payment turned out to be. Every part
 *  of it agrees with every other, which is what the tests below break one at a
 *  time. */
const attachedRead = {
  captured: { amount: 100, currency: "GBP" },
  charge: chargeResource,
  refunded: { amount: 0, currency: "GBP" },
  session: sessionResource,
  status: "attached",
};

describe("payment operator readings", () => {
  test("accepts a reading whose parts agree", () => {
    expect(
      v.safeParse(LegacyProviderAssignmentReadSchema, attachedRead).success,
    ).toBe(true);
  });

  for (const [name, broken] of [
    [
      "money taken by another provider",
      {
        charge: {
          ...chargeResource,
          kind: "square_payment",
          provider: "square",
        },
      },
    ],
    [
      "money taken through another checkout",
      { charge: { ...chargeResource, parentId: "cs_someone_else" } },
    ],
    [
      "money returned in another currency",
      { refunded: { amount: 0, currency: "USD" } },
    ],
    [
      "more money returned than was taken",
      { refunded: { amount: 101, currency: "GBP" } },
    ],
  ] as const) {
    test(`refuses a reading with ${name}`, () => {
      expect(
        v.safeParse(LegacyProviderAssignmentReadSchema, {
          ...attachedRead,
          ...broken,
        }).success,
      ).toBe(false);
    });
  }
});
