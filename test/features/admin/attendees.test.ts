/**
 * The attendee actions bound to a listing's roster: checking someone in and
 * out, adding one by hand, and clearing an incomplete payment. Each returns
 * the operator to the tab the form lives on, so the row they acted on is in
 * view with the confirmation.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import {
  setupListingAndAttendee,
  submitDeleteIncomplete,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getAttendeesRaw } from "#test-utils/db-helpers/attendees.ts";
import { adminFormPost, getTestSession } from "#test-utils/session.ts";

/** Whether the roster row for one attendee on one listing is checked in. */
const isCheckedIn = async (
  listingId: number,
  attendeeId: number,
): Promise<boolean> => {
  const rows = await getDb().execute({
    args: [listingId, attendeeId],
    sql: "SELECT checked_in FROM listing_attendees WHERE listing_id = ? AND attendee_id = ?",
  });
  return Number(rows.rows[0]!.checked_in) === 1;
};

const checkIn = (
  listingId: number,
  attendeeId: number,
  extra: Record<string, string> = {},
) =>
  adminFormPost(
    `/admin/listing/${listingId}/attendee/${attendeeId}/checkin`,
    extra,
  );

describeWithEnv("checking an attendee in", { db: true }, () => {
  test("marks them in, then out again on a second press", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Ada Lovelace",
    });

    await checkIn(listing.id, attendee.id);
    const afterIn = await isCheckedIn(listing.id, attendee.id);
    await checkIn(listing.id, attendee.id);
    const afterOut = await isCheckedIn(listing.id, attendee.id);

    expect(afterIn).toBe(true);
    expect(afterOut).toBe(false);
  });

  test("returns to the roster, keeping the filter it came from", async () => {
    // The roster's form threads its filtered view through, so the operator
    // lands back on the list they were working through.
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Grace Hopper",
    });

    const { response } = await checkIn(listing.id, attendee.id, {
      return_filter: "out",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees?filter=out`,
      "Checked Grace Hopper in",
    )(response);
  });

  test("returns where the form asked when it named a page", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Alan Turing",
    });

    const { response } = await checkIn(listing.id, attendee.id, {
      return_url: `/admin/listing/${listing.id}/scanner`,
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/scanner`,
      "Checked Alan Turing in",
    )(response);
  });
});

describeWithEnv("adding an attendee by hand", { db: true }, () => {
  test("adds them and lands on the roster they were added to", async () => {
    const { listing } = await setupListingAndAttendee({ name: "Existing" });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attendee`,
      { email: "new@example.com", name: "Added By Hand", quantity: "1" },
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Added Added By Hand",
    )(response);
  });

  test("refuses more places than the listing has left", async () => {
    const { listing } = await setupListingAndAttendee({
      listing: { maxAttendees: 1 },
      name: "Took The Only Place",
    });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attendee`,
      { email: "late@example.com", name: "Too Late", quantity: "1" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      `/admin/listing/${listing.id}/attendees`,
    );
  });
});

describeWithEnv("clearing an incomplete payment", { db: true }, () => {
  test("refuses when the attendee's payment is not incomplete", async () => {
    // The free booking above paid nothing to leave incomplete, so the action
    // has nothing to clear and says so instead of deleting the row.
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Fully Booked",
    });

    const { cookie, csrfToken } = await getTestSession();
    const response = await submitDeleteIncomplete(
      listing.id,
      attendee.id,
      cookie,
      csrfToken,
    );

    expect(response.status).toBe(302);
    expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
  });
});
