// jscpd:ignore-start

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { icsDiscoveryTag, rssDiscoveryTag } from "#templates/public/shared.tsx";
import { assertPublicHtml } from "#test-utils/assertions.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > listings fields and dates",
  { db: true, triggers: true },
  () => {
    describe("GET /listings", () => {
      test("shows sold out for listings at capacity", async () => {
        await enablePublicSite();
        const listing = await createTestListing({
          maxAttendees: 1,
          name: "Full Listing",
        });
        await bookAttendee(listing, {
          email: "a@test.com",
          name: "Attendee",
          quantity: 1,
        });
        const html = await assertPublicHtml("/listings", "Sold Out");
        assert(
          !html.includes(`href="/ticket/${listing.slug}"`),
          "the value should not contain the searched item",
        );
        // The "Sold Out" message lives inside the card's prose block as a red
        // Badge, not a bare <p><strong>.
        assertStringIncludes(
          html,
          '<div class="prose"><h2>Full Listing</h2><p><span class="badge danger">Sold Out</span></p></div>',
        );
      });

      test("a daily listing full on one date is not sold out date-lessly", async () => {
        // #51: a daily listing's cumulative bookings span every date, so its
        // card and booking page must not claim "sold out" without a date — the
        // date-aware submit gate judges the chosen date instead.
        await enablePublicSite();
        const listing = await createTestListing({
          listingType: "daily",
          maxAttendees: 1,
          minimumDaysBefore: 0,
          name: "Daily Hire",
        });
        await bookAttendee(listing, {
          date: addDays(testDate(todayInTz("UTC")), 2),
          email: "first@test.com",
          name: "First",
          quantity: 1,
        });
        const html = await assertPublicHtml("/listings", "Daily Hire");
        assert(
          !html.includes("Sold Out"),
          "the value should not contain the searched item",
        );
        assertStringIncludes(html, `href="/ticket/${listing.slug}"`);
        // The booking page still offers the date selector rather than a
        // sold-out label.
        const page = await assertPublicHtml(
          `/ticket/${listing.slug}`,
          'name="date"',
        );
        assert(
          !page.includes("Sold Out"),
          "the value should not contain the searched item",
        );
      });

      test("invites a date and answers daily card availability once chosen", async () => {
        // #51: daily cards claim nothing date-lessly, so the page invites a
        // date; with one chosen, each daily card answers for THAT date and a
        // bookable card's CTA carries the date into its booking page.
        await enablePublicSite();
        const date = addDays(testDate(todayInTz("UTC")), 2);
        const fullDaily = await createTestListing({
          listingType: "daily",
          maxAttendees: 1,
          minimumDaysBefore: 0,
          name: "Full Daily",
        });
        const freeDaily = await createTestListing({
          durationDays: 2,
          listingType: "daily",
          maxAttendees: 5,
          minimumDaysBefore: 0,
          name: "Free Daily",
        });
        // A customisable listing books per-day starts, so its card is judged
        // over a 1-day span (a distinct remaining query from freeDaily's 2-day
        // one).
        const flexDaily = await createTestListing({
          customisableDays: true,
          dayPrices: { 1: 500, 2: 900 },
          durationDays: 2,
          listingType: "daily",
          maxAttendees: 5,
          minimumDaysBefore: 0,
          name: "Flex Daily",
          unitPrice: 500,
        });
        await bookAttendee(fullDaily, { date, quantity: 1 });

        // Without a date: the filter form renders and no card claims anything.
        const unfiltered = await assertPublicHtml(
          "/listings",
          "listings-date-filter",
        );
        assert(
          !unfiltered.includes("Not available on"),
          "the value should not contain the searched item",
        );

        // With a date: the full listing reads honestly unavailable for it, the
        // free one's Book CTA carries the date through.
        const filtered = await assertPublicHtml(
          `/listings?date=${date}`,
          "Not available on",
        );
        assertStringIncludes(
          filtered,
          `href="/ticket/${freeDaily.slug}?date=${date}"`,
        );
        assertStringIncludes(
          filtered,
          `href="/ticket/${flexDaily.slug}?date=${date}"`,
        );
        assert(
          !filtered.includes(`href="/ticket/${fullDaily.slug}`),
          "the value should not contain the searched item",
        );
        // The "Not available on" message is a red Badge inside the card's prose.
        assertStringIncludes(
          filtered,
          '<span class="badge danger">Not available on',
        );
        // The unavailable card moves into its own section below the available
        // ones rather than staying interleaved among them.
        expect(filtered.indexOf("Free Daily")).toBeLessThan(
          filtered.indexOf("Unavailable"),
        );
        expect(filtered.indexOf("Unavailable")).toBeLessThan(
          filtered.indexOf("Full Daily"),
        );

        // A malformed date is ignored rather than trusted.
        const garbage = await assertPublicHtml("/listings?date=2026-02-30");
        assert(
          !garbage.includes("Not available on"),
          "the value should not contain the searched item",
        );

        // The carried date lands pre-selected on the booking page.
        await assertPublicHtml(
          `/ticket/${freeDaily.slug}?date=${date}`,
          `<option value="${date}" selected>`,
        );
      });

      test("one full member is enough to mark a multi-member package sold out for the date", async () => {
        // A package books as one whole bundle — every member together — so a
        // single member with no room on the searched date makes the whole
        // package unbookable that day, even while its other members are free.
        await enablePublicSite();
        const date = addDays(testDate(todayInTz("UTC")), 2);
        const pkg = await createTestGroup({
          isPackage: true,
          name: "Bundle Package",
          slug: "bundle-package",
        });
        await createTestListing({
          groupId: pkg.id,
          maxAttendees: 50,
          name: "Roomy Member",
        });
        const fullMember = await createTestListing({
          groupId: pkg.id,
          listingType: "daily",
          maxAttendees: 1,
          minimumDaysBefore: 0,
          name: "Tight Member",
        });
        await bookAttendee(fullMember, { date, quantity: 1 });
        // A package of only date-less members answers the same search without
        // any per-date lookup — and stays bookable.
        const openPkg = await createTestGroup({
          isPackage: true,
          name: "Open Package",
          slug: "open-package",
        });
        await createTestListing({
          groupId: openPkg.id,
          maxAttendees: 50,
          name: "Open Member",
        });

        const filtered = await assertPublicHtml(
          `/listings?date=${date}`,
          "Bundle Package",
          "Open Package",
        );
        assert(
          !filtered.includes(`href="/ticket/${pkg.slug}"`),
          "the value should not contain the searched item",
        );
        assertStringIncludes(filtered, `href="/ticket/${openPkg.slug}"`);
        expect(filtered.indexOf("Open Package")).toBeLessThan(
          filtered.indexOf("Unavailable"),
        );
        expect(filtered.indexOf("Unavailable")).toBeLessThan(
          filtered.indexOf("Bundle Package"),
        );
      });

      test("a date search splits out a sold-out package and member", async () => {
        await enablePublicSite();
        const date = addDays(testDate(todayInTz("UTC")), 2);
        const pkg = await createTestGroup({
          isPackage: true,
          name: "Hidden Member Package",
          slug: "hidden-member-package",
        });
        const member = await createTestListing({
          groupId: pkg.id,
          listingType: "daily",
          maxAttendees: 1,
          minimumDaysBefore: 0,
          name: "Hidden Daily Member",
        });
        const { groups } = await import("#db/groups.ts");
        await groups.table.update(pkg.id, { hidePackageListings: true });
        await bookAttendee(member, { date, quantity: 1 });
        await createTestListing({ maxAttendees: 50, name: "Plain Listing" });

        const filtered = await assertPublicHtml(
          `/listings?date=${date}`,
          "Hidden Member Package",
          "Plain Listing",
        );
        assertStringIncludes(filtered, "listings-date-filter");
        assert(
          !filtered.includes(`href="/ticket/${pkg.slug}"`),
          "the value should not contain the searched item",
        );
        expect(filtered.indexOf("Plain Listing")).toBeLessThan(
          filtered.indexOf("Unavailable"),
        );
        expect(filtered.indexOf("Unavailable")).toBeLessThan(
          filtered.indexOf("Hidden Member Package"),
        );
      });

      test("shows registration closed for listings past closes_at", async () => {
        await enablePublicSite();
        await createTestListing({
          closesAt: pastCloseTime(),
          maxAttendees: 100,
          name: "Closed Listing",
        });
        await assertPublicHtml("/listings", "Registration Closed");
      });

      test("shows listing location when set", async () => {
        await enablePublicSite();
        await createTestListing({
          location: "Town Hall",
          maxAttendees: 100,
          name: "Located Listing",
        });
        await assertPublicHtml("/listings", "Town Hall");
      });

      test("shows listing date when set", async () => {
        await enablePublicSite();
        await createTestListing({
          date: "2026-06-15T14:00",
          maxAttendees: 100,
          name: "Dated Listing",
        });
        await assertPublicHtml("/listings", "2026");
      });

      test("shows listing description when set", async () => {
        await enablePublicSite();
        await createTestListing({
          description: "A great listing",
          maxAttendees: 100,
          name: "Described Listing",
        });
        await assertPublicHtml("/listings", "A great listing");
      });

      test("shows website title on listings page", async () => {
        await enablePublicSite();
        await settings.update.websiteTitle("My Listings Site");
        await createTestListing({ maxAttendees: 100, name: "Concert" });
        await assertPublicHtml("/listings", "My Listings Site");
      });

      test("shows public nav on listings page", async () => {
        await enablePublicSite();
        await settings.update.terms("Some terms");
        await settings.update.contactPageText("Contact us");
        await assertPublicHtml(
          "/listings",
          'href="/"',
          'href="/listings"',
          'href="/terms"',
          'href="/contact"',
        );
      });

      test("returns 404 for POST requests", async () => {
        await enablePublicSite();
        const response = await handleRequest(
          mockFormRequest("/listings", { name: "Test" }),
        );
        expect(response.status).toBe(404);
      });

      test("includes RSS and ICS feed discovery tags", async () => {
        await enablePublicSite();
        await assertPublicHtml(
          "/listings",
          rssDiscoveryTag(),
          icsDiscoveryTag(),
        );
      });
    });
  },
);
