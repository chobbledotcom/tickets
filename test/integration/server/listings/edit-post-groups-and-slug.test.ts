import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups/table.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { renderListingEditError } from "#routes/admin/listings-edit-save.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  submitListingEdit,
  submitOwnListingEdit,
} from "#test-utils/listing-submits.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";

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
        submitOwnListingEdit(listing, {
          group_ids: String(groupId),
        });

      const expectListingUpdated = (id: number, response: Response) =>
        expectFlashRedirect(
          `/admin/listing/${id}`,
          "Listing updated",
        )(response);

      /** Move the listing into the group, and expect the save to land with
       *  the group as its only membership. */
      const expectMovedInto = async (
        listing: { id: number; name: string; slug: string },
        groupId: number,
      ): Promise<void> => {
        const { response } = await postEditWithGroupId(listing, groupId);
        await expectListingUpdated(listing.id, response);
        expect(await listingGroups.getIds(listing.id)).toEqual([groupId]);
      };

      test("updates listing group_id", async () => {
        const group1 = await createTestGroup({ name: "Group One" });
        const group2 = await createTestGroup({ name: "Group Two" });
        const { listing } = await setupListingAndLogin({
          groupId: group1.id,
          name: "Group Switch Listing",
        });
        // The group checkboxes replace membership: group1 → group2.
        await expectMovedInto(listing, group2.id);
      });

      test("rejects non-existent group_id on edit", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 50,
          name: "Edit Bad Group",
        });

        const { response } = await postEditWithGroupId(listing, 999);
        await expectHtmlResponse(
          response,
          400,
          t("error.selected_group_deleted"),
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
        assertStringIncludes(
          html,
          `checked name="group_ids" type="checkbox" value="${group.id}"`,
        );
      });

      /** A group that holds one listing of the given type, and a standard
       *  listing to move into it. */
      const standardListingBesideGroupOf = async (
        listingType: "daily" | "standard",
      ) => {
        const group = await createTestGroup({ name: `${listingType} group` });
        await createTestListing({
          groupId: group.id,
          listingType,
          name: `${listingType} member`,
        });
        const { listing } = await setupListingAndLogin({
          listingType: "standard",
          name: "Standard Listing",
        });
        return { group, listing };
      };

      test("rejects listing type mismatch with group on edit", async () => {
        const { group, listing } = await standardListingBesideGroupOf("daily");

        const { response } = await postEditWithGroupId(listing, group.id);
        const html = await expectHtmlResponse(
          response,
          400,
          "already contains daily listings",
        );
        // The rejected edit re-renders the group the operator ticked as checked,
        // so their selection isn't silently dropped on the next submit.
        assertStringIncludes(
          html,
          `checked name="group_ids" type="checkbox" value="${group.id}"`,
        );
      });

      test("allows same listing type in group on edit", async () => {
        const { group, listing } =
          await standardListingBesideGroupOf("standard");

        await expectMovedInto(listing, group.id);
      });

      /** Save the listing's own name with the given slug, and expect the save
       *  to land. Returns the slug the listing then stores. */
      const saveSlug = async (
        listing: { id: number; name: string },
        slug: string,
      ): Promise<string | undefined> => {
        const { response } = await submitListingEdit(listing.id, {
          name: listing.name,
          slug,
        });
        await expectListingUpdated(listing.id, response);
        return (await getListingWithCount(listing.id))?.slug;
      };

      test("updates, normalizes, and keeps the slug on update", async () => {
        const { listing } = await setupListingAndLogin({
          name: "Slug Update Test",
        });
        expect([
          await saveSlug(listing, "new-custom-slug"),
          await saveSlug(listing, "  My Custom Slug  "),
          await saveSlug(listing, "my-custom-slug"),
        ]).toEqual(["new-custom-slug", "my-custom-slug", "my-custom-slug"]);
      });

      /** Save the listing's own name with the given slug, and expect the
       *  refusal message. */
      const expectSlugRefused = async (
        listing: { id: number; name: string },
        slug: string,
        message: string,
      ): Promise<void> => {
        const { response } = await submitListingEdit(listing.id, {
          name: listing.name,
          slug,
        });
        await expectHtmlResponse(response, 400, message);
      };

      test("rejects invalid slug characters", async () => {
        const { listing } = await setupListingAndLogin({
          name: "Invalid Slug Test",
        });
        await expectSlugRefused(
          listing,
          "invalid_slug!@#",
          "Slug must be lowercase letters and numbers separated by single hyphens or underscores",
        );
      });

      test("rejects a slug used by another listing or by a group", async () => {
        const other = await createTestListing({ name: "Listing One" });
        const group = await createTestGroup({
          name: "Slug Group",
          slug: "slug-group",
        });
        const { listing } = await setupListingAndLogin({
          name: "Listing Two",
        });
        for (const slug of [other.slug, group.slug]) {
          await expectSlugRefused(
            listing,
            slug,
            "Slug is already in use by another listing",
          );
        }
      });
    });
  },
);
