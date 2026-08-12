import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectSessionFailed,
  getProcessedPayment,
} from "#test-utils/processed-payments.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stripeRefundRequest } from "#test-utils/stripe/fixtures.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  expectStoredRefund,
  ledgeredPaymentWithoutReservation,
  singleListingPayment,
} from "./helpers.ts";

describeWithEnv("payment processing booking outcomes", { db: true }, () => {
  test("creates one paid booking and replays it without a duplicate", async () => {
    const id = "cs_direct_booking";
    const { data, listing } = await singleListingPayment(id, 1000);

    const first = await processPaymentSession(id, data);
    expect(first.success).toBe(true);
    if (!first.success) throw new Error(first.error);
    expect(first.listingId).toBe(listing.id);
    expect(first.ticketTokens).toHaveLength(1);
    expect(first.ticketTokens[0]).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(await processPaymentSession(id, data)).toEqual(first);
    const attendees = await getAttendeesRaw(listing.id);
    expect(attendees).toHaveLength(1);
    expect(attendees[0]?.quantity).toBe(1);
    expect(attendees[0]?.price_paid).toBe(1000);
    expect((await getProcessedPayment(id))?.attendee_id).toBe(
      first.attendee.id,
    );
  });

  test("creates a paid booking in four database calls", async () => {
    const id = "cs_direct_booking_budget";
    const { data } = await singleListingPayment(id, 1000);
    const calls = await countDatabaseCalls(4, async () => {
      expect((await processPaymentSession(id, data)).success).toBe(true);
    });
    expect(calls).toBe(4);
  });

  test("creates and answers a paid booking in five database calls", async () => {
    const id = "cs_direct_answered_booking_budget";
    const { data, listing } = await singleListingPayment(id, 1000);
    const question = await questionsTable.insert({
      displayType: "select",
      text: "Meal?",
    });
    const answer = await answersTable.insert({
      questionId: question.id,
      sortOrder: 0,
      text: "Soup",
    });
    await listingQuestions.setIds(listing.id, [question.id]);
    data.intent.listingAnswerIds = { [String(listing.id)]: [answer.id] };
    const calls = await countDatabaseCalls(5, async () => {
      expect((await processPaymentSession(id, data)).success).toBe(true);
    });
    expect(calls).toBe(5);
  });

  test("heals a missing reservation from the durable booking ledger", async () => {
    const id = "cs_direct_ledger_replay";
    const { attendeeId, data, listing } =
      await ledgeredPaymentWithoutReservation(id, 700);
    setSuppressDebugLogs(false);
    using debug = spy(console, "debug");
    try {
      expect(await processPaymentSession(id, data)).toEqual({
        attendee: { id: attendeeId },
        listingId: listing.id,
        success: true,
        ticketTokens: [],
      });
    } finally {
      setSuppressDebugLogs(null);
    }

    expect((await getProcessedPayment(id))?.attendee_id).toBe(attendeeId);
    expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
    expect(
      debug.calls.some((call) =>
        String(call.args[0]).endsWith(
          `[Payment] Replayed already-ledgered session ${id}`,
        ),
      ),
    ).toBe(true);
  });

  test("acknowledges ledger money whose booking was deleted", async () => {
    const id = "cs_direct_orphan";
    const { attendeeId, data, listing } =
      await ledgeredPaymentWithoutReservation(id, 700);
    await execute("DELETE FROM listing_attendees WHERE attendee_id = ?", [
      attendeeId,
    ]);
    await execute("DELETE FROM attendees WHERE id = ?", [attendeeId]);

    expect(await processPaymentSession(id, data)).toEqual({
      detail: `Ledger already records session ${id} with no live booking (listing ${listing.id})`,
      error: "This payment has already been processed.",
      status: 200,
      success: false,
    });
    expect(await getAttendeesRaw(listing.id)).toHaveLength(0);
  });

  test("keeps and refunds every signed line when its listing was deleted", async () => {
    await setupStripe();
    const id = "cs_direct_deleted_listing";
    const { data, listing } = await singleListingPayment(id, 900);
    await execute("DELETE FROM listings WHERE id = ?", [listing.id]);
    using refund = stubRefundPayment("re_deleted", 900);

    const result = await processPaymentSession(id, data);
    expect(result).toEqual({
      detail: `Listing not found for a signed session (session=${id})`,
      error:
        "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.",
      refunded: true,
      status: 200,
      success: false,
    });
    expect(refund.calls[0]?.args).toEqual([
      stripeRefundRequest(`pi_${id}`, 900),
    ]);
    expect(
      await queryOne<{ listing_id: number; quantity: number }>(
        "SELECT listing_id, quantity FROM listing_attendees WHERE listing_id = ?",
        [listing.id],
      ),
    ).toEqual({ listing_id: listing.id, quantity: 0 });
    await expectSessionFailed(id);
  });

  test("keeps a charge-mismatched booking and records a terminal refund", async () => {
    await setupStripe();
    const id = "cs_direct_charge_mismatch";
    const { data, listing } = await singleListingPayment(id, 1000);
    data.verdict = { agreed: 900, verdict: "mismatch" };
    using refund = stubRefundPayment("re_mismatch");

    const result = await processPaymentSession(id, data);
    await expectStoredRefund(
      result,
      {
        detail: "Provider charged 1000 but signed total was 900",
        listingId: listing.id,
        sessionId: id,
      },
      refund,
    );
  });
});
