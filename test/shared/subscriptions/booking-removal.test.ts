/** A booking whose subscription still charges cannot be deleted. The owner
 * cancels the subscription first. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteAttendee } from "#db/attendees/delete.ts";
import { execute, queryOne } from "#db/client.ts";
import { loadPaymentMoveSnapshot } from "#db/payment-admit-move.ts";
import { sql } from "#db/sql.ts";
import { getSubscribedRowOrNull } from "#db/subscriptions.ts";
import { listingDeleteError } from "#shared/listings-actions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookOwnListing,
  MONTHLY,
  subscribe,
} from "#test-utils/db-helpers/subscriptions.ts";
import { rejection } from "#test-utils/ledger.ts";

const LIVE_REFUSAL =
  "This booking has a subscription that still charges. Cancel the subscription first.";

const ENDED = { ...MONTHLY, status: "canceled" };

const attendeeStillThere = async (attendeeId: number): Promise<boolean> =>
  (await queryOne<{ id: number }>(
    sql`SELECT id FROM attendees WHERE id = ${attendeeId}`,
  )) !== null;

describeWithEnv("removing a subscribed booking", { db: true }, () => {
  test("blocks the delete of an attendee with a live subscription, not the merge", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    expect((await loadPaymentMoveSnapshot([ada.attendeeId])).admission).toEqual(
      {
        delete: { kind: "blocked", reason: LIVE_REFUSAL },
        merge: { kind: "available" },
      },
    );
  });

  test("refuses to delete an attendee with a live subscription", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    expect((await rejection(deleteAttendee(ada.attendeeId))).message).toBe(
      LIVE_REFUSAL,
    );
    expect(await attendeeStillThere(ada.attendeeId)).toBe(true);
  });

  test("deletes an attendee whose subscription ended", async () => {
    const ada = await subscribe("Ada", ENDED);
    expect(
      (await loadPaymentMoveSnapshot([ada.attendeeId])).admission.delete,
    ).toEqual({ kind: "available" });
    await deleteAttendee(ada.attendeeId);
    expect(await attendeeStillThere(ada.attendeeId)).toBe(false);
  });

  test("refuses to delete a listing with a live subscription", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    expect(await listingDeleteError(ada.listingId)).toBe(LIVE_REFUSAL);
  });

  test("lets a listing go whose subscriptions ended", async () => {
    const ada = await subscribe("Ada", ENDED);
    expect(await listingDeleteError(ada.listingId)).toBeNull();
  });

  test("keeps a failed checkout's subscription available for cancellation", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    const plain = await bookOwnListing("Bob");
    const idOf = async (attendeeId: number): Promise<number> =>
      (await queryOne<{ id: number }>(
        sql`SELECT id FROM listing_attendees WHERE attendee_id = ${attendeeId}`,
      ))!.id;
    const bookingId = await idOf(ada.attendeeId);
    await execute(
      sql`UPDATE listing_attendees SET quantity = 0 WHERE id = ${bookingId}`,
    );
    expect(await getSubscribedRowOrNull(bookingId)).toEqual({
      attendeeId: ada.attendeeId,
      id: bookingId,
      listingId: ada.listingId,
      quantity: 0,
      recurringInterval: "month",
      recurringPrice: 600,
      recurringTax: 100,
      subscriptionId: "sub_ada",
      subscriptionStatus: "trialing",
    });
    expect(await getSubscribedRowOrNull(await idOf(plain.attendeeId))).toBe(
      null,
    );
    expect((await rejection(deleteAttendee(ada.attendeeId))).message).toBe(
      LIVE_REFUSAL,
    );
  });
});
