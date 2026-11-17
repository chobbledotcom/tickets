import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups/table.ts";
import { requireListingWithCount } from "#db/listings/records.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { submitOwnListingEdit } from "#test-utils/listing-submits.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";

/** A signed-in owner's listing that shares a group with one sibling of the
 *  same type. */
const listingWithSibling = async (listingType: "daily" | "standard") => {
  const group = await createTestGroup({ name: `${listingType} only group` });
  await createTestListing({
    groupId: group.id,
    listingType,
    name: `${listingType} sibling`,
  });
  const { listing } = await setupListingAndLogin({
    groupId: group.id,
    listingType,
    name: `${listingType} candidate`,
  });
  return { groupId: group.id, listing };
};

/** Post the edit with the listing's current group, as the real edit form
 *  does, expect the refusal, and return the listing as it is stored after. */
const refusedRegroup = async (
  { groupId, listing }: Awaited<ReturnType<typeof listingWithSibling>>,
  boxes: TestFormValues,
  message: string,
) => {
  const { response } = await submitOwnListingEdit(listing, {
    groupIds: String(groupId),
    ...boxes,
  });
  await expectHtmlResponse(response, 400, message);
  // Nothing moved: the listing keeps its membership.
  expect(await listingGroups.getIds(listing.id)).toEqual([groupId]);
  return requireListingWithCount(listing.id);
};

describeWithEnv(
  "server listings > edit post group homogeneity",
  { db: true },
  () => {
    describe("POST /admin/listing/:id/edit", () => {
      test("rejects changing a grouped listing's own type on edit", async () => {
        // The flip alone would leave the listing in a group of the other type.
        const stored = await refusedRegroup(
          await listingWithSibling("daily"),
          { listingType: "standard" },
          "already contains daily listings",
        );
        expect(stored.listingType).toBe("daily");
      });

      test("rejects enabling customisable days on a listing whose group mates are fixed-length", async () => {
        const stored = await refusedRegroup(
          await listingWithSibling("standard"),
          { customisableDays: "1", dayPrice1: "1.00" },
          "already contains listings with a fixed number of days",
        );
        expect(stored.customisableDays).toBe(false);
      });
    });
  },
);
