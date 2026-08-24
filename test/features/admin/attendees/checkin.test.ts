/**
 * Checking someone in from a listing's roster: what it writes down, where it
 * sends the operator back to, and the one row it refuses.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import {
  emptyBookingLine,
  setupListingAndAttendee,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost } from "#test-utils/session.ts";

const checkIn = (
  listingId: number,
  attendeeId: number,
  extra: Record<string, string> = {},
) =>
  adminFormPost(
    `/admin/listing/${listingId}/attendee/${attendeeId}/checkin`,
    extra,
  );

describeWithEnv("what a check-in writes down", { db: true }, () => {
  test("records the direction in the listing's history", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      listing: { name: "Sports Day" },
      name: "Ada Lovelace",
    });

    await checkIn(listing.id, attendee.id);
    await checkIn(listing.id, attendee.id);

    const history = await activityMessages();
    expect(history).toContain("Attendee checked in for 'Sports Day'");
    expect(history).toContain("Attendee checked out for 'Sports Day'");
  });

  test("says which way round it went", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Grace Hopper",
    });

    const { response: went } = await checkIn(listing.id, attendee.id);
    const { response: came } = await checkIn(listing.id, attendee.id);

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Checked Grace Hopper in",
    )(went);
    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Checked Grace Hopper out",
    )(came);
  });
});

describeWithEnv("where a check-in lands", { db: true }, () => {
  test("keeps a filter of in or out", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Filtered",
    });

    const { response } = await checkIn(listing.id, attendee.id, {
      return_filter: "in",
    });

    expect(response.headers.get("location")).toContain(
      `/admin/listing/${listing.id}/attendees?filter=in`,
    );
  });

  test("drops a filter it does not offer", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Unfiltered",
    });

    const { response } = await checkIn(listing.id, attendee.id, {
      return_filter: "sideways",
    });

    const location = response.headers.get("location")!;
    expect(location).toContain(`/admin/listing/${listing.id}/attendees`);
    expect(location).not.toContain("filter=");
  });
});

describeWithEnv("a roster row with no places on it", { db: true }, () => {
  test("cannot be checked in, and says why", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Gave It Up",
    });
    await emptyBookingLine(listing.id, attendee.id);

    const { response } = await checkIn(listing.id, attendee.id);

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}`,
      "Cannot check in a no-quantity line",
      false,
    )(response);
  });

  test("refuses back to the page the form came from", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Gave It Up Too",
    });
    await emptyBookingLine(listing.id, attendee.id);

    const { response } = await checkIn(listing.id, attendee.id, {
      return_url: `/admin/listing/${listing.id}/scanner`,
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/scanner`,
      "Cannot check in a no-quantity line",
      false,
    )(response);
  });

  test("is left alone by the refusal", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      listing: { name: "Untouched Listing" },
      name: "Untouched",
    });
    await emptyBookingLine(listing.id, attendee.id);

    await checkIn(listing.id, attendee.id);

    expect(await activityMessages()).not.toContain(
      `Attendee checked in for '${listing.name}'`,
    );
  });
});
