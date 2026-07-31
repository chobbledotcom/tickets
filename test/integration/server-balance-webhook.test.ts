import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { getOpenPaymentCases } from "#shared/db/payments/cases.ts";
import {
  createReserved,
  expectSettled,
  stubBalanceSession,
} from "#test/integration/balance-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  expectRefundPaymentCall,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";

// Stand in for the Stripe refund call, reporting a refund of `amount` that
// belongs to whichever charge was asked about.
const stubRefund = (id: string, amount: number) =>
  stubRefundPayment(id, amount);

describeWithEnv("server (public balance page) > webhook", { db: true }, () => {
  test("an unsigned balance webhook is ignored, leaving the balance outstanding", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    // No price proof: we cannot prove this balance session is ours, so it is
    // ignored — neither settled nor refunded.
    const session = stubRetrieveCheckoutSession({
      amountTotal: 1500,
      metadata: {
        balance_attendee_id: String(attendeeId),
        items: JSON.stringify([{ e: 1, p: 1500, q: 1 }]),
        name: "Balance payment",
      },
      paymentIntent: "pi_balance",
      sessionId: "cs_balance_unsigned",
    });
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_unsigned"),
      );
      expect(await response.text()).toContain(
        t("payment.error.session_not_recognized"),
      );
      // The balance is untouched — nothing was settled.
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(1500);
    } finally {
      session.restore();
    }
  });

  test("the webhook settles a signed balance checkout", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const session = stubBalanceSession(attendeeId, 1500, "cs_balance_signed");
    try {
      await expectSettled("cs_balance_signed", attendeeId);
    } finally {
      session.restore();
    }
  });

  test("a completed balance payment replays without another refund", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    // First delivery settles the balance and posts its payment leg.
    const first = stubBalanceSession(attendeeId, 1500, "cs_balance_replay");
    try {
      await expectSettled("cs_balance_replay", attendeeId);
    } finally {
      first.restore();
    }

    const refund = stubRefund("re_x", 1500);
    const second = stubBalanceSession(attendeeId, 1500, "cs_balance_replay");
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_replay"),
      );
      expect(response.status).toBe(200);
      expect(refund.calls.length).toBe(0);
      // Balance stays cleared; nothing re-settled or refunded.
      expect(
        (await getAttendeeBalanceState(attendeeId))?.remainingBalance,
      ).toBe(0);
    } finally {
      second.restore();
      refund.restore();
    }
  });

  test("posts a balance payment leg once the booking is in the ledger", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    // createReserved already dual-wrote the booking, leaving the attendee owing
    // 1500 in the ledger (a 1600 sale funded by a 100 deposit).
    expect(await accountBalance(attendeeAccount(attendeeId))).toBe(-1500);
    // Stripe stamps `created` (Unix seconds) when the checkout is made; the
    // balance-payment leg should be dated from it, not from processing time.
    const created = Math.floor(Date.parse("2026-06-20T09:00:00.000Z") / 1000);
    const session = stubBalanceSession(attendeeId, 1500, "cs_balance_ledger", {
      over: { created },
    });
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_ledger"),
      );
      expect(response.status).toBe(200);
      expect(
        (await getAttendeeBalanceState(attendeeId))?.remainingBalance,
      ).toBe(0);
      // The balance payment leg cleared the ledger balance too.
      expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
      // …and it carries the checkout's business time, not the processing clock.
      const legs = await transfersByAccount(attendeeAccount(attendeeId));
      const balancePayment = legs.find(
        (leg) => leg.kind === "payment" && leg.amount === 1500,
      );
      expect(balancePayment?.occurredAt).toBe(
        new Date(created * 1000).toISOString(),
      );
    } finally {
      session.restore();
    }
  });

  test("a balance checkout with a tampered signature is ignored, not settled", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const refund = stubRefund("re_bal", 1500);
    // Valid total, wrong digest — an invalid proof, so the session is ignored:
    // not settled, and not refunded (we can't prove it is ours).
    const session = stubBalanceSession(
      attendeeId,
      1500,
      "cs_balance_tampered",
      {
        meta: { price_proof: `1500.${"A".repeat(44)}` },
      },
    );
    try {
      await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_tampered"),
      );
      // Ignored: the balance is left outstanding and no refund was issued.
      expect(refund.calls.length).toBe(0);
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(1500);
    } finally {
      session.restore();
      refund.restore();
    }
  });

  test("settles the balance even when the booking's listing has since been deleted", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    const session = stubBalanceSession(attendeeId, 1500, "cs_bal_nolisting", {
      eventId: 98765,
    });
    try {
      // The balance settlement is the operation that matters; a missing listing
      // only means no thank-you URL, so the session still finalizes (no stuck
      // unfinalized reservation after the customer has paid).
      await expectSettled("cs_bal_nolisting", attendeeId);
    } finally {
      session.restore();
    }
  });

  test("refunds and does not settle when the balance changed after checkout", async () => {
    await setupStripe();
    // The customer's checkout was created for 1500, but the owner has since
    // lowered the live balance to 500. The stale 1500 callback must refund and
    // leave the balance untouched rather than clear the wrong amount.
    const attendeeId = await createReserved(500);
    const refund = stubRefund("re_bal", 1500);
    const session = stubBalanceSession(attendeeId, 1500, "cs_bal_stale");
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_bal_stale"),
      );
      // The stale payment is refunded, not applied.
      expectRefundPaymentCall(refund, "pi_bal_stale");
      const html = await response.text();
      expect(html).toContain("balance for this booking changed");
      // The live balance is untouched — still outstanding.
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(500);
    } finally {
      session.restore();
      refund.restore();
    }
  });

  test("raises a case when the provider charged a different amount", async () => {
    await setupStripe();
    // The checkout was signed for 1500, but the provider reports charging only
    // 1000. The site cannot tell on its own which figure is right, so it puts
    // the payment in front of the owner instead of moving money by guesswork.
    const attendeeId = await createReserved(1500);
    const refund = stubRefund("re_amt", 1000);
    const session = stubBalanceSession(attendeeId, 1500, "cs_bal_amt", {
      chargedAmount: 1000,
    });
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_bal_amt"),
      );
      expect(response.status).toBe(409);
      // No money moved on its own.
      expect(refund.calls.length).toBe(0);
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(1500);
      // The owner has something to decide.
      expect(await getOpenPaymentCases()).toHaveLength(1);
    } finally {
      session.restore();
      refund.restore();
    }
  });
});
