import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundObservation } from "#shared/payment/resources.ts";
import {
  chargeMoneyOrNull,
  refundMoneyMatchesCapture,
} from "#shared/payment/resources.ts";
import {
  chargeMoneyWith,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";

describe("what a refund says about the money going back", () => {
  test("keeps completed, pending, and failed refunds on a charge", () => {
    const charge = chargeMoneyOrNull(100, "GBP", 0, [
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
    ]);

    expect(charge?.refunds.map((refund) => refund.status)).toEqual([
      "completed",
      "pending",
      "failed",
    ]);
  });

  // A refund of nothing reads as "no refund seen", so the provider saying one
  // finished would be thrown away and the money could go back twice. A failed
  // refund moved no money, so nothing is the right amount there.
  const noMoney = { amount: 0, currency: "GBP" } as const;
  for (const [refund, allowed] of [
    [{ amount: noMoney, status: "completed" }, false],
    [{ amount: noMoney, status: "pending" }, false],
    [{ amount: noMoney, reason: "not_observed", status: "failed" }, true],
  ] as const satisfies readonly (readonly [RefundObservation, boolean])[]) {
    test(`${allowed ? "keeps" : "refuses"} a ${refund.status} refund for no money`, () => {
      expect(chargeMoneyOrNull(100, "GBP", 0, [refund]) !== null).toBe(allowed);
    });
  }

  test("keeps a pending refund when the provider names no refund of its own", () => {
    const charge = chargeMoneyOrNull(100, "GBP", 0, [
      { amount: { amount: 100, currency: "GBP" }, status: "pending" },
    ]);

    expect(charge?.refunds).toEqual([
      { amount: { amount: 100, currency: "GBP" }, status: "pending" },
    ]);
  });

  test("refuses a charge that took no money at all", () => {
    // Nothing was ever taken, so there is no money a refund could be measured
    // against.
    expect(chargeMoneyOrNull(0, "GBP", 0, [])).toBe(null);
  });

  test("counts a refund still going on top of the money already returned", () => {
    // A refund the provider has not finished is money on its way out, on top
    // of what has already gone back. Checked one at a time, £80 returned and
    // £50 on its way both fit inside £100 — together they do not.
    expect(
      refundMoneyMatchesCapture(
        chargeMoneyWith({
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
        chargeMoneyWith({
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
        chargeMoneyWith({
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
        chargeMoneyWith({
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
    expect(refundMoneyMatchesCapture(chargeMoneyWith())).toBe(true);
    expect(
      refundMoneyMatchesCapture(
        chargeMoneyWith({
          confirmedRefunded: { amount: 100, currency: "GBP" },
        }),
      ),
    ).toBe(true);
    expect(
      refundMoneyMatchesCapture(
        chargeMoneyWith({ refunds: [refundObservation()] }),
      ),
    ).toBe(true);
    expect(
      refundMoneyMatchesCapture(
        chargeMoneyWith({ confirmedRefunded: { amount: 1, currency: "USD" } }),
      ),
    ).toBe(false);
    expect(
      refundMoneyMatchesCapture(
        chargeMoneyWith({
          confirmedRefunded: { amount: 101, currency: "GBP" },
        }),
      ),
    ).toBe(false);
    expect(
      refundMoneyMatchesCapture(
        chargeMoneyWith({
          refunds: [
            refundObservation({ amount: { amount: 100, currency: "USD" } }),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      refundMoneyMatchesCapture(
        chargeMoneyWith({
          refunds: [
            refundObservation({ amount: { amount: 101, currency: "GBP" } }),
          ],
        }),
      ),
    ).toBe(false);
  });
});
