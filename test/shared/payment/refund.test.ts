import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resolveRefund } from "#payment/refund.ts";
import type { ChargeMoney, RefundResolution } from "#payment/resources.ts";
import {
  chargeMoneyWith,
  gbp,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";

const usd = (amount: number) => ({ amount, currency: "USD" });
const secondRefund = { ...refundResource, id: "re_2" };
const stillGoing = (amount: number, refund = refundResource) =>
  refundObservation({ amount: gbp(amount), refund, status: "pending" });

/** Every reading of one £100 charge, and what the resolver makes of it. */
const readings: readonly [string, ChargeMoney, RefundResolution][] = [
  // Money that cannot be true of this charge is refused before anything else
  // is read off it, so a bad figure never reaches the money rules.
  ...(
    [
      [
        "more back than was taken",
        chargeMoneyWith({ confirmedRefunded: gbp(101) }),
        gbp(101),
      ],
      [
        "a returned total in another currency",
        chargeMoneyWith({ confirmedRefunded: usd(1) }),
        usd(1),
      ],
      [
        "a refund larger than the charge",
        chargeMoneyWith({ refunds: [refundObservation({ amount: gbp(101) })] }),
        gbp(0),
      ],
      [
        "a refund in another currency",
        chargeMoneyWith({ refunds: [refundObservation({ amount: usd(100) })] }),
        gbp(0),
      ],
    ] as const
  ).map(([name, charge, amount]): [string, ChargeMoney, RefundResolution] => [
    name,
    charge,
    { amount, reason: "invalid_amount", status: "failed" },
  ]),
  [
    // Amounts that fit inside the money taken, so this reaches the rule about
    // two refunds at once rather than the one about the money not adding up.
    "two refunds in flight at once",
    chargeMoneyWith({
      refunds: [stillGoing(10), stillGoing(10, secondRefund)],
    }),
    { amount: gbp(0), reason: "multiple_pending_refunds", status: "failed" },
  ],
  [
    "a refund on its way, named",
    chargeMoneyWith({ refunds: [refundObservation({ status: "pending" })] }),
    { amount: gbp(100), refund: refundResource, status: "pending" },
  ],
  [
    // SumUp says a refund is on its way before it says what it is called.
    "a refund on its way the provider has not named yet",
    chargeMoneyWith({ refunds: [{ amount: gbp(100), status: "pending" }] }),
    { amount: gbp(100), status: "pending" },
  ],
  [
    "the whole charge back, with the refund named",
    chargeMoneyWith({
      confirmedRefunded: gbp(100),
      refunds: [refundObservation()],
    }),
    { amount: gbp(100), refund: refundResource, status: "completed" },
  ],
  [
    "the whole charge back, with no refund named",
    chargeMoneyWith({ confirmedRefunded: gbp(100) }),
    { amount: gbp(100), status: "completed" },
  ],
  [
    // The provider says the refund finished; its running total still reads
    // zero. Reading that as "no refund seen" would call the charge refundable
    // and let a second refund go out — with no idempotency key on SumUp, that
    // is the buyer's money sent back twice.
    "a finished refund the cumulative total has not caught up with",
    chargeMoneyWith({
      confirmedRefunded: gbp(0),
      refunds: [refundObservation()],
    }),
    { amount: gbp(100), refund: refundResource, status: "completed" },
  ],
  [
    "part of the charge back, with the refund named",
    chargeMoneyWith({
      confirmedRefunded: gbp(40),
      refunds: [refundObservation({ amount: gbp(40) })],
    }),
    { amount: gbp(40), refund: refundResource, status: "partial" },
  ],
  [
    "part of the charge back, with no refund named",
    chargeMoneyWith({ confirmedRefunded: gbp(40) }),
    { amount: gbp(40), status: "partial" },
  ],
  [
    "a single penny back",
    chargeMoneyWith({ confirmedRefunded: gbp(1) }),
    { amount: gbp(1), status: "partial" },
  ],
  [
    "a refund the provider turned down",
    chargeMoneyWith({
      refunds: [refundObservation({ reason: "rejected", status: "failed" })],
    }),
    {
      amount: gbp(0),
      reason: "provider_failed",
      refund: refundResource,
      status: "failed",
    },
  ],
  [
    // A failure hidden behind "partly refunded" is a failure nobody retries.
    "a refund the provider could not finish, over money already back",
    chargeMoneyWith({
      confirmedRefunded: gbp(40),
      refunds: [
        refundObservation({ amount: gbp(40) }),
        refundObservation({
          amount: gbp(30),
          reason: "provider_failed",
          refund: secondRefund,
          status: "failed",
        }),
      ],
    }),
    {
      amount: gbp(40),
      reason: "provider_failed",
      refund: secondRefund,
      status: "failed",
    },
  ],
  [
    "nothing said about a refund at all",
    chargeMoneyWith(),
    { amount: gbp(0), reason: "not_observed", status: "failed" },
  ],
];

describe("refund resolver", () => {
  for (const [name, charge, resolution] of readings) {
    test(`resolves ${name}`, () => {
      expect(resolveRefund(charge)).toStrictEqual(resolution);
    });
  }
});
