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
import { expectFlash } from "#test-utils/assertions.ts";
import { mergePair, submitMerge } from "#test-utils/attendees/merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookingIdOf,
  bookOwnListing,
  givePlan,
  MONTHLY,
  statusOf,
  subscribe,
} from "#test-utils/db-helpers/subscriptions.ts";
import { rejection } from "#test-utils/ledger.ts";
import { adminFormPost, adminGet, apiRequest } from "#test-utils/session.ts";

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
    const bookingId = await bookingIdOf(ada);
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
    expect(await getSubscribedRowOrNull(await bookingIdOf(plain))).toBe(null);
    expect((await rejection(deleteAttendee(ada.attendeeId))).message).toBe(
      LIVE_REFUSAL,
    );
  });

  test("the delete form refuses a listing with a live subscription", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    const { response } = await adminFormPost(
      `/admin/listing/${ada.listingId}/delete`,
      { confirmIdentifier: "Ada Club" },
    );
    expect(response.status).toBe(302);
    expectFlash(response, LIVE_REFUSAL, false);
    expect(await attendeeStillThere(ada.attendeeId)).toBe(true);
    expect((await adminGet(`/admin/listing/${ada.listingId}`)).status).toBe(
      200,
    );
  });

  test("the API refuses to delete a listing with a live subscription", async () => {
    const ada = await subscribe("Ada", MONTHLY);
    const response = await apiRequest(`/api/admin/listings/${ada.listingId}`, {
      body: { confirm_identifier: "Ada Club" },
      method: "DELETE",
    });
    expect([response.status, await response.json()]).toEqual([
      400,
      { error: LIVE_REFUSAL },
    ]);
    expect(await attendeeStillThere(ada.attendeeId)).toBe(true);
  });

  test("the merge form refuses to replace a booking with a live subscription", async () => {
    const { listing1, target, sourceToken } = await mergePair({
      sameListing: true,
    });
    await givePlan(target.id, "sub_target", MONTHLY);
    const { response } = await submitMerge(target.id, sourceToken, {
      [`booking${listing1.id}:null:0:0`]: "take_source",
    });
    expect(response.status).toBe(302);
    expectFlash(response, expect.stringContaining(LIVE_REFUSAL), false);
    expect(
      await statusOf({ attendeeId: target.id, listingId: listing1.id }),
    ).toBe("trialing");
  });
});
