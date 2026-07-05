// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { ICS_DISCOVERY_TAG, RSS_DISCOVERY_TAG } from "#templates/public.tsx";
import {
  assertPublicHtml,
  bookAttendee,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  mockFormRequest,
  pastCloseTime,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > listings fields and dates",
  { db: true, triggers: true },
  () => {
    describe("GET /listings", () => {
      test("shows sold out for listings at capacity", async () => {
        await settings.update.showPublicSite(true);
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
        expect(html).not.toContain(`href="/ticket/${listing.slug}"`);
        // The "Sold Out" message lives inside the card's prose block as a red
        // Badge, not a bare <p><strong>.
        expect(html).toContain(
          '<div class="prose"><h2>Full Listing</h2><p><span class="badge danger">Sold Out</span></p></div>',
        );
      });

      test("a daily listing full on one date is not sold out date-lessly", async () => {
        // #51: a daily listing's cumulative bookings span every date, so its
        // card and booking page must not claim "sold out" without a date — the
        // date-aware submit gate judges the chosen date instead.
        await settings.update.showPublicSite(true);
        const listing = await createTestListing({
          listingType: "daily",
          maxAttendees: 1,
          minimumDaysBefore: 0,
          name: "Daily Hire",
        });
        await bookAttendee(listing, {
          date: addDays(todayInTz("UTC"), 2),
          email: "first@test.com",
          name: "First",
          quantity: 1,
        });
        const html = await assertPublicHtml("/listings", "Daily Hire");
        expect(html).not.toContain("Sold Out");
        expect(html).toContain(`href="/ticket/${listing.slug}"`);
        // The booking page still offers the date selector rather than a
        // sold-out label.
        const page = await assertPublicHtml(
          `/ticket/${listing.slug}`,
          'name="date"',
        );
        expect(page).not.toContain("Sold Out");
      });

      test("invites a date and answers daily card availability once chosen", async () => {
        // #51: daily cards claim nothing date-lessly, so the page invites a
        // date; with one chosen, each daily card answers for THAT date and a
        // bookable card's CTA carries the date into its booking page.
        await settings.update.showPublicSite(true);
        const date = addDays(todayInTz("UTC"), 2);
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
        expect(unfiltered).not.toContain("Not available on");

        // With a date: the full listing reads honestly unavailable for it, the
        // free one's Book CTA carries the date through.
        const filtered = await assertPublicHtml(
          `/listings?date=${date}`,
          "Not available on",
        );
        expect(filtered).toContain(
          `href="/ticket/${freeDaily.slug}?date=${date}"`,
        );
        expect(filtered).toContain(
          `href="/ticket/${flexDaily.slug}?date=${date}"`,
        );
        expect(filtered).not.toContain(`href="/ticket/${fullDaily.slug}`);
        // The "Not available on" message is a red Badge inside the card's prose.
        expect(filtered).toContain(
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
        expect(garbage).not.toContain("Not available on");

        // The carried date lands pre-selected on the booking page.
        await assertPublicHtml(
          `/ticket/${freeDaily.slug}?date=${date}`,
          `<option value="${date}" selected>`,
        );
      });

      test("shows a package as sold out when its member is unavailable on the searched date", async () => {
        await settings.update.showPublicSite(true);
        const date = addDays(todayInTz("UTC"), 2);
        const pkg = await createTestGroup({
          isPackage: true,
          name: "Weekend Package",
          slug: "weekend-package",
        });
        const packageDaily = await createTestListing({
          groupId: pkg.id,
          listingType: "daily",
          maxAttendees: 1,
          minimumDaysBefore: 0,
          name: "Package Daily",
        });
        await bookAttendee(packageDaily, { date, quantity: 1 });
        // A standalone listing keeps the page non-empty.
        await createTestListing({
          maxAttendees: 50,
          name: "Standalone Listing",
        });

        const filtered = await assertPublicHtml(
          `/listings?date=${date}`,
          "Weekend Package",
          "Standalone Listing",
        );
        expect(filtered).not.toContain(`href="/ticket/${pkg.slug}"`);
        expect(filtered.indexOf("Standalone Listing")).toBeLessThan(
          filtered.indexOf("Unavailable"),
        );
        expect(filtered.indexOf("Unavailable")).toBeLessThan(
          filtered.indexOf("Weekend Package"),
        );

        // On a date the member CAN serve, the package still books normally.
        const otherDate = addDays(todayInTz("UTC"), 3);
        const available = await assertPublicHtml(
          `/listings?date=${otherDate}`,
          "Weekend Package",
        );
        expect(available).toContain(`href="/ticket/${pkg.slug}"`);
      });

      test("one full member is enough to mark a multi-member package sold out for the date", async () => {
        // A package books as one whole bundle — every member together — so a
        // single member with no room on the searched date makes the whole
        // package unbookable that day, even while its other members are free.
        await settings.update.showPublicSite(true);
        const date = addDays(todayInTz("UTC"), 2);
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
        expect(filtered).not.toContain(`href="/ticket/${pkg.slug}"`);
        expect(filtered).toContain(`href="/ticket/${openPkg.slug}"`);
        expect(filtered.indexOf("Open Package")).toBeLessThan(
          filtered.indexOf("Unavailable"),
        );
        expect(filtered.indexOf("Unavailable")).toBeLessThan(
          filtered.indexOf("Bundle Package"),
        );
      });

      test("shows no date filter when no daily listings are listed", async () => {
        await settings.update.showPublicSite(true);
        await createTestListing({ maxAttendees: 5, name: "Standard Only" });
        const html = await assertPublicHtml("/listings", "Standard Only");
        expect(html).not.toContain("listings-date-filter");
      });

      test("shows registration closed for listings past closes_at", async () => {
        await settings.update.showPublicSite(true);
        await createTestListing({
          closesAt: pastCloseTime(),
          maxAttendees: 100,
          name: "Closed Listing",
        });
        await assertPublicHtml("/listings", "Registration Closed");
      });

      test("shows listing location when set", async () => {
        await settings.update.showPublicSite(true);
        await createTestListing({
          location: "Town Hall",
          maxAttendees: 100,
          name: "Located Listing",
        });
        await assertPublicHtml("/listings", "Town Hall");
      });

      test("shows listing date when set", async () => {
        await settings.update.showPublicSite(true);
        await createTestListing({
          date: "2026-06-15T14:00",
          maxAttendees: 100,
          name: "Dated Listing",
        });
        await assertPublicHtml("/listings", "2026");
      });

      test("shows listing description when set", async () => {
        await settings.update.showPublicSite(true);
        await createTestListing({
          description: "A great listing",
          maxAttendees: 100,
          name: "Described Listing",
        });
        await assertPublicHtml("/listings", "A great listing");
      });

      test("shows website title on listings page", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.websiteTitle("My Listings Site");
        await createTestListing({ maxAttendees: 100, name: "Concert" });
        await assertPublicHtml("/listings", "My Listings Site");
      });

      test("shows public nav on listings page", async () => {
        await settings.update.showPublicSite(true);
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
        await settings.update.showPublicSite(true);
        const response = await handleRequest(
          mockFormRequest("/listings", { name: "Test" }),
        );
        expect(response.status).toBe(404);
      });

      test("includes RSS and ICS feed discovery tags", async () => {
        await settings.update.showPublicSite(true);
        await assertPublicHtml(
          "/listings",
          RSS_DISCOVERY_TAG,
          ICS_DISCOVERY_TAG,
        );
      });
    });
  },
);
