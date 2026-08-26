/**
 * Branch cover for the public listings page GET /listings
 *
 * Sits beside the story `@story:catalogue.the-list-a-visitor-reads`, which
 * owns what a visitor finds on the list and which ways in it offers. These
 * touch the render branches behind it — the call-to-action each card picks,
 * the two headings the page splits into, the empty page, the legacy address,
 * and the robots headers a page carries — because a Cucumber run does not
 * count towards coverage.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { assertPublicHtml, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > listings display",
  { db: true, triggers: true },
  () => {
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
        const inOrder = [
          "Packages",
          "Weekend Bundle",
          "Zephyr Bundle",
          "All bookable listings",
          "Regular Group",
        ].map((word) => html.indexOf(word));
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

    describe("robots headers on a thing's own page", () => {
      const robotsTagFor = async (path: string): Promise<Headers> =>
        (await handleRequest(mockRequest(path))).headers;

      test("tells robots to index a listing anybody can find", async () => {
        const listing = await createTestListing();
        expect(
          (await robotsTagFor(`/ticket/${listing.slug}`)).get("x-robots-tag"),
        ).toBe("index, follow");
      });

      test("tells robots to leave a listing kept off the list alone", async () => {
        const listing = await createTestListing({ hidden: true });
        const headers = await robotsTagFor(`/ticket/${listing.slug}`);
        expect(headers.get("x-robots-tag")).toBe("noindex, nofollow");
        // The internal signal the renderer uses to ask for that header must
        // never reach the browser.
        expect(headers.has("x-robots-noindex")).toBe(false);
      });
    });
  },
);
