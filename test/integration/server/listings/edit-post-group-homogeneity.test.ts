import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingGroups } from "#shared/db/groups.ts";
import { requireListingWithCount } from "#shared/db/listings/records.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

describeWithEnv(
  "server listings > edit post group homogeneity",
  { db: true },
  () => {
    describe("POST /admin/listing/:id/edit", () => {
      test("rejects changing a grouped listing's own type on edit", async () => {
        const group = await createTestGroup({
          name: "Daily Only Group",
          slug: "daily-only-group",
        });
        await createTestListing({
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 50,
          name: "Daily Sibling",
        });
        const { listing } = await setupListingAndLogin({
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 50,
          name: "Flip Candidate",
        });

        // The real edit form re-sends the listing's current group_ids, so the
        // flip alone would leave the listing in a group of the other type.
        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            group_ids: String(group.id),
            listing_type: "standard",
            max_attendees: "50",
            max_quantity: "1",
            name: listing.name,
            slug: listing.slug,
          },
        );
        await expectHtmlResponse(
          response,
          400,
          "already contains daily listings",
        );

        // Nothing moved: the listing keeps its type and its membership.
        expect((await requireListingWithCount(listing.id)).listing_type).toBe(
          "daily",
        );
        expect(await listingGroups.getIds(listing.id)).toEqual([group.id]);
      });

      test("rejects enabling customisable days on a listing whose group mates are fixed-length", async () => {
        const group = await createTestGroup({
          name: "Fixed Days Group",
          slug: "fixed-days-group",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Fixed Length Sibling",
        });
        const { listing } = await setupListingAndLogin({
          groupId: group.id,
          maxAttendees: 50,
          name: "Customisable Candidate",
        });

        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            customisable_days: "1",
            day_price_1: "1.00",
            group_ids: String(group.id),
            max_attendees: "50",
            max_quantity: "1",
            name: listing.name,
            slug: listing.slug,
          },
        );
        await expectHtmlResponse(
          response,
          400,
          "already contains listings with a fixed number of days",
        );

        expect(
          (await requireListingWithCount(listing.id)).customisable_days,
        ).toBe(false);
        expect(await listingGroups.getIds(listing.id)).toEqual([group.id]);
      });
    });
  },
);
