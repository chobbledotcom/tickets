import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { hmacHash } from "#crypto/hashing.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import {
  readCheckoutAnswers,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { execute, queryOne } from "#db/client.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { getOrCreateStringIds } from "#db/questions/strings.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { stageSquareLinkEnd } from "#db/square-link-ends.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";

import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createFreeTextQuestion } from "#test-utils/db-helpers/questions.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import {
  expectSessionFailed,
  getProcessedPayment,
} from "#test-utils/processed-payments.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stripeRefundRequestShape } from "#test-utils/stripe/fixtures.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  bookingIntent,
  expectStoredRefund,
  ledgeredPaymentWithoutReservation,
  singleListingPayment,
  trustedPayment,
} from "./helpers.ts";

describeWithEnv("payment processing booking outcomes", { db: true }, () => {
  const fetch = useFetchStub();

  /** A paid checkout whose buyer typed one free-text answer on the booked
   * listing: the intent carries the answer's refs, and by default the
   * plaintext waits in the staged row the completion takes back. Pass
   * `staged: false` for a checkout whose row is already gone. */
  const checkoutWithTypedAnswer = async (
    id: string,
    { staged = true }: { staged?: boolean } = {},
  ) => {
    const { data, listing } = await singleListingPayment(id, 1000);
    const freeText = await createFreeTextQuestion([listing.id]);
    const stringId = (await getOrCreateStringIds(["Arriving late"])).get(
      "Arriving late",
    )!;
    data.intent.listingTextAnswerIds = {
      [String(listing.id)]: [{ q: freeText, s: stringId }],
    };
    if (staged) {
      await stageCheckoutAnswers(
        id,
        { [String(freeText)]: "Arriving late" },
        null,
      );
    }
    return { data, freeText, listing };
  };

  test("creates one paid booking and replays it without a duplicate", async () => {
    const id = "cs_direct_booking";
    const { data, listing } = await singleListingPayment(id, 1000);
    await configureTestEmail();

    await withRequestContext(async () => {
      const first = await processPaymentSession(id, data);
      expect(first.success).toBe(true);
      if (!first.success) throw new Error(first.error);
      expect(first.listingId).toBe(listing.id);
      expect(first.ticketTokens).toHaveLength(1);
      expect(first.ticketTokens[0]).toMatch(/^[A-Za-z0-9_-]+$/);

      // The redelivery finds the booking already exists: it answers 200 and
      // runs nothing again — no second booking, no second email.
      expect(await processPaymentSession(id, data)).toEqual(first);
      expect((await getProcessedPayment(id))?.attendee_id).toBe(
        first.attendee.id,
      );
    });
    // Exactly one confirmation email went out across both deliveries: the
    // queued sends flush when the request context ends.
    expect(fetch.callCount()).toBe(1);

    const attendees = await getAttendeesRaw(listing.id);
    expect(attendees).toHaveLength(1);
    expect(attendees[0]?.quantity).toBe(1);
    expect(attendees[0]?.price_paid).toBe(1000);
    // The batch wrote the registration activity exactly once. Queueing the
    // sends adds no second copy: the post-commit path writes nothing.
    expect(
      (await getAllActivityLog()).filter((entry) =>
        entry.message.includes("Attendee registered"),
      ),
    ).toHaveLength(1);
  });

  test("takes a Square checkout's handle row when its payment books", async () => {
    const id = "sq_direct_booking";
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 1000,
    });
    const data = trustedPayment(
      id,
      bookingIntent([{ e: listing.id, p: 1000, q: 1 }]),
      1000,
      "square",
    );
    await stageSquareLinkEnd(id, `link_${id}`, "2999-01-01T00:00:00Z");

    const result = await processPaymentSession(id, data);

    expect(result.success).toBe(true);
    // A Square link dies with its first payment, so its end row is gone.
    expect(
      await queryOne(
        "SELECT session_index FROM square_link_ends WHERE session_index = ?",
        [await hmacHash(id)],
      ),
    ).toBeNull();
  });

  /** A paid booking costs three database calls, answered or not. The answers,
   * the questions-record, and the activity lines ride the create batch, and
   * the post-commit queue writes nothing, so an answered booking costs the
   * same as a bare one. A later stack layer clears the pending-notification
   * flags in one more call after the sends settle. */
  const expectBookedInThreeCalls = async (
    id: string,
    data: Parameters<typeof processPaymentSession>[1],
  ): Promise<void> => {
    const calls = await countDatabaseCalls(3, async () => {
      expect((await processPaymentSession(id, data)).success).toBe(true);
    });
    expect(calls).toBe(3);
  };

  test("creates an unanswered paid booking in three database calls", async () => {
    const id = "cs_direct_booking_budget";
    const { data } = await singleListingPayment(id, 1000);
    await expectBookedInThreeCalls(id, data);
  });

  test("creates and answers a paid booking in three database calls", async () => {
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
    await expectBookedInThreeCalls(id, data);
  });

  test("takes a checkout's staged answers into its confirmation email", async () => {
    const id = "cs_staged_answers";
    const { data } = await checkoutWithTypedAnswer(id);
    await configureTestEmail();

    await withRequestContext(async () => {
      expect((await processPaymentSession(id, data)).success).toBe(true);
    });

    // The staged row went with the booking's create batch.
    expect(await readCheckoutAnswers(id)).toEqual(new Map());
    const body = fetch.getFetchJsonBody();
    expect(body.text).toContain("Anything else?: Arriving late");
  });

  test("a failed create batch writes nothing and keeps the staged answers", async () => {
    const id = "cs_batch_fails";
    const { data, freeText, listing } = await checkoutWithTypedAnswer(id);
    // The create batch is the atomic boundary: answers, activity lines, and
    // flags ride it, so a failure anywhere in it leaves no booking, no
    // answers, no activity line, and no flags behind.
    using _create = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.reject(new Error("batch failed")),
    );

    await expect(processPaymentSession(id, data)).rejects.toThrow(
      "batch failed",
    );

    expect(await getAttendeesRaw(listing.id)).toHaveLength(0);
    expect(await queryOne("SELECT 1 FROM answers_at_booking LIMIT 1")).toBe(
      null,
    );
    expect(
      (await getAllActivityLog()).filter((entry) =>
        entry.message.includes("Attendee registered"),
      ),
    ).toEqual([]);
    // The staged row survived the failed batch, so the provider's redelivery
    // reads the buyer's typed answers again.
    expect(await readCheckoutAnswers(id)).toEqual(
      new Map([[freeText, "Arriving late"]]),
    );
    // The reservation was released, so the redelivery starts fresh.
    expect(
      await queryOne(
        "SELECT 1 FROM processed_payments WHERE payment_session_id = ?",
        [id],
      ),
    ).toBeNull();
  });

  test("logs loudly when a late payment outlives its staged answers", async () => {
    const id = "cs_stale_row";
    using errors = spy(console, "error");
    // No staged row: the checkout's answers were pruned before the buyer
    // paid, the way a Square link paid after the retention cutoff would be.
    const { data } = await checkoutWithTypedAnswer(id, { staged: false });
    await configureTestEmail();

    await withRequestContext(async () => {
      expect((await processPaymentSession(id, data)).success).toBe(true);
    });

    expect(
      errors.calls.some((call) =>
        String(call.args[0]).includes("its staged row is gone"),
      ),
    ).toBe(true);
    const body = fetch.getFetchJsonBody();
    expect(body.text).not.toContain("Arriving late");
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
      stripeRefundRequestShape(`pi_${id}`, 900),
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
