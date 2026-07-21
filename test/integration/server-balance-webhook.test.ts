import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { execute } from "#shared/db/client.ts";
import { prunePayments } from "#shared/db/prune.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  createReserved,
  expectSettled,
  stubBalanceSession,
} from "#test/lib/server-balance-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

// Stubs the Stripe refund call to report a refund with the given id.
const stubRefund = (id: string) =>
  stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id, status: "succeeded" } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
  );

describeWithEnv("server (public balance page) > webhook", { db: true }, () => {
  test("an unsigned balance webhook is ignored, leaving the balance outstanding", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    // No price proof: we cannot prove this balance session is ours, so it is
    // ignored — neither settled nor refunded.
    const session = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1500,
        id: "cs_balance_unsigned",
        metadata: {
          balance_attendee_id: String(attendeeId),
          items: JSON.stringify([{ e: 1, p: 1500, q: 1 }]),
          name: "Balance payment",
        },
        payment_intent: "pi_balance",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_balance_unsigned"),
      );
      expect(await response.text()).toContain("not recognized");
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

  test("a pruned balance replay is recovered, not refunded", async () => {
    await setupStripe();
    const attendeeId = await createReserved(1500);
    // First delivery settles the balance and posts its payment leg.
    const first = stubBalanceSession(attendeeId, 1500, "cs_balance_replay");
    try {
      await expectSettled("cs_balance_replay", attendeeId);
    } finally {
      first.restore();
    }

    // Prune the idempotency row; the balance payment leg stays in the ledger.
    await execute(
      "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
      ["2000-01-01T00:00:00.000Z", "cs_balance_replay"],
    );
    await prunePayments();

    // The replay: the balance is already paid (owed 0), so without the ledger
    // preflight settleAttendeeBalance reports nothing_owed and refunds the
    // already-paid customer. The preflight replays success instead.
    const refund = stubRefund("re_x");
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
    const refund = stubRefund("re_bal");
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
    const refund = stubRefund("re_bal");
    const session = stubBalanceSession(attendeeId, 1500, "cs_bal_stale");
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_bal_stale"),
      );
      // The stale payment is refunded, not applied.
      expect(refund.calls[0]!.args).toEqual(["pi_bal_stale"]);
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

  test("refunds when the provider charged a different amount than the checkout", async () => {
    await setupStripe();
    // The checkout was signed for 1500, but the provider reports charging only
    // 1000 — a charge/signed-total mismatch, refunded before any settlement.
    const attendeeId = await createReserved(1500);
    const refund = stubRefund("re_amt");
    const session = stubBalanceSession(attendeeId, 1500, "cs_bal_amt", {
      chargedAmount: 1000,
    });
    try {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_bal_amt"),
      );
      expect(refund.calls[0]!.args).toEqual(["pi_bal_amt"]);
      expect(await response.text()).toContain("price for this listing changed");
      const state = await getAttendeeBalanceState(attendeeId);
      expect(state?.remainingBalance).toBe(1500);
    } finally {
      session.restore();
      refund.restore();
    }
  });
});
