// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { imagesTable, setItemsForImage } from "#shared/db/images.ts";
import { settings } from "#shared/db/settings.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { assertPublicHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket slug GET (group)",
  { db: true, triggers: true },
  () => {
    describe("GET /ticket/:slug", () => {
      test("renders ticket page for group slug", async () => {
        const group = await createTestGroup({
          name: "Public Group",
          slug: "public-group",
        });
        const listing1 = await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Group Listing 1",
        });
        const listing2 = await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Group Listing 2",
        });

        await assertPublicHtml(
          `/ticket/${group.slug}`,
          "Public Group",
          "Continue",
          "Select Tickets",
          "Group Listing 1",
          "Group Listing 2",
          `action="/ticket/${group.slug}"`,
          `quantity_${listing1.id}`,
          `quantity_${listing2.id}`,
        );
      });

      test("shows group name and description on multi-listing group page", async () => {
        const group = await createTestGroup({
          description: "A wonderful festival with multiple listings",
          name: "Festival Group",
          slug: "festival-group",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Festival Listing A",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Festival Listing B",
        });

        await assertPublicHtml(
          `/ticket/${group.slug}`,
          "Festival Group",
          "A wonderful festival with multiple listings",
        );
      });

      test("shows the linked group image on the group ticket page", async () => {
        const group = await createTestGroup({
          name: "Poster Group",
          slug: "poster-group",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Poster Group Listing",
        });
        const image = await imagesTable.insert({
          altText: "Poster group hero",
          filename: nonEmptyString("poster-group.webp"),
          filenameThumb: nonEmptyString("poster-group-thumb.webp"),
          name: "Poster group image",
        });
        await setItemsForImage(image.id, [
          { itemId: group.id, itemType: "group" },
        ]);

        await assertPublicHtml(
          `/ticket/${group.slug}`,
          "/image/poster-group.webp",
          'alt="Poster group hero"',
        );
      });

      test("returns 404 when group has no active listings", async () => {
        const group = await createTestGroup({
          name: "Empty Group",
          slug: "empty-group",
        });
        const listing = await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Inactive In Group",
        });
        await deactivateTestListing(listing.id);

        const response = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        expect(response.status).toBe(404);
      });

      test("group terms override global terms", async () => {
        await settings.update.terms("GLOBAL TERMS UNIQUE");
        const group = await createTestGroup({
          name: "Terms Group",
          slug: "terms-group",
          termsAndConditions: "GROUP TERMS UNIQUE",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Terms Listing",
        });

        const response = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        const html = await response.text();
        expect(html).toContain("GROUP TERMS UNIQUE");
        expect(html).not.toContain("GLOBAL TERMS UNIQUE");
      });

      test("group terms fall back to global when group terms are empty", async () => {
        await settings.update.terms("GLOBAL FALLBACK UNIQUE");
        const group = await createTestGroup({
          name: "Fallback Group",
          slug: "fallback-group",
          termsAndConditions: "",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Fallback Listing",
        });

        const response = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        const html = await response.text();
        expect(html).toContain("GLOBAL FALLBACK UNIQUE");
      });

      test("group page shows shared date selector for daily listings", async () => {
        const group = await createTestGroup({
          name: "Daily Group",
          slug: "daily-group",
        });
        await createTestListing({
          bookableDays: ["Monday"],
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 10,
          maximumDaysAfter: 14,
          minimumDaysBefore: 0,
          name: "Daily A",
        });
        await createTestListing({
          bookableDays: ["Monday", "Tuesday"],
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 10,
          maximumDaysAfter: 14,
          minimumDaysBefore: 0,
          name: "Daily B",
        });

        await assertPublicHtml(
          `/ticket/${group.slug}`,
          "Select Date",
          'name="date"',
        );
      });
    });
  },
);
