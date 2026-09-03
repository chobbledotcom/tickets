/** The Money target for a refunded rejection, and the answer its callback
 * gives.
 *
 * Before this module existed, refunding a paid-but-unreadable session left
 * its authority parked in completed/due with a "recorded in Money" answer
 * that had nothing to record against. These tests prove the fix end to end:
 * the quantity-0 ghost exists, the payment and refund legs land under the
 * session's own event group, the authority finishes recorded, and replays
 * change nothing. The answer tests stay on the page the callback renders,
 * because a blank reference needs no money work. */

import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bookingEventGroup, refundEventGroup } from "#accounting/mappers.ts";
import { transfersByEventGroup } from "#accounting/queries.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { queryAll, queryOne } from "#db/client.ts";
import {
  finalizeSessionIfUnresolved,
  parseSessionFailure,
  reserveSession,
} from "#db/processed-payments.ts";
import { loadRefundAuthorityById } from "#db/provider-refund-authority.ts";
import { completedAtOf } from "#payment/refund-authority-state.ts";
import type { SessionRejection } from "#payment/validated-session.ts";
import {
  answerRejectedSession,
  settleRejectedCharge,
} from "#routes/api/payment-processing/rejected-target.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { recordProviderRefunds } from "#shared/provider-refunds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { singleItem } from "#test-utils/factories.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { withRefundLedgerFault } from "#test-utils/refund-ledger-fault.ts";
import {
  expectOnePairOfLegs,
  ourRejection,
  withRefundAnswering,
  withSucceedingRefundFor,
} from "#test-utils/rejected-charge.ts";
import { getTestSession, requestAsSession } from "#test-utils/session.ts";
import { completedStripeRefund } from "#test-utils/stripe/fixtures.ts";

setupTestEncryptionKey();

/** A checkout we cannot even name a charge for: the answer needs no money
 *  work, so the test stays on the page the branch renders. */
const blankReference = (): SessionRejection => ({
  provider: "sumup",
  reason: "blank_reference",
  sessionId: "cs_blank",
});

describeWithEnv("the rejected-checkout answer", { db: true }, () => {
  it("tells the buyer the session could not be found", async () => {
    const response = await answerRejectedSession(blankReference(), () => {});

    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("We could not find this payment session.");
    expect(page).not.toContain("Staff diagnostics");
  });

  it("hands an owner the diagnostics beside the refusal", async () => {
    const response = await runWithPendingWork(async () =>
      answerRejectedSession(
        blankReference(),
        () => {},
        await requestAsSession("/payment/success", await getTestSession()),
      ),
    );

    const page = await response.text();
    expect(page).toContain("Staff diagnostics");
    expect(page).toContain("cs_blank");
  });

  it("tells the buyer the money went back when the refund succeeded", async () => {
    const { result: response } = await withSucceedingRefundFor(750)(() =>
      answerRejectedSession(ourRejection("pi_answer_refunded"), () => {}),
    );

    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("We have sent your money back");
    expect(page).not.toContain("Staff diagnostics");
  });

  it("asks the caller to come back while the refund is still out there", async () => {
    // The provider took the refund request but has not confirmed it yet, so
    // the money is neither here nor there: nothing is settled.
    const { result: response } = await withRefundAnswering((request) => ({
      ...completedStripeRefund(
        request.paymentReference,
        "re_pending",
        request.charge.captured.amount,
      ),
      kind: "accepted" as const,
    }))(() =>
      answerRejectedSession(ourRejection("pi_answer_pending"), () => {}),
    );

    expect(response.status).toBe(503);
    const page = await response.text();
    expect(page).toContain("We could not find this payment session.");
  });
});

