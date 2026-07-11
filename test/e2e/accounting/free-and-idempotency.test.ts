import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { settings } from "#shared/db/settings.ts";
import { expectFlashRedirect, expectRedirect } from "#test-utils/assertions.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  completePaidOrder,
  describeAccounting,
  submitRefund,
  withRefundMock,
  withStripeSuccess,
} from "./drivers.ts";
import {
  adminPageHtml,
  incomeLedgerArticle,
  incomeOf,
  kindsOf,
  legsOfKind,
  owedBy,
  signedCurrency,
  sumOfAllBalances,
  worldBalance,
} from "./ledger-helpers.ts";

describeAccounting(() => {
  test("a free booking records no money even with a booking fee configured", async () => {
    await settings.update.bookingFee("10");
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Free Meetup",
      unitPrice: 0,
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Free Guest",
      "free@example.com",
    );

    // Nothing owed, and the booking posted no ledger legs whatsoever.
    expect(await owedBy(attendee.id)).toBe(0);
    expect(
      (await transfersByAccount(attendeeAccount(attendee.id))).length,
    ).toBe(0);
    expect(await incomeOf(listing.id)).toBe(0);
    // No phantom booking-fee income, and no phantom cash moved through the world.
    expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(0);
    expect(await worldBalance()).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);
  });

  // 12. When the payment provider DECLINES the refund, nothing is reversed: the
  //     income and owed figures are unchanged and no refund legs are posted.
  test("a failed provider refund reverses nothing in the ledger", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Show",
      unitPrice: 4500,
    });
    const attendeeId = await completePaidOrder(
      listing.id,
      "No Refund",
      "norefund@example.com",
      4500,
      "cs_fail",
      "pi_fail",
    );
    expect(await incomeOf(listing.id)).toBe(4500);

    await withRefundMock(false, async (mockRefund) => {
      const response = await submitRefund(attendeeId, "No Refund");
      // The route surfaces the failure as a flash error and does NOT issue it.
      await expectFlashRedirect(
        `/admin/attendees/${attendeeId}/refund`,
        expect.stringContaining("Refund failed"),
        false,
      )(response);
      expect(mockRefund.calls.length).toBe(1);
    });

    // The ledger is exactly as it was: full income, nothing owed back, no refund.
    expect(await incomeOf(listing.id)).toBe(4500);
    expect(await owedBy(attendeeId)).toBe(0);
    const legs = await transfersByAccount(attendeeAccount(attendeeId));
    expect(legsOfKind(legs, "refund_cash").length).toBe(0);
    expect(kindsOf(legs)).toEqual(["payment", "sale"]);
    expect(await sumOfAllBalances()).toBe(0);
  });

  // 13. Corrections and webhook deliveries are idempotent. Replaying the identical
  //     Stripe success creates no second booking or duplicate legs, and
  //     re-submitting the same income target posts no second adjustment.
  test("re-submitting a correction and replaying a success are both no-ops", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Repeat",
      unitPrice: 6000,
    });
    const attendeeId = await completePaidOrder(
      listing.id,
      "Repeat Buyer",
      "repeat@example.com",
      6000,
      "cs_repeat",
      "pi_repeat",
    );

    // Replaying the identical success must not create a second attendee or
    // duplicate the booking's legs — an already-processed session is a no-op,
    // so the route just re-renders (a 200) rather than redirecting afresh.
    await withStripeSuccess(
      {
        email: "repeat@example.com",
        items: singleItem(listing.id, 1, 6000),
        name: "Repeat Buyer",
        paymentIntent: "pi_repeat",
        sessionId: "cs_repeat",
        total: 6000,
      },
      async (replay) => {
        await replay.body?.cancel();
      },
    );
    expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    expect(
      kindsOf(await transfersByAccount(attendeeAccount(attendeeId))),
    ).toEqual(["payment", "sale"]);

    // Adjust income to £40, then submit the SAME target again — the second submit
    // computes a zero delta and posts no second adjustment.
    const adjustIncome = async (): Promise<Response> =>
      (
        await adminFormPost(`/admin/listing/${listing.id}/income`, {
          income: "40.00",
        })
      ).response;
    const expectAdjusted = expectFlashRedirect(
      `/admin/listing/${listing.id}/edit`,
      "Listing income adjusted",
    );
    await expectAdjusted(await adjustIncome());
    await expectAdjusted(await adjustIncome());

    expect(await incomeOf(listing.id)).toBe(4000);
    const adjustments = legsOfKind(
      await transfersByAccount(revenueAccount(listing.id)),
      "adjustment",
    );
    expect(adjustments.length).toBe(1);
  });

  // 14. The listing detail page renders the "Income & ledger" reconciliation that
  //     EXPLAINS the two income figures: gross sales (+) and manual adjustments
  //     (±) make up recognised income, and refunds (−) take it down to the net
  //     ledger balance — so the two never silently disagree (transparency).
  test("the listing page renders an income/ledger breakdown reconciling the figures", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Reconciled",
      unitPrice: 5000,
    });
    const attendeeId = await completePaidOrder(
      listing.id,
      "Recon Buyer",
      "recon@example.com",
      5000,
      "cs_recon",
      "pi_recon",
    );
    // Write recognised income down £50 → £40 (a manual adjustment), then refund
    // the booking (which nets the ledger balance but not recognised income) so
    // all five reconciliation rows carry distinct, non-zero figures.
    await expectFlashRedirect(
      `/admin/listing/${listing.id}/edit`,
      "Listing income adjusted",
    )(
      (
        await adminFormPost(`/admin/listing/${listing.id}/income`, {
          income: "40.00",
        })
      ).response,
    );
    await withRefundMock(true, async (mockRefund) => {
      const refund = await submitRefund(attendeeId, "Recon Buyer");
      expectRedirect(refund, /\/admin\/attendees\/\d+\/actions/);
      expect(mockRefund.calls.length).toBe(1);
    });

    const article = incomeLedgerArticle(
      await adminPageHtml(`/admin/listing/${listing.id}`),
    );
    // Every reconciliation row is labelled and signed, so the difference between
    // the two income figures is self-evident on the page.
    expect(article).toContain("Money in and out");
    expect(article).toContain("Gross ticket sales");
    expect(article).toContain(signedCurrency(5000)); // +£50 gross sales
    expect(article).toContain("Manual adjustments");
    expect(article).toContain(signedCurrency(-1000)); // −£10 write-down
    expect(article).toContain("Total income earned");
    expect(article).toContain(formatCurrency(4000)); // £40 recognised
    expect(article).toContain("Refunds");
    expect(article).toContain(signedCurrency(-5000)); // −£50 refunded
    expect(article).toContain("Net after refunds and costs");
    expect(article).toContain(signedCurrency(-1000)); // −£10 net
    // And it links through to the listing-scoped ledger view.
    expect(article).toContain(`/admin/ledger?listing=${listing.id}`);
  });

  // 15. A bulk refund is resilient: when the provider declines ONE payment, the
  //     others are still refunded and recorded, the declined one is left intact,
  //     and conservation holds across the partial batch.
});
