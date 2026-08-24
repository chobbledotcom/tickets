import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ChargeMoney,
  chargeMoneyRead,
  type RefundObservation,
  refundMoneyMatchesCapture,
} from "#payment/resources.ts";
import {
  chargeMoneyWith,
  gbp,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";

describe("what a refund says about the money going back", () => {
  test("keeps completed, pending, and failed refunds on a charge", () => {
    const refunds = [
      { amount: gbp(100), status: "completed" },
      {
        amount: gbp(100),
        refund: refundResource,
        status: "pending",
      },
      {
        amount: gbp(100),
        reason: "declined",
        refund: refundResource,
        status: "failed",
      },
    ] satisfies RefundObservation[];
    const charge = chargeMoneyRead(100, "GBP", 0, refunds);

    expect(charge).toEqual({
      resource: {
        captured: gbp(100),
        confirmedRefunded: gbp(0),
        refunds,
      },
      status: "found",
    });
  });

  // A refund of nothing reads as "no refund seen", so the provider saying one
  // finished would be thrown away and the money could go back twice. A failed
  // refund moved no money, so nothing is the right amount there.
  const noMoney = gbp(0);
  for (const [refund, allowed] of [
    [{ amount: noMoney, status: "completed" }, false],
    [{ amount: noMoney, status: "pending" }, false],
    [{ amount: noMoney, reason: "not_observed", status: "failed" }, true],
  ] as const satisfies readonly (readonly [RefundObservation, boolean])[]) {
    test(`${allowed ? "keeps" : "refuses"} a ${refund.status} refund for no money`, () => {
      expect(chargeMoneyRead(100, "GBP", 0, [refund]).status === "found").toBe(
        allowed,
      );
    });
  }

  test("keeps a pending refund when the provider names no refund of its own", () => {
    const charge = chargeMoneyRead(100, "GBP", 0, [
      { amount: gbp(100), status: "pending" },
    ]);

    expect(charge).toEqual({
      resource: {
        captured: gbp(100),
        confirmedRefunded: gbp(0),
        refunds: [{ amount: gbp(100), status: "pending" }],
      },
      status: "found",
    });
  });

  test("refuses a charge that took no money at all", () => {
    // Nothing was ever taken, so there is no money a refund could be measured
    // against.
    expect(chargeMoneyRead(0, "GBP", 0, [])).toEqual({
      reason: "malformed_money",
      status: "invalid",
    });
  });

  test("names malformed provider money instead of hiding it as no charge", () => {
    expect(chargeMoneyRead("not money", "GBP", 0)).toEqual({
      reason: "malformed_money",
      status: "invalid",
    });
  });

  const secondRefund = { ...refundResource, id: "re_2" };

  /** One £100 charge read many ways. Every refusing case is one where each
   *  figure looks right on its own and only the totals together give it
   *  away — which is the whole point of the rule. */
  const captureCases: readonly [string, ChargeMoney, boolean][] = [
    ["nothing has gone back", chargeMoneyWith(), true],
    [
      "the whole capture is back",
      chargeMoneyWith({ confirmedRefunded: gbp(100) }),
      true,
    ],
    [
      "one finished refund with no total beside it",
      chargeMoneyWith({ refunds: [refundObservation()] }),
      true,
    ],
    [
      "a finished refund already inside the returned total, not counted twice",
      chargeMoneyWith({
        confirmedRefunded: gbp(100),
        refunds: [refundObservation({ amount: gbp(100) })],
      }),
      true,
    ],
    [
      "a returned total in another currency",
      chargeMoneyWith({ confirmedRefunded: { amount: 1, currency: "USD" } }),
      false,
    ],
    [
      "more returned than was ever taken",
      chargeMoneyWith({ confirmedRefunded: gbp(101) }),
      false,
    ],
    [
      "a refund in another currency",
      chargeMoneyWith({
        refunds: [
          refundObservation({ amount: { amount: 100, currency: "USD" } }),
        ],
      }),
      false,
    ],
    [
      "a single refund larger than the capture",
      chargeMoneyWith({ refunds: [refundObservation({ amount: gbp(101) })] }),
      false,
    ],
    [
      "£80 back and £50 still on its way — each fits inside £100, together they do not",
      chargeMoneyWith({
        confirmedRefunded: gbp(80),
        refunds: [refundObservation({ amount: gbp(50), status: "pending" })],
      }),
      false,
    ],
    [
      "two finished £60 refunds against a £100 returned total",
      chargeMoneyWith({
        confirmedRefunded: gbp(100),
        refunds: [
          refundObservation({ amount: gbp(60) }),
          refundObservation({ amount: gbp(60), refund: secondRefund }),
        ],
      }),
      false,
    ],
    [
      "£80 finished and £80 more still going",
      chargeMoneyWith({
        confirmedRefunded: gbp(0),
        refunds: [
          refundObservation({ amount: gbp(80) }),
          refundObservation({
            amount: gbp(80),
            refund: secondRefund,
            status: "pending",
          }),
        ],
      }),
      false,
    ],
  ];

  for (const [name, charge, addsUp] of captureCases) {
    test(`${addsUp ? "accepts" : "refuses"} ${name}`, () => {
      expect(refundMoneyMatchesCapture(charge)).toBe(addsUp);
    });
  }
});
