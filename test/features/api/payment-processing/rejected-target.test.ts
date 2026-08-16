/** The Money target for a refunded rejection.
 *
 * Before this module existed, refunding a paid-but-unreadable session left
 * its authority parked in completed/due with a "recorded in Money" answer
 * that had nothing to record against. These tests prove the fix end to end:
 * the quantity-0 ghost exists, the payment and refund legs land under the
 * session's own event group, the authority finishes recorded, and replays
 * change nothing. */

import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settleRejectedCharge } from "#routes/api/payment-processing/rejected-target.ts";
import {
  bookingEventGroup,
  refundEventGroup,
} from "#shared/accounting/mappers.ts";
import { transfersByEventGroup } from "#shared/accounting/queries.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { loadRefundAuthorityById } from "#shared/db/provider-refund-authority.ts";
import { recordProviderRefunds } from "#shared/provider-refunds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { singleItem } from "#test-utils/factories.ts";
import {
  ourRejection,
  withSucceedingRefundFor,
} from "#test-utils/rejected-charge.ts";

setupTestEncryptionKey();

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

    // The ghost's born claim was settled, so nothing holds the row.
    const mirror = await queryOne<{ protected_state: string }>(
      "SELECT protected_state FROM processed_payments WHERE attendee_id = ?",
      [ghosts[0]!.id],
    );
    expect(mirror?.protected_state).toBe("");
  });

  it("replays as a no-op: one ghost, one pair of legs", async () => {
    const { listing, rejection } = await rejectionFor("pi_replay");
    const settle = () =>
      withSucceedingRefundFor(CAPTURED)(() => settleRejectedCharge(rejection));
    await settle();
    const again = await settle();
    expect(again.result.settled).toBe(true);

    expect((await ghostAttendees(listing.id)).length).toBe(1);
    const bookingGroup = await bookingEventGroup(rejection.sessionId);
    expect((await transfersByEventGroup(bookingGroup)).length).toBe(1);
    expect(
      (await transfersByEventGroup(await refundEventGroup(bookingGroup)))
        .length,
    ).toBe(1);
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
