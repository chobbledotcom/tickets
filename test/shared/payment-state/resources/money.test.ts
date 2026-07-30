import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  ChargeLegSchema,
  ChargeLegsSchema,
  MoneySchema,
  ProviderChargeResourceSchema,
  ProviderRefundResourceSchema,
  ProviderResourceSchema,
  ProviderSessionResourceSchema,
  sameProviderResource,
} from "#shared/payment-state/resources.ts";
import {
  chargeLeg,
  chargeResource,
  refundResource,
  sessionResource,
  validationMessage,
} from "../fixtures.ts";

describe("the money and the things a provider names", () => {
  test("accepts safe minor amounts and uppercase currencies", () => {
    for (const amount of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(v.parse(MoneySchema, { amount, currency: "GBP" })).toEqual({
        amount,
        currency: "GBP",
      });
    }
  });

  for (const [name, money] of [
    ["negative amount", { amount: -1, currency: "GBP" }],
    ["fractional amount", { amount: 1.5, currency: "GBP" }],
    [
      "unsafe amount",
      {
        amount: Number.MAX_SAFE_INTEGER + 1,
        currency: "GBP",
      },
    ],
    ["lowercase currency", { amount: 1, currency: "gbp" }],
    ["long currency", { amount: 1, currency: "GBPX" }],
  ] as const) {
    test(`rejects a ${name}`, () => {
      expect(v.safeParse(MoneySchema, money).success).toBe(false);
    });
  }

  test("keeps every provider session resource distinct", () => {
    const resources = [
      sessionResource,
      {
        id: "order_1",
        kind: "square_order",
        provider: "square",
      },
      {
        id: "checkout_1",
        kind: "sumup_checkout",
        provider: "sumup",
      },
    ] as const;

    expect(
      resources.map(
        (resource) => v.parse(ProviderSessionResourceSchema, resource).kind,
      ),
    ).toEqual(["stripe_checkout_session", "square_order", "sumup_checkout"]);
    expect(
      v.safeParse(ProviderSessionResourceSchema, {
        ...sessionResource,
        chargeParentId: "pi_later",
      }).success,
    ).toBe(false);
  });

  test("validates charge and refund resources with their parent ids", () => {
    const charges = [
      chargeResource,
      {
        id: "payment_1",
        kind: "square_payment",
        parentId: "order_1",
        provider: "square",
      },
      {
        id: "transaction_1",
        kind: "sumup_transaction",
        parentId: "checkout_1",
        provider: "sumup",
      },
    ] as const;
    const refunds = [
      refundResource,
      {
        id: "refund_1",
        kind: "square_refund",
        parentId: "payment_1",
        provider: "square",
      },
      {
        id: "refund_2",
        kind: "sumup_refund",
        parentId: "transaction_1",
        provider: "sumup",
      },
    ] as const;
    expect(
      charges.map(
        (resource) => v.parse(ProviderChargeResourceSchema, resource).kind,
      ),
    ).toEqual(["stripe_payment_intent", "square_payment", "sumup_transaction"]);
    expect(
      refunds.map(
        (resource) => v.parse(ProviderRefundResourceSchema, resource).kind,
      ),
    ).toEqual(["stripe_refund", "square_refund", "sumup_refund"]);
    expect(v.parse(ProviderResourceSchema, refundResource).kind).toBe(
      "stripe_refund",
    );
    expect(
      v.safeParse(ProviderChargeResourceSchema, {
        id: "pi_2",
        kind: "stripe_payment_intent",
        provider: "stripe",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ProviderRefundResourceSchema, {
        id: "re_2",
        kind: "stripe_refund",
        provider: "stripe",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ProviderRefundResourceSchema, {
        ...refundResource,
        chargeParentId: "cs_1",
      }).success,
    ).toBe(false);
  });

  test("rejects empty and whitespace-only resource ids", () => {
    for (const id of ["", "   "]) {
      expect(
        v.safeParse(ProviderChargeResourceSchema, {
          ...chargeResource,
          id,
        }).success,
      ).toBe(false);
    }
    expect(
      validationMessage(ProviderChargeResourceSchema, {
        ...chargeResource,
        id: "   ",
      }),
    ).toBe("Resource id must contain text");
  });

  test("uses provider, kind, and id as stable resource identity", () => {
    expect(sameProviderResource(sessionResource, sessionResource)).toBe(true);
    expect(
      sameProviderResource(sessionResource, { ...sessionResource, id: "cs_2" }),
    ).toBe(false);
    expect(sameProviderResource(chargeResource, chargeResource)).toBe(true);
    expect(
      sameProviderResource(chargeResource, {
        ...chargeResource,
        parentId: "cs_2",
      }),
    ).toBe(true);
    expect(sameProviderResource(refundResource, refundResource)).toBe(true);
    expect(
      sameProviderResource(refundResource, {
        ...refundResource,
        parentId: "pi_2",
      }),
    ).toBe(true);
    expect(
      sameProviderResource(chargeResource, {
        id: "pi_1",
        kind: "square_payment",
        parentId: "order_1",
        provider: "square",
      }),
    ).toBe(false);
  });

  test("requires paid charge amounts to be positive", () => {
    expect(v.parse(ChargeLegSchema, chargeLeg()).captured.amount).toBe(100);
    expect(
      v.parse(ChargeLegSchema, {
        ...chargeLeg(),
        captured: { amount: 1, currency: "GBP" },
      }).captured.amount,
    ).toBe(1);
    expect(
      validationMessage(ChargeLegSchema, {
        ...chargeLeg(),
        captured: { amount: 0, currency: "GBP" },
      }),
    ).toBe("A paid charge must be positive");
  });

  test("models one or many charges through one non-empty array", () => {
    expect(v.parse(ChargeLegsSchema, [chargeLeg()])).toHaveLength(1);
    expect(v.parse(ChargeLegsSchema, [chargeLeg(), chargeLeg()])).toHaveLength(
      2,
    );
    expect(v.safeParse(ChargeLegsSchema, []).success).toBe(false);
  });

  test("keeps currency validation messages specific", () => {
    expect(validationMessage(MoneySchema, { amount: 1, currency: "gbp" })).toBe(
      "Currency must be three uppercase letters",
    );
    expect(() =>
      validationMessage(MoneySchema, { amount: 1, currency: "GBP" }),
    ).toThrow("Expected validation to fail");
  });
});
