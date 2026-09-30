/**
 * Checking someone in from a listing's roster: what it writes down, where it
 * sends the operator back to, and the one row it refuses.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import {
  adminCheckinPost as checkIn,
  emptyBookingLine,
  setupListingAndAttendee,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("what a check-in writes down", { db: true }, () => {
  test("records the direction in the listing's history", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      listing: { name: "Sports Day" },
      name: "Ada Lovelace",
    });

    await checkIn(listing.id, attendee.id, { check_in: "true" });
    await checkIn(listing.id, attendee.id, { check_in: "false" });

    const history = await activityMessages();
    expect(history).toContain("Attendee checked in 1 ticket for 'Sports Day'");
    expect(history).toContain("Attendee checked out 1 ticket for 'Sports Day'");
  });

  test("says which way round it went", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Grace Hopper",
    });

    const { response: went } = await checkIn(listing.id, attendee.id, {
      check_in: "true",
    });
    const { response: came } = await checkIn(listing.id, attendee.id, {
      check_in: "false",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Checked Grace Hopper in",
    )(went);
    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Checked Grace Hopper out",
    )(came);
  });

  test("refuses a direction the forms never post", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Mangled Form",
    });

    const { response } = await checkIn(listing.id, attendee.id, {
      check_in: "sideways",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Invalid check-in direction",
      false,
    )(response);
    const refused = await activityMessages();
    expect(refused.filter((message) => message.includes("checked"))).toEqual(
      [],
    );
  });

  test("a check-in that moves nothing says so", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      listing: { name: "Quiet Door" },
      name: "Twice Told",
    });
    await checkIn(listing.id, attendee.id, { check_in: "true" });

    const { response } = await checkIn(listing.id, attendee.id, {
      check_in: "true",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "No tickets moved",
      false,
    )(response);
    const history = await activityMessages();
    expect(history.filter((message) => message.includes("checked"))).toEqual([
      "Attendee checked in 1 ticket for 'Quiet Door'",
    ]);
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

    // No check-in line at all, whatever count it would name.
    expect(
      (await activityMessages()).filter((message) =>
        message.startsWith("Attendee checked"),
      ),
    ).toEqual([]);
  });
});