describeWithEnv("a refunded rejection's Money target", { db: true }, () => {
  const CAPTURED = 750;

  /** A rejection whose signed metadata names one real listing line. */
  const rejectionFor = async (reference: string) => {
    const listing = await createTestListing({});
    return {
      listing,
      rejection: ourRejection(reference, {
        items: singleItem(listing.id, 1, 500),
      }),
    };
  };

  /** The session's own row never carries the ghost — the anchor row does —
   * so the ghost is found through the listing its zero-quantity line names. */
  const ghostAttendees = (
    listingId: number,
  ): Promise<{ id: number; quantity: number }[]> =>
    queryAll<{ id: number; quantity: number }>(
      `SELECT attendee.id, booking.quantity
         FROM listing_attendees AS booking
         JOIN attendees AS attendee ON attendee.id = booking.attendee_id
        WHERE booking.listing_id = ?`,
      [listingId],
    );

  const attendeeCount = async (): Promise<number> => {
    const row = await queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM attendees",
      [],
    );
    return Number(row?.total ?? 0);
  };

  it("stores the ghost, posts both legs, and records the authority", async () => {
    const { listing, rejection } = await rejectionFor("pi_target");
    const { result } = await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(rejection),
    );
    expect(result.refunded).toBe(true);
    expect(result.returned).not.toBeNull();

    const ghosts = await ghostAttendees(listing.id);
    expect(ghosts).toEqual([{ id: ghosts[0]!.id, quantity: 0 }]);

    // The books show the money in and the money back, each under the
    // session's own event group and its derived refund group.
    const bookingGroup = await bookingEventGroup(rejection.sessionId);
    const payment = await transfersByEventGroup(bookingGroup);
    const returned = await transfersByEventGroup(
      await refundEventGroup(bookingGroup),
    );
    expect(payment.map(({ amount }) => amount)).toEqual([CAPTURED]);
    expect(returned.map(({ amount }) => amount)).toEqual([CAPTURED]);

    // The authority no longer waits for the untrue owner attestation.
    const authority = await loadRefundAuthorityById(
      result.returned!.authority.id,
    );
    expect(authority?.state.kind).toBe("completed");
    expect(authority?.state.local.kind).toBe("recorded");

    // Both legs carry the provider's return instant, so every delivery
    // would post the exact same identity.
    const returnInstant = new Date(
      completedAtOf(authority!.state)!,
    ).toISOString();
    expect(payment.map(({ occurredAt }) => occurredAt)).toEqual([
      returnInstant,
    ]);
    expect(returned.map(({ occurredAt }) => occurredAt)).toEqual([
      returnInstant,
    ]);

    // The ghost's born claim was settled, so nothing holds the row.
    const mirror = await queryOne<{ protected_state: string }>(
      "SELECT protected_state FROM processed_payments WHERE attendee_id = ?",
      [ghosts[0]!.id],
    );
    expect(mirror?.protected_state).toBe("");
  });

  it("stores the outcome a later delivery replays to the buyer", async () => {
    const { rejection } = await rejectionFor("pi_stored_outcome");
    await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(rejection),
    );

    const stored = await getProcessedPayment(rejection.sessionId);
    const outcome = await parseSessionFailure(stored!.failure_data);
    expect(outcome).toEqual({
      completion: { code: "malformed_charge" },
      error: "The payment could not be read, so it was refunded.",
      refunded: true,
      status: 400,
    });
  });

  it("replays as a no-op: one ghost, one pair of legs", async () => {
    const { listing, rejection } = await rejectionFor("pi_replay");
    const settle = () =>
      withSucceedingRefundFor(CAPTURED)(() => settleRejectedCharge(rejection));
    await settle();
    const again = await settle();
    expect(again.result.settled).toBe(true);

    expect((await ghostAttendees(listing.id)).length).toBe(1);
    await expectOnePairOfLegs(rejection.sessionId);
  });

  /** Settle with a succeeding refund, then prove this delivery stored
   * nothing: no attendee anywhere and no ledger legs under the session. */
  const settleWithoutStoring = async (
    rejection: ReturnType<typeof ourRejection>,
  ) => {
    const { result } = await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(rejection),
    );
    expect(result.refunded).toBe(true);
    expect(await attendeeCount()).toBe(0);
    expect(
      await transfersByEventGroup(await bookingEventGroup(rejection.sessionId)),
    ).toEqual([]);
    return result;
  };

  it("keeps today's behavior when the metadata cannot name the booking", async () => {
    // items "[]" fails the intent schema, so there is nothing true to store.
    const result = await settleWithoutStoring(ourRejection("pi_unreadable"));
    // The authority stays with its owner route, exactly as before the fix.
    const authority = await loadRefundAuthorityById(
      result.returned!.authority.id,
    );
    expect(authority?.state.kind).toBe("completed");
    expect(authority?.state.local.kind).toBe("due");
  });

  it("fails the delivery when Money cannot record the return", async () => {
    const { listing, rejection } = await rejectionFor("pi_ledger_down");
    // The same real write-boundary fault the recovery stories use: only
    // refund legs are refused, so the atomic two-leg post rolls back whole.
    await withRefundLedgerFault(() =>
      expect(
        withSucceedingRefundFor(CAPTURED)(() =>
          settleRejectedCharge(rejection),
        ),
      ).rejects.toThrow("could not be recorded"),
    );
    // The ghost and its outcome are stored; the books hold nothing at all,
    // and the authority stays due — parked and visible, ready for a retry.
    expect((await ghostAttendees(listing.id)).length).toBe(1);
    expect(
      await transfersByEventGroup(await bookingEventGroup(rejection.sessionId)),
    ).toEqual([]);
    const charge = await queryOne<{
      refund_state_name: string;
      refund_local_state: string;
    }>("SELECT refund_state_name, refund_local_state FROM payment_charges", []);
    expect(charge).toEqual({
      refund_local_state: "due",
      refund_state_name: "completed",
    });
  });

  it("finishes the interrupted tail on the next delivery, exactly once", async () => {
    const { listing, rejection } = await rejectionFor("pi_ledger_resumed");
    await withRefundLedgerFault(() =>
      expect(
        withSucceedingRefundFor(CAPTURED)(() =>
          settleRejectedCharge(rejection),
        ),
      ).rejects.toThrow("could not be recorded"),
    );

    // The fault lifts and the provider redelivers: the same entry point
    // finds the held anchor and finishes the money records from it.
    const { result } = await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(rejection),
    );
    expect(result).toEqual({
      refunded: true,
      returned: result.returned,
      settled: true,
    });
    await expectOnePairOfLegs(rejection.sessionId);
    const charge = await queryOne<{
      refund_state_name: string;
      refund_local_state: string;
    }>("SELECT refund_state_name, refund_local_state FROM payment_charges", []);
    expect(charge).toEqual({
      refund_local_state: "recorded",
      refund_state_name: "completed",
    });
    const anchor = await queryOne<{ protected_state: string }>(
      "SELECT protected_state FROM processed_payments WHERE payment_reference_index != ''",
      [],
    );
    expect(anchor?.protected_state).toBe("");

    // A third delivery finds nothing left to do and changes nothing.
    await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(rejection),
    );
    await expectOnePairOfLegs(rejection.sessionId);
    expect((await ghostAttendees(listing.id)).length).toBe(1);
  });

  it("resumes nothing when the session row was finalized another way", async () => {
    const { listing, rejection } = await rejectionFor("pi_finalized_row");
    // A finalized idempotency row for the session id is the one shape the
    // resume must leave entirely alone.
    const made = await bookAttendee(listing, {
      email: "done@example.com",
      name: "Already Done",
    });
    if (!made.success) throw new Error("attendee setup failed");
    await reserveSession(rejection.sessionId);
    await finalizeSessionIfUnresolved(
      rejection.sessionId,
      made.attendees[0]!.id,
      null,
    );

    const { result } = await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(rejection),
    );

    expect(result.refunded).toBe(true);
    expect(
      await queryOne<{ total: number }>(
        "SELECT COUNT(*) AS total FROM processed_payments WHERE payment_session_id LIKE 'legacy:%'",
        [],
      ),
    ).toEqual({ total: 0 });
  });

  it("releases its fence when storing the ghost fails, so redelivery retries", async () => {
    const { rejection } = await rejectionFor("pi_store_fails");
    const broken = stub(attendeesApi, "createAttendeeAtomic", () => {
      throw new Error("synthetic store failure");
    });
    try {
      await expect(
        withSucceedingRefundFor(CAPTURED)(() =>
          settleRejectedCharge(rejection),
        ),
      ).rejects.toThrow("synthetic store failure");
    } finally {
      broken.restore();
    }
    // The empty hold is gone: the next delivery claims the session at once
    // instead of waiting out the stale-reservation timer.
    expect(await reserveSession(rejection.sessionId)).toEqual({
      reserved: true,
    });
    expect(await attendeeCount()).toBe(0);
  });

  it("skips the local recording when the owner already recorded the authority", async () => {
    const listing = await createTestListing({});
    // First delivery: unreadable metadata, so no target is stored and the
    // fence is given back — the authority parks as completed and due.
    const unreadable = ourRejection("pi_owner_raced");
    const first = await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(unreadable),
    );
    await recordProviderRefunds([first.result.returned!.authority]);
    // Redelivery carries readable metadata: the target is stored now, but
    // the already-recorded authority must not be recorded a second time.
    const redelivered = ourRejection("pi_owner_raced", {
      items: singleItem(listing.id, 1, 500),
    });
    const second = await withSucceedingRefundFor(CAPTURED)(() =>
      settleRejectedCharge(redelivered),
    );
    expect(second.result.returned!.local).toBe("recorded");
    expect((await ghostAttendees(listing.id)).length).toBe(1);
    const authority = await loadRefundAuthorityById(
      second.result.returned!.authority.id,
    );
    expect(authority?.state.kind).toBe("completed");
    expect(authority?.state.local.kind).toBe("recorded");
  });

  it("leaves a racing delivery's fresh hold alone", async () => {
    const { rejection } = await rejectionFor("pi_racing");
    expect(await reserveSession(rejection.sessionId)).toEqual({
      reserved: true,
    });
    // The racing holder owns the persistence; this delivery stores nothing.
    await settleWithoutStoring(rejection);
  });
});
