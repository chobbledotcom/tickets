import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { optionChosen } from "#test/specs/support/form-controls/reading.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  allDays,
  bookableStartDates,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** The booking rows of one listing, with their day windows. */
const rawRows = async (
  listingId: number,
): Promise<{ attendee_id: number; start_at: string | null }[]> => {
  const { queryAll } = await import("#db/client.ts");
  return queryAll(
    "SELECT attendee_id, start_at FROM listing_attendees WHERE listing_id = ? ORDER BY attendee_id",
    [listingId],
  );
};

/** The minimal valid edit form for a switch to booked by the day: the fields
 * the real form always submits, at the listing's stored values — the day
 * boxes (one field per ticked day, as a browser sends a checkbox group), the
 * calendar window, and the stored capacity. */
const switchForm = (
  listing: { name: string; slug: string; max_attendees: number },
  extra: Record<string, string> = {},
): TestFormValues => ({
  bookable_days: allDays,
  duration_days: "1",
  listing_type: "daily",
  max_attendees: String(listing.max_attendees),
  max_quantity: "1",
  maximum_days_after: "90",
  minimum_days_before: "1",
  name: listing.name,
  slug: listing.slug,
  thank_you_url: "https://example.com",
  ...extra,
});

/** A two-place listing with both places taken by undated bookings — the
 * sold-out state a switch must not silently reopen. */
const hallWithTwoBookings = async () => {
  const listing = await createTestListing({ maxAttendees: 2, name: "Hall" });
  await bookAttendee(listing, { quantity: 1 });
  await bookAttendee(listing, {
    email: "y@example.com",
    name: "Y",
    quantity: 1,
  });
  return listing;
};

/** Save the confirmed switch for `day`, and assert the flash names the two
 * moved bookings and the listing now reads as a daily one. */
const confirmSwitchOfTwo = async (
  listing: { id: number; max_attendees: number; name: string; slug: string },
  day: string,
): Promise<void> => {
  const { response } = await adminFormPost(
    `/admin/listing/${listing.id}/edit`,
    switchForm(listing, { assign_undated_to: day }),
  );
  await expectFlashRedirect(
    `/admin/listing/${listing.id}`,
    t("listings_table.listing_updated", {
      warning: t("listings_table.switch_daily_undated_given_suffix", {
        count: 2,
        date: day,
      }),
    }),
  )(response);
  expect((await getListingWithCount(listing.id))?.listing_type).toBe("daily");
};

