import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  providerRefundResources,
  RefundFailureReasonSchema,
  RefundObservationSchema,
  RefundResolutionSchema,
  refundMoneyMatchesCapture,
} from "#shared/payment/resources.ts";
import {
  chargeLeg,
  refundObservation,
  refundResource,
  validationMessage,
} from "#test-utils/payment-state.ts";

describe("what a refund says about the money going back", () => {
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

  test("counts money already back and money still going as one total", () => {
    // £80 has gone and £80 more is on its way, out of £100 taken. Each half
    // fits on its own, so checked apart this reads as a refund quietly in
    // progress rather than a reading that cannot be true.
    expect(
      refundMoneyMatchesCapture(
        chargeLeg({
          confirmedRefunded: { amount: 0, currency: "GBP" },
          refunds: [
            refundObservation({ amount: { amount: 80, currency: "GBP" } }),
            refundObservation({
              amount: { amount: 80, currency: "GBP" },
              refund: { ...refundResource, id: "re_2" },
              status: "pending",
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
});
