import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  expectFlashRedirect,
  expectListingActivityLogLacks,
} from "#test-utils/assertions.ts";
import { describeWithEnv, rawListingRange } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv("e2e: multi-day bookings — admin pages", { db: true }, () => {
  describe("admin listing edit POST", () => {
    /** Minimal valid edit form for a daily listing (urlencoded POST). */
    const dailyEditForm = (
      listing: { name: string; slug: string },
      durationDays: number,
      groupId = 0,
    ): Record<string, string> => ({
      duration_days: String(durationDays),
      // Membership is carried by the group_ids checkboxes; only send one when the
      // listing is in a group (0 = ungrouped).
      ...(groupId > 0 ? { group_ids: String(groupId) } : {}),
      listing_type: "daily",
      max_attendees: "100",
      max_quantity: "1",
      name: listing.name,
      slug: listing.slug,
      thank_you_url: "https://example.com",
    });

    /**
     * The reconciler's unchanged-duration early return. The story
     * `@case:stay-length.saving-without-a-change-leaves-stays-alone` states
     * the same rule in the organiser's terms; this owns the direct coverage
     * of the branch, which a Cucumber journey may never be the only cover of.
     */
    test("editing a daily listing without changing duration leaves ranges and log alone", async () => {
      const listing = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      await bookAttendee(listing, { date: "2026-09-10", durationDays: 2 });
      const before = await rawListingRange(listing.id);

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        dailyEditForm(listing, 2),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      const after = await rawListingRange(listing.id);
      expect(after!.end_at).toBe(before!.end_at);
      await expectListingActivityLogLacks(listing.id, "duration changed");
    });

    /**
     * A customisable-days listing takes its span from what the buyer chose, so
     * the reconciler must return early and leave every stored range alone. The
     * story `@case:stay-length.customer-chosen-length-survives` states the same
     * rule in the customer's terms; this owns the direct coverage of the branch,
     * which a Cucumber journey may never be the only cover of.
     */
    test("a customisable listing's stored ranges survive a change to its maximum", async () => {
      const listing = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 5,
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      // The visitor chose a 2-day span; that is their booking, not the maximum.
      await bookAttendee(listing, { date: "2026-09-10", durationDays: 2 });
      const before = await rawListingRange(listing.id);

      // The full edit form, so the listing keeps its per-day prices.
      await updateTestListing(listing.id, { durationDays: 4 });

      expect((await getListingWithCount(listing.id))?.duration_days).toBe(4);
      // The maximum changed; the booked span did not.
      expect((await rawListingRange(listing.id))!.end_at).toBe(before!.end_at);
      await expectListingActivityLogLacks(listing.id, "duration changed");
    });
  });
});
