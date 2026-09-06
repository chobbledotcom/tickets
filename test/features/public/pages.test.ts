// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { assertPublicHtml, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv("public listing pages", { db: true, triggers: true }, () => {
  describe("the address itself", () => {
    test("redirects the legacy /events address to /listings", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/events"));
      expectRedirect(response, /^\/listings$/);
    });

    test("leaves a deeper legacy path alone", async () => {
      // Only the bare address moved; /events/archive was never a page here.
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/events/archive"));
      expect(response.status).toBe(404);
    });

    test("sends a visitor to sign in while the site is not public", async () => {
      const response = await handleRequest(mockRequest("/listings"));
      expectRedirect(response, /^\/admin\/login$/);
    });
  });

  describe("the empty page", () => {
    test("says there is nothing, under the site's name, with no way in", async () => {
      // The login footer is a homepage-only affordance (#69), so /listings
      // never carries it.
      await enablePublicSite();
      await settings.update.websiteTitle("My Listings");
      const html = await assertPublicHtml(
        "/listings",
        "No listings listed.",
        "My Listings",
      );
      expect(html).not.toContain('href="/admin/login"');
    });
  });

  describe("the terms page", () => {
    test("shows the configured terms", async () => {
      await enablePublicSite();
      await settings.update.terms("Use the venue with care.");
      await assertPublicHtml("/terms", "Use the venue with care.");
    });

    test("returns not found when no terms exist", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/terms"));
      expect(response.status).toBe(404);
    });
  });

  describe("the call to action on a card", () => {
    test("offers Book now for a listing people attend and Buy now for one they do not", async () => {
      await enablePublicSite();
      const concert = await createTestListing({
        maxAttendees: 100,
        name: "Concert",
      });
      const raffle = await createTestListing({
        maxAttendees: 100,
        name: "Raffle",
        purchaseOnly: true,
      });

      const html = await assertPublicHtml("/listings", "Concert", "Raffle");
      expect(html).toContain(`href="/ticket/${concert.slug}">Book now`);
      expect(html).toContain(`href="/ticket/${raffle.slug}">Buy now`);
    });

    test("uses the selected stay length for daily capacity", async () => {
      await enablePublicSite();
      const date = addDays(todayInTz("UTC"), 2);
      const secondDay = addDays(date, 1);
      const fixed = await createTestListing({
        durationDays: 2,
        listingType: "daily",
        maxAttendees: 1,
        minimumDaysBefore: 0,
        name: "Fixed stay",
      });
      const flexible = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0 },
        durationDays: 2,
        listingType: "daily",
        maxAttendees: 1,
        minimumDaysBefore: 0,
        name: "Flexible stay",
      });
      await bookAttendee(fixed, { date: secondDay });
      await bookAttendee(flexible, { date: secondDay });

      const html = await assertPublicHtml(
        `/listings?date=${date}`,
        "Fixed stay",
        "Flexible stay",
      );
      expect(html).not.toContain(`href="/ticket/${fixed.slug}?date=${date}"`);
      expect(html).toContain(`href="/ticket/${flexible.slug}?date=${date}"`);
    });

    test("shows no date filter when no daily listings are listed", async () => {
      await enablePublicSite();
      await createTestListing({ maxAttendees: 5, name: "Standard Only" });
      const html = await assertPublicHtml("/listings", "Standard Only");
      expect(html).not.toContain("listings-date-filter");
    });
  });

  describe("what the page leaves out", () => {
    test("drops a listing taken off sale and one kept off the list", async () => {
      await enablePublicSite();
      const offSale = await createTestListing({ name: "Off Sale Listing" });
      await deactivateTestListing(offSale.id);
      await createTestListing({ hidden: true, name: "Secret Listing" });
      await createTestListing({ name: "Visible Listing" });

      const html = await assertPublicHtml("/listings", "Visible Listing");
      expect(html).not.toContain("Off Sale Listing");
      expect(html).not.toContain("Secret Listing");
    });

    test("drops a group kept off the list while keeping its member", async () => {
      await enablePublicSite();
      const group = await createTestGroup({
        hidden: true,
        name: "Secret Group",
        slug: "secret-group",
      });
      await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Visible Listing In Hidden Group",
      });

      const html = await assertPublicHtml(
        "/listings",
        "Visible Listing In Hidden Group",
      );
      expect(html).not.toContain("Secret Group");
    });
  });

  describe("group cards", () => {
    test("marks a package unavailable only on its member's full date", async () => {
      await enablePublicSite();
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
      expect(filtered.indexOf("Unavailable")).toBeLessThan(
        filtered.indexOf("Weekend Package"),
      );

      const otherDate = addDays(todayInTz("UTC"), 3);
      const available = await assertPublicHtml(
        `/listings?date=${otherDate}`,
        "Weekend Package",
      );
      expect(available).toContain(`href="/ticket/${pkg.slug}"`);
    });

    test("shows a group with its description, its way in, and its member", async () => {
      await enablePublicSite();
      const group = await createTestGroup({
        description: "A wonderful summer celebration",
        name: "Summer Festival",
        slug: "summer-festival",
      });
      await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Festival Listing",
      });
      await createTestListing({
        maxAttendees: 50,
        name: "Ungrouped Listing",
      });

      await assertPublicHtml(
        "/listings",
        "Summer Festival",
        "A wonderful summer celebration",
        `href="/ticket/${group.slug}"`,
        "Book now",
        // A grouped listing is still sold on its own, so it keeps its own card.
        "Festival Listing",
        "Ungrouped Listing",
      );
    });

    test("heads the bundles with Packages, in name order, above the rest", async () => {
      await enablePublicSite();
      // Two bundles out of alphabetical order prove the name sort runs.
      for (const [name, slug] of [
        ["Zephyr Bundle", "zephyr-bundle"],
        ["Weekend Bundle", "weekend-bundle"],
      ] as const) {
        const bundle = await createTestGroup({
          isPackage: true,
          name,
          slug,
        });
        await createTestListing({
          groupId: bundle.id,
          maxAttendees: 50,
          name: `${name} Listing`,
        });
      }
      const regular = await createTestGroup({
        name: "Regular Group",
        slug: "regular-group",
      });
      await createTestListing({
        groupId: regular.id,
        maxAttendees: 50,
        name: "Regular Listing",
      });

      const html = await assertPublicHtml("/listings", "Weekend Bundle");
      // Where each word lands, or a stop: a word the page never says would
      // otherwise come back as -1, which sorts below everything and leaves
      // the order looking right.
      const wherePageSays = (word: string): number => {
        const at = html.indexOf(word);
        if (at < 0) throw new Error(`The page never says "${word}"`);
        return at;
      };
      const inOrder = [
        "Packages",
        "Weekend Bundle",
        "Zephyr Bundle",
        "All bookable listings",
        "Regular Group",
      ].map(wherePageSays);
      expect(inOrder).toEqual([...inOrder].toSorted((a, b) => a - b));
    });
  });

  describe("a way in that could only fail", () => {
    /** Assert a group's Book link and name are both absent from the page,
     * with a standalone listing keeping the page non-empty so this proves
     * the GROUP was suppressed rather than the page being empty. */
    const expectGroupSuppressed = async (
      group: { slug: string },
      groupName: string,
    ): Promise<void> => {
      await createTestListing({ maxAttendees: 50, name: "Standalone" });
      const html = await assertPublicHtml("/listings", "Standalone");
      expect(html).not.toContain(`href="/ticket/${group.slug}"`);
      expect(html).not.toContain(groupName);
    };

    test("suppresses a group whose members are all off sale", async () => {
      // Such a group's own page 404s, so a link there could only fail.
      await enablePublicSite();
      const group = await createTestGroup({
        name: "Empty Group",
        slug: "empty-group",
      });
      await expectGroupSuppressed(group, "Empty Group");
    });

    test("suppresses a bundle holding nothing", async () => {
      await enablePublicSite();
      const bundle = await createTestGroup({
        isPackage: true,
        name: "Empty Bundle",
        slug: "empty-bundle",
      });
      await expectGroupSuppressed(bundle, "Empty Bundle");
    });

    /** A bundle of two parts, the second one stuck: with no room left, or
     * taken off sale. A bundle is all or nothing, so either stops it. */
    const bundleWithAStuckPart = async (
      name: string,
      slug: string,
      stuck: "full" | "off sale",
    ) => {
      const bundle = await createTestGroup({ isPackage: true, name, slug });
      // Member names share nothing with the bundle's own name, so asserting
      // the bundle is absent cannot be satisfied by a member instead.
      await createTestListing({
        groupId: bundle.id,
        maxAttendees: 50,
        name: "Tent",
      });
      const second = await createTestListing({
        groupId: bundle.id,
        maxAttendees: stuck === "full" ? 0 : 50,
        name: "Pitch",
      });
      if (stuck === "off sale") await deactivateTestListing(second.id);
      return bundle;
    };

    test("suppresses a bundle whose part has no room left", async () => {
      await enablePublicSite();
      const bundle = await bundleWithAStuckPart(
        "Half Bundle",
        "half-bundle",
        "full",
      );
      await expectGroupSuppressed(bundle, "Half Bundle");
    });

    test("suppresses a bundle whose part is off sale", async () => {
      await enablePublicSite();
      const bundle = await bundleWithAStuckPart(
        "Partial Bundle",
        "partial-bundle",
        "off sale",
      );
      await expectGroupSuppressed(bundle, "Partial Bundle");
    });
  });
});
