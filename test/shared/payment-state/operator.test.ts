import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { LegacyProviderAssignmentReadSchema } from "#shared/payment-state/operator.ts";
import { chargeResource, sessionResource } from "#test-utils/payment-state.ts";

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

  // The reviewed reading carries both figures just as the attached one does,
  // so it needs the same rules about them.
  for (const [name, money] of [
    ["returned more than it took", { captured: 100, refunded: 101 }],
    ["took no money at all", { captured: 0, refunded: 0 }],
  ] as const) {
    test(`refuses a checked reading that ${name}`, () => {
      expect(
        v.safeParse(LegacyProviderAssignmentReadSchema, {
          captured: { amount: money.captured, currency: "GBP" },
          refunded: { amount: money.refunded, currency: "GBP" },
          status: "reviewed",
        }).success,
      ).toBe(false);
    });
  }

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
    // A charge row must hold at least a penny, so a reading of nothing is
    // evidence that could never be saved as the charge it describes.
    ["no money taken at all", { captured: { amount: 0, currency: "GBP" } }],
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

  test("accepts a reading that found nothing at the provider", () => {
    expect(
      v.safeParse(LegacyProviderAssignmentReadSchema, { status: "missing" })
        .success,
    ).toBe(true);
  });

  test("accepts a checked reading of money that adds up", () => {
    expect(
      v.safeParse(LegacyProviderAssignmentReadSchema, {
        captured: { amount: 100, currency: "GBP" },
        refunded: { amount: 40, currency: "GBP" },
        status: "reviewed",
      }).success,
    ).toBe(true);
  });

  // These readings are what an owner's choice to give an old payment a
  // provider is written from, and that choice moves real money — so the
  // wording each rule fails with is pinned, not left to say anything at all.
  const MONEY_MUST_FIT =
    "Money returned must fit inside the money taken, in the same currency";

  for (const [name, read, message] of [
    [
      "money taken by another provider",
      {
        ...attachedRead,
        charge: {
          ...chargeResource,
          kind: "square_payment",
          provider: "square",
        },
      },
      "Charge must come from the same provider as the checkout",
    ],
    [
      "money taken through another checkout",
      {
        ...attachedRead,
        charge: { ...chargeResource, parentId: "cs_someone_else" },
      },
      "Charge must belong to the checkout it is attached to",
    ],
    [
      "more money back than was taken",
      { ...attachedRead, refunded: { amount: 101, currency: "GBP" } },
      MONEY_MUST_FIT,
    ],
    [
      "an unclear reading whose figures do not add up",
      {
        captured: { amount: 100, currency: "GBP" },
        refunded: { amount: 200, currency: "GBP" },
        status: "ambiguous",
      },
      MONEY_MUST_FIT,
    ],
  ] as const) {
    test(`says what is wrong with ${name}`, () => {
      const result = v.safeParse(LegacyProviderAssignmentReadSchema, read);

      expect(result.issues?.map((issue) => issue.message)).toContain(message);
    });
  }

  // An unclear reading is allowed to know neither figure, one of them, or
  // both — but when it knows both they still have to add up, because this is
  // what the owner's provider choice gets written down from.
  for (const [name, read, allowed] of [
    ["knows neither figure", {}, true],
    [
      "knows only what was taken",
      { captured: { amount: 100, currency: "GBP" } },
      true,
    ],
    [
      "knows both, and they add up",
      {
        captured: { amount: 100, currency: "GBP" },
        refunded: { amount: 40, currency: "GBP" },
      },
      true,
    ],
    [
      "gave back more than it took",
      {
        captured: { amount: 100, currency: "GBP" },
        refunded: { amount: 200, currency: "GBP" },
      },
      false,
    ],
    [
      "gave back another kind of money",
      {
        captured: { amount: 100, currency: "GBP" },
        refunded: { amount: 40, currency: "USD" },
      },
      false,
    ],
  ] as const) {
    test(`${allowed ? "accepts" : "refuses"} an unclear reading that ${name}`, () => {
      expect(
        v.safeParse(LegacyProviderAssignmentReadSchema, {
          ...read,
          status: "ambiguous",
        }).success,
      ).toBe(allowed);
    });
  }
});
