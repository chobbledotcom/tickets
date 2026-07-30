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
  providerRefundResources,
  RefundFailureReasonSchema,
  RefundObservationSchema,
  RefundResolutionSchema,
  refundMoneyMatchesCapture,
  sameProviderResource,
} from "#shared/payment-state/resources.ts";
import {
  chargeLeg,
  chargeResource,
  refundObservation,
  refundResource,
  sessionResource,
  validationMessage,
} from "./fixtures.ts";

describe("payment resources", () => {
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

  test("validates completed, pending, and failed refund observations", () => {
    const observations = [
      { amount: { amount: 100, currency: "GBP" }, status: "completed" },
      {
        amount: { amount: 100, currency: "GBP" },
        refund: refundResource,
        status: "pending",
      },
      {
        amount: { amount: 100, currency: "GBP" },
        reason: "declined",
        refund: refundResource,
        status: "failed",
      },
    ] as const;
    expect(
      observations.map((item) => v.parse(RefundObservationSchema, item).status),
    ).toEqual(["completed", "pending", "failed"]);
  });

  // A refund of nothing reads as "no refund seen", so the provider saying one
  // finished would be thrown away and the money could go back twice. A failed
  // refund moved no money, so nothing is the right amount there.
  for (const [status, allowed] of [
    ["completed", false],
    ["partial", false],
    ["failed", true],
  ] as const) {
    test(`${allowed ? "allows" : "refuses"} a ${status} refund for no money`, () => {
      expect(
        v.safeParse(RefundResolutionSchema, {
          amount: { amount: 0, currency: "GBP" },
          ...(status === "failed" ? { reason: "not_observed" } : {}),
          status,
        }).success,
      ).toBe(allowed);
    });
  }

  test("allows a pending refund when the provider exposes no refund resource", () => {
    expect(
      v.safeParse(RefundObservationSchema, {
        amount: { amount: 100, currency: "GBP" },
        status: "pending",
      }).success,
    ).toBe(true);
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

  test("collects only refund observations with provider ids", () => {
    const withoutId = {
      amount: { amount: 20, currency: "GBP" },
      status: "completed",
    } as const;
    expect(providerRefundResources([])).toEqual([]);
    expect(
      providerRefundResources([
        chargeLeg({ refunds: [withoutId, refundObservation()] }),
      ]),
    ).toEqual([refundResource]);
  });

  test("refuses a refund still going that is for no money", () => {
    // A refund of nothing is answered before the money already returned is
    // looked at, so a charge fully given back would read as still going and
    // never settle.
    expect(
      v.safeParse(RefundObservationSchema, {
        amount: { amount: 0, currency: "GBP" },
        refund: refundResource,
        status: "pending",
      }).success,
    ).toBe(false);
  });

  test("says why a refund that moved money may not be for nothing", () => {
    // The wording matters here: this is the rule that keeps a charge given
    // fully back from reading as still going, for ever.
    expect(
      validationMessage(RefundObservationSchema, {
        amount: { amount: 0, currency: "GBP" },
        refund: refundResource,
        status: "pending",
      }),
    ).toBe("A refund that moved money must be positive");
  });

  test("counts a refund still going on top of the money already returned", () => {
    // A refund the provider has not finished is money on its way out, on top
    // of what has already gone back. Checked one at a time, £80 returned and
    // £50 on its way both fit inside £100 — together they do not.
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({
          confirmedRefunded: { amount: 80, currency: "GBP" },
          refunds: [
            refundObservation({
              amount: { amount: 50, currency: "GBP" },
              status: "pending",
            }),
          ],
        }),
      ),
    ).toBe(false);
  });

  test("does not count a finished refund twice", () => {
    // A refund the provider has finished is already inside the returned
    // total, so it must not be added again.
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({
          confirmedRefunded: { amount: 100, currency: "GBP" },
          refunds: [
            refundObservation({ amount: { amount: 100, currency: "GBP" } }),
          ],
        }),
      ),
    ).toBe(true);
  });

  test("refuses finished refunds that together come to more than was taken", () => {
    // Each £60 refund fits inside £100 on its own, and the returned total says
    // £100, so every figure looks right one at a time. Together the provider
    // is claiming £120 went back out of £100 — the two readings cannot both be
    // true of one charge, so the reading is wrong rather than settled.
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({
          confirmedRefunded: { amount: 100, currency: "GBP" },
          refunds: [
            refundObservation({ amount: { amount: 60, currency: "GBP" } }),
            refundObservation({
              amount: { amount: 60, currency: "GBP" },
              refund: { ...refundResource, id: "re_2" },
            }),
          ],
        }),
      ),
    ).toBe(false);
  });

  test("checks every refund amount and currency against its capture", () => {
    expect(refundMoneyMatchesCapture(chargeLeg())).toBe(true);
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({ confirmedRefunded: { amount: 100, currency: "GBP" } }),
      ),
    ).toBe(true);
    expect(
      refundMoneyMatchesCapture(chargeLeg({ refunds: [refundObservation()] })),
    ).toBe(true);
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({ confirmedRefunded: { amount: 1, currency: "USD" } }),
      ),
    ).toBe(false);
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({ confirmedRefunded: { amount: 101, currency: "GBP" } }),
      ),
    ).toBe(false);
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({
          refunds: [
            refundObservation({ amount: { amount: 100, currency: "USD" } }),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({
          refunds: [
            refundObservation({ amount: { amount: 101, currency: "GBP" } }),
          ],
        }),
      ),
    ).toBe(false);
  });

  test("defines every refund failure and resolution", () => {
    for (const reason of [
      "provider_failed",
      "invalid_amount",
      "multiple_pending_refunds",
      "not_observed",
    ] as const) {
      expect(v.parse(RefundFailureReasonSchema, reason)).toBe(reason);
    }
    expect(v.safeParse(RefundFailureReasonSchema, "declined").success).toBe(
      false,
    );
    const money = { amount: 100, currency: "GBP" } as const;
    const resolutions = [
      { amount: money, status: "completed" },
      { amount: money, refund: refundResource, status: "pending" },
      { amount: money, status: "partial" },
      { amount: money, reason: "provider_failed", status: "failed" },
    ] as const;
    expect(
      resolutions.map((item) => v.parse(RefundResolutionSchema, item).status),
    ).toEqual(["completed", "pending", "partial", "failed"]);
    expect(
      v.safeParse(RefundResolutionSchema, {
        amount: money,
        status: "pending",
      }).success,
    ).toBe(true);
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
