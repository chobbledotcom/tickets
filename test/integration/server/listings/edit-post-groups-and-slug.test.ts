// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { renderListingEditError } from "#routes/admin/listings-edit.ts";
import { listingGroups } from "#shared/db/groups.ts";
import {
  getListingWithCount,
  requireListingWithCount,
} from "#shared/db/listings/records.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv(
  "server listings > edit post groups and slug",
  { db: true },
  () => {
    describe("POST /admin/listing/:id/edit", () => {
      /** Posts an edit that assigns `listing` to a single group, keeping its
       *  other required fields unchanged — shared by the group-membership
       *  edit tests below. */
      const postEditWithGroupId = (
        listing: { id: number; name: string; slug: string },
        groupId: number,
      ) =>
        adminFormPost(`/admin/listing/${listing.id}/edit`, {
          group_ids: String(groupId),
          max_attendees: "50",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        });

      test("updates listing group_id", async () => {
        const group1 = await createTestGroup({
          name: "Group One",
          slug: "group-one",
        });
        const group2 = await createTestGroup({
          name: "Group Two",
          slug: "group-two",
        });
        const { listing } = await setupListingAndLogin({
          groupId: group1.id,
          maxAttendees: 50,
          name: "Group Switch Listing",
        });
        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            group_ids: String(group2.id),
            max_attendees: "50",
            max_quantity: "1",
            name: listing.name,
            slug: listing.slug,
          },
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "Listing updated",
        )(response);

        // The group checkboxes replace membership: group1 → group2.
        expect(await listingGroups.getIds(listing.id)).toEqual([group2.id]);
      });

      test("rejects non-existent group_id on edit", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 50,
          name: "Edit Bad Group",
        });

        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            group_ids: "999",
            max_attendees: "50",
            max_quantity: "1",
            name: listing.name,
            slug: listing.slug,
          },
        );
        await expectHtmlResponse(
          response,
          400,
          "Selected group does not exist",
        );
      });

      test("renders a rejected edit directly with its submitted groups", async () => {
        const group = await createTestGroup({ name: "Direct group" });
        const { listing } = await setupListingAndLogin({ name: "Direct edit" });
        const response = await renderListingEditError(
          listing.id,
          {
            adminLevel: "owner",
            token: "test",
            userId: 1,
            wrappedDataKey: null,
          },
          new FormParams({ group_ids: String(group.id) }),
          "Direct rejection",
        );

        const html = await expectHtmlResponse(
          response,
          400,
          "Direct rejection",
        );
        expect(html).toContain(
          `checked name="group_ids" type="checkbox" value="${group.id}"`,
        );
      });

      test("rejects listing type mismatch with group on edit", async () => {
        const group = await createTestGroup({
          name: "Daily Group",
          slug: "daily-group",
        });
        await createTestListing({
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 50,
          name: "Daily Listing",
        });
        const { listing } = await setupListingAndLogin({
          listingType: "standard",
          maxAttendees: 50,
          name: "Standard Listing",
        });

        const { response } = await postEditWithGroupId(listing, group.id);
        const html = await expectHtmlResponse(
          response,
          400,
          "already contains daily listings",
        );
        // The rejected edit re-renders the group the operator ticked as checked,
        // so their selection isn't silently dropped on the next submit.
        expect(html).toContain(
          `checked name="group_ids" type="checkbox" value="${group.id}"`,
        );
      });

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

      test("allows same listing type in group on edit", async () => {
        const group = await createTestGroup({
          name: "Same Type Group",
          slug: "same-type-group",
        });
        await createTestListing({
          groupId: group.id,
          listingType: "standard",
          maxAttendees: 50,
          name: "Standard A",
        });
        const { listing } = await setupListingAndLogin({
          listingType: "standard",
          maxAttendees: 50,
          name: "Standard B",
        });

        const { response } = await postEditWithGroupId(listing, group.id);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "Listing updated",
        )(response);
      });

      test("updates listing slug", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Slug Update Test",
          thankYouUrl: "https://example.com",
        });

        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            max_attendees: "100",
            max_quantity: "1",
            name: "Slug Update Test",
            slug: "new-custom-slug",
            thank_you_url: "https://example.com",
          },
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "Listing updated",
        )(response);

        const updated = await getListingWithCount(listing.id);
        expect(updated?.slug).toBe("new-custom-slug");
      });

      test("normalizes slug on update (spaces, uppercase)", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 50,
          name: "Normalize Test",
        });

        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            max_attendees: "50",
            max_quantity: "1",
            name: "Normalize Test",
            slug: "  My Custom Slug  ",
          },
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "Listing updated",
        )(response);

        const updated = await getListingWithCount(listing.id);
        expect(updated?.slug).toBe("my-custom-slug");
      });

      test("rejects invalid slug characters", async () => {
        await setupListingAndLogin({
          maxAttendees: 50,
          name: "Invalid Slug Test",
        });

        const { response } = await adminFormPost("/admin/listing/1/edit", {
          max_attendees: "50",
          max_quantity: "1",
          name: "Invalid Slug Test",
          slug: "invalid_slug!@#",
        });
        await expectHtmlResponse(
          response,
          400,
          "Slug must be lowercase letters and numbers separated by single hyphens or underscores",
        );
      });

      test("rejects duplicate slug used by another listing", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Listing One",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Listing Two",
        });

        // Try to change listing2's slug to listing1's slug
        const { response } = await adminFormPost(
          `/admin/listing/${listing2.id}/edit`,
          {
            max_attendees: "50",
            max_quantity: "1",
            name: "Listing Two",
            slug: listing1.slug,
          },
        );
        await expectHtmlResponse(
          response,
          400,
          "Slug is already in use by another listing",
        );
      });

      test("rejects slug used by a group", async () => {
        const group = await createTestGroup({
          name: "Slug Group",
          slug: "slug-group",
        });
        const { listing } = await setupListingAndLogin({
          maxAttendees: 50,
          name: "Listing Slug Collision",
        });

        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            max_attendees: "50",
            max_quantity: "1",
            name: listing.name,
            slug: group.slug,
          },
        );
        await expectHtmlResponse(
          response,
          400,
          "Slug is already in use by another listing",
        );
      });

      test("allows keeping the same slug on update", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 50,
          name: "Same Slug Test",
        });

        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/edit`,
          {
            max_attendees: "100",
            max_quantity: "1",
            name: "Same Slug Test",
            slug: listing.slug,
          },
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "Listing updated",
        )(response);

        const updated = await getListingWithCount(listing.id);
        expect(updated?.slug).toBe(listing.slug);
        expect(updated?.max_attendees).toBe(100);
      });
    });
  },
);
