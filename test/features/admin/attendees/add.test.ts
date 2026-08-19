/**
 * Adding an attendee by hand from a listing's roster.
 *
 * What the operator types becomes one booking on that listing. A daily listing
 * takes a date, and one that lets the visitor choose a length takes a day
 * count too. Contact details the listing does not ask for are stored empty
 * rather than as anything else.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
import { t } from "#i18n";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { decryptFirstAttendee } from "#test-utils/db-helpers/attendees.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

const addTo = (listingId: number, fields: Record<string, string>) =>
  adminFormPost(`/admin/listing/${listingId}/attendee`, fields);

/** The stored booking line for a listing: what the form's date and day count
 * turned into. */
const bookingLine = (listingId: number) =>
  queryOne<{
    start_at: string | null;
    end_at: string | null;
    quantity: number;
  }>(
    "SELECT start_at, end_at, quantity FROM listing_attendees WHERE listing_id = ?",
    [listingId],
  );

describeWithEnv("adding to a listing with no dates", { db: true }, () => {
  test("books them with no day attached", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Anytime",
    });

    const { response } = await addTo(listing.id, {
      email: "someone@example.com",
      name: "No Date Needed",
      quantity: "2",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Added No Date Needed",
    )(response);
    expect(await bookingLine(listing.id)).toEqual({
      end_at: null,
      quantity: 2,
      start_at: null,
    });
  });

  test("leaves the details the listing never asked for empty", async () => {
    const listing = await createTestListing({
      fields: "phone",
      maxAttendees: 10,
      name: "Phone Only",
    });

    await addTo(listing.id, {
      name: "Sparse",
      phone: "07700900123",
      quantity: "1",
    });

    const attendee = await decryptFirstAttendee(listing.id);
    expect(attendee.phone).toBe("07700900123");
    expect(attendee.email).toBe("");
    expect(attendee.address).toBe("");
    expect(attendee.special_instructions).toBe("");
  });

  test("leaves the phone empty when the listing asks for an email", async () => {
    const listing = await createTestListing({
      fields: "email",
      maxAttendees: 10,
      name: "Email Only",
    });

    await addTo(listing.id, {
      email: "just@example.com",
      name: "No Phone",
      quantity: "1",
    });

    const attendee = await decryptFirstAttendee(listing.id);
    expect(attendee.email).toBe("just@example.com");
    expect(attendee.phone).toBe("");
  });

  test("does not ask for a stay length it never offers", async () => {
    // Letting the visitor choose a length only means anything for a daily
    // listing, so a standard one carrying the flag still books in one go.
    const listing = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800 },
      durationDays: 2,
      maxAttendees: 10,
      name: "Standard But Flagged",
    });

    const { response } = await addTo(listing.id, {
      email: "nolength@example.com",
      name: "No Length Asked",
      quantity: "1",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      "Added No Length Asked",
    )(response);
  });

  test("records the addition in the listing's history", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Logged",
    });

    await addTo(listing.id, {
      email: "logged@example.com",
      name: "Written Down",
      quantity: "1",
    });

    expect(await activityMessages()).toContain(
      "Attendee 'Written Down' added manually",
    );
  });
});

describeWithEnv("adding to a daily listing", { db: true }, () => {
  const dailyListing = (overrides: Record<string, unknown>) =>
    createDailyTestListing({
      maxAttendees: 10,
      maximumDaysAfter: 100,
      ...overrides,
    });

  /** Add one attendee on a chosen day, and report the days the stay covers. */
  const stayFor = async (
    listingId: number,
    fields: Record<string, string>,
  ): Promise<{ start: string; end: string }> => {
    await addTo(listingId, {
      date: "2026-09-01",
      email: "stay@example.com",
      quantity: "1",
      ...fields,
    });
    const line = (await bookingLine(listingId))!;
    return {
      end: line.end_at!.slice(0, 10),
      start: line.start_at!.slice(0, 10),
    };
  };

  test("books them for the listing's own length", async () => {
    const listing = await dailyListing({ durationDays: 2, name: "Two Nights" });

    expect(await stayFor(listing.id, { name: "Two Night Stay" })).toEqual({
      end: "2026-09-03",
      start: "2026-09-01",
    });
  });

  test("uses the length the operator chose when the listing lets them", async () => {
    const listing = await dailyListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
      durationDays: 3,
      name: "Choose Your Length",
    });

    expect(
      await stayFor(listing.id, { day_count: "2", name: "Two Of Three" }),
    ).toEqual({ end: "2026-09-03", start: "2026-09-01" });
  });

  test("refuses one with no day at all", async () => {
    const listing = await dailyListing({ name: "Needs A Day" });

    const { response } = await addTo(listing.id, {
      email: "vague@example.com",
      name: "No Day Given",
      quantity: "1",
    });

    expect(response.status).toBe(302);
    expect(await bookingLine(listing.id)).toBe(null);
  });

  test("refuses a length the listing does not offer", async () => {
    const listing = await dailyListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800 },
      durationDays: 2,
      name: "Only Two",
    });

    const { response } = await addTo(listing.id, {
      date: "2026-09-01",
      day_count: "5",
      email: "toolong@example.com",
      name: "Five Nights",
      quantity: "1",
    });

    expect(response.status).toBe(302);
    expect(await bookingLine(listing.id)).toBe(null);
  });
});

describeWithEnv("an addition that cannot be made", { db: true }, () => {
  test("comes back with the reason rather than a confirmation", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Nameless",
    });

    const { response } = await addTo(listing.id, {
      email: "nameless@example.com",
      quantity: "1",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      expect.stringContaining("required"),
      false,
    )(response);
    expect(await bookingLine(listing.id)).toBe(null);
  });

  test("says so when the listing has no places left", async () => {
    const listing = await createTestListing({
      maxAttendees: 1,
      name: "One Place",
    });
    await addTo(listing.id, {
      email: "first@example.com",
      name: "Got In",
      quantity: "1",
    });

    const { response } = await addTo(listing.id, {
      email: "late@example.com",
      name: "Too Late",
      quantity: "1",
    });

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      t("error.not_enough_spots"),
      false,
    )(response);
  });
});