describeWithEnv(
  "e2e: multi-day bookings — switching to daily with undated bookings",
  { db: true },
  () => {
    test("the switch serves the assign page and saves nothing", async () => {
      const listing = await hallWithTwoBookings();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        switchForm(listing),
      );
      expect(response.status).toBe(200);
      const gatePage = await response.text();
      expect(gatePage).toContain(
        t("listings_table.switch_daily_undated_heading", { count: 2 }),
      );
      expect(gatePage).toContain("assign_undated_to");

      // Nothing was written: the listing is still standard and both rows
      // still carry no day.
      expect((await getListingWithCount(listing.id))?.listing_type).toBe(
        "standard",
      );
      const rows = await rawRows(listing.id);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.start_at).toBeNull();
    });

    test("a chosen date moves every undated booking and completes the switch", async () => {
      const listing = await hallWithTwoBookings();
      const day = (await bookableStartDates(listing.id))[0]!;
      await confirmSwitchOfTwo(listing, day);

      const rows = await rawRows(listing.id);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.start_at).not.toBeNull();
      // Both rows were given the chosen day, so the per-day count reads them
      // now: the listing is full on that day and open on the next one.
      expect(await attendeesApi.hasAvailableSpots(listing.id, 1, day, 1)).toBe(
        false,
      );
      const nextDay = (await bookableStartDates(listing.id))[1]!;
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, nextDay, 1),
      ).toBe(true);
    });

    test("a switch that leaves an overflowing group behind still moves the bookings", async () => {
      // The listing sits in a group whose cap its places already overflow.
      // The switch save itself carries no ticked group, so it removes the
      // membership — the move must judge the group set the save leaves
      // behind, not the one the listing is still in while the save runs.
      const listing = await hallWithTwoBookings();
      const { assignListingsToGroup } = await import(
        "#db/groups/membership/package-writes.ts"
      );
      const { createTestGroup, listingGroupIdsOf } = await import(
        "#test-utils/db-helpers/groups.ts"
      );
      const group = await createTestGroup({
        maxAttendees: 1,
        name: "Already full",
      });
      await assignListingsToGroup([listing.id], group.id);

      const day = (await bookableStartDates(listing.id))[0]!;
      await confirmSwitchOfTwo(listing, day);

      const rows = await rawRows(listing.id);
      for (const row of rows) expect(row.start_at).not.toBeNull();
      expect(await listingGroupIdsOf(listing.id)).toEqual([]);
    });

    test("a date without room is refused with its reason and nothing moves", async () => {
      const listing = await hallWithTwoBookings();
      const day = (await bookableStartDates(listing.id))[0]!;
      // The dateless cap would refuse a third booking, so it is widened for
      // the setup only: one booking then takes the chosen day, and the cap
      // goes back to 2 — too small for the two moves of 1 place each.
      const { queryAll } = await import("#db/client.ts");
      await queryAll("UPDATE listings SET max_attendees = 3 WHERE id = ?", [
        listing.id,
      ]);
      await bookAttendee(listing, {
        email: "z@example.com",
        name: "Z",
        quantity: 1,
      });
      await queryAll("UPDATE listings SET max_attendees = 2 WHERE id = ?", [
        listing.id,
      ]);
      const undated = await queryAll<{ attendee_id: number }>(
        "SELECT attendee_id FROM listing_attendees WHERE listing_id = ? AND start_at IS NULL",
        [listing.id],
      );
      await queryAll(
        "UPDATE listing_attendees SET start_at = ?, end_at = ? WHERE attendee_id = ?",
        [`${day}T00:00:00Z`, `${day}T23:59:59Z`, undated[0]!.attendee_id],
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        switchForm(listing, { assign_undated_to: day }),
      );
      expect(response.status).toBe(400);
      const page = await response.text();
      expect(page).toContain(
        t("listings_table.switch_daily_undated_refused", {
          count: 2,
          date: day,
          name: "Hall",
        }),
      );

      // The refusal left everything as it stood.
      expect((await getListingWithCount(listing.id))?.listing_type).toBe(
        "standard",
      );
      const rows = await rawRows(listing.id);
      const moved = rows.filter((row) => row.start_at !== null);
      expect(moved).toHaveLength(1);
    });

    test("the page says so plainly when no date can hold the bookings", async () => {
      const listing = await hallWithTwoBookings();
      // The cap drops after the setup, so no offered day can hold the two
      // bookings the switch would have to move.
      const { queryAll } = await import("#db/client.ts");
      await queryAll("UPDATE listings SET max_attendees = 1 WHERE id = ?", [
        listing.id,
      ]);

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        switchForm({ ...listing, max_attendees: 1 }),
      );
      expect(response.status).toBe(200);
      const page = await response.text();
      expect(page).toContain(
        t("listings_table.switch_daily_undated_none_fits", { count: 2 }),
      );
    });

    test("the admin JSON API refuses the switch with its reason", async () => {
      const listing = await hallWithTwoBookings();

      const { apiRequest } = await import("#test-utils/session.ts");
      const response = await apiRequest(`/api/admin/listings/${listing.id}`, {
        body: { listing_type: "daily" },
        method: "PUT",
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe(
        t("listings_table.switch_daily_undated_guard", { count: 2 }),
      );
      expect((await getListingWithCount(listing.id))?.listing_type).toBe(
        "standard",
      );
    });

    test("an ordinary save of a listing with undated bookings is not refused", async () => {
      const listing = await hallWithTwoBookings();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        switchForm(listing, { listing_type: "standard" }),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);
      expect((await getListingWithCount(listing.id))?.listing_type).toBe(
        "standard",
      );
    });

    test("the assign page carries the pending switch, not the stored row", async () => {
      // The organiser's switch save raised room and chose daily; the page the
      // gate serves must still submit those values, or the confirm save would
      // quietly write the stored row back and drop the switch.
      const listing = await hallWithTwoBookings();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        switchForm(listing, { max_attendees: "1" }),
      );
      expect(response.status).toBe(200);
      const page = await response.text();
      const room =
        page.match(/name="max_attendees"[^>]*value="([^"]*)"/)?.[1] ??
        page.match(/value="([^"]*)"[^>]*name="max_attendees"/)?.[1];
      expect(room).toBe("1");
      const type = optionChosen(page, "listing_type");
      // The type select carries the organiser's switch, not the stored row.
      expect(type).toBe("daily");
    });

    test("a switch form that fails validation stops with the edit error", async () => {
      const listing = await hallWithTwoBookings();
      const { postListingEdit } = await import(
        "#test-utils/listing-parents/helpers.ts"
      );
      const response = await postListingEdit(listing.id, {
        listingType: "daily",
        name: "",
      });
      expect(response.status).toBe(400);
      const page = await response.text();
      // The edit error page, not the assign card: the form never parsed.
      expect(page).toContain("Listing name is required");
    });

    test("a confirmed switch that strips the page's reach is refused", async () => {
      // The listing is a child page that sells an opt-in add-on. Unchecking
      // "bookable by itself" takes its page away, so the reachability guard
      // refuses the confirmed switch and the assign page carries the reason.
      const parent = await createTestListing({
        bookableDays: allDays,
        durationDays: 2,
        listingType: "daily",
        name: "Parent page",
      });
      const listing = await hallWithTwoBookings();
      await (await import("#test-utils/parents.ts")).postChildren(parent.id, [
        listing.id,
      ]);
      const { optInAddOnForListings } = await import(
        "#test-utils/modifiers.ts"
      );
      // The add-on links after the edge, mirroring the solo-child fixture: an
      // edge created under an existing add-on is refused outright.
      await optInAddOnForListings("Listing extra", [listing.id]);

      const { postListingEdit } = await import(
        "#test-utils/listing-parents/helpers.ts"
      );
      const day = (await bookableStartDates(listing.id))[0]!;
      const response = await postListingEdit(listing.id, {
        assignUndatedTo: day!,
        bookableAlone: false,
        durationDays: 2,
        listingType: "daily",
      });
      expect(response.status).toBe(400);
      const page = await response.text();
      expect(page).toContain("assign_undated_to");
      expect(page).toContain("Listing extra");
    });
  },
);
