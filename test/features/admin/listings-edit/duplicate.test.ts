/**
 * Duplicating a listing that gates other listings behind it.
 *
 * The copy inherits the source's required children, so it behaves like the
 * listing it came from. One case cannot: a hidden package collapses its
 * members to the package name, so a member cannot offer a child selector. The
 * copy is still made, and the operator is told the gate did not come with it.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getAllListings } from "#db/listings/records.ts";
import { t } from "#i18n";
import { parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import { mockMultipartRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

/** Copy a listing through the real create route, the way the duplicate form
 * posts it: a valid create body carrying the hidden `duplicated_from` field. */
const duplicate = async (
  sourceId: number | null,
  name: string,
  groupId?: number,
): Promise<{ copyId: number; message: string | undefined }> => {
  const { csrfToken, cookie } = await getTestSession();
  const { handleRequest } = await import("#routes");
  const response = await handleRequest(
    mockMultipartRequest(
      "/admin/listing",
      {
        ...baseListingForm,
        csrf_token: csrfToken,
        ...(sourceId === null ? {} : { duplicated_from: String(sourceId) }),
        ...(groupId === undefined ? {} : { group_ids: String(groupId) }),
        name,
      },
      cookie,
    ),
  );
  const copy = (await getAllListings()).find((one) => one.name === name)!;
  // A caveat comes back as the error half of the flash, because the create
  // worked but not everything it was asked to carry over did.
  const flash = parseFlashCookie(response);
  return { copyId: copy.id, message: flash.success ?? flash.error };
};

const parentOf = async (childCount: number, name: string) => {
  const parent = await createTestListing({ maxAttendees: 10, name });
  const children = [];
  for (let index = 0; index < childCount; index++) {
    children.push(await createTestListing({ name: `${name} child ${index}` }));
  }
  await listingChildren.setIds(
    parent.id,
    children.map((one) => one.id),
  );
  return { children, parent };
};

describeWithEnv(
  "duplicating a listing with required children",
  { db: true },
  () => {
    test("gives the copy the same one child", async () => {
      const { children, parent } = await parentOf(1, "One Child");

      const { copyId } = await duplicate(parent.id, "One Child Copy");

      expect(await listingChildren.getIds(copyId)).toEqual([children[0]!.id]);
    });

    test("gives the copy every child the source had", async () => {
      const { children, parent } = await parentOf(2, "Two Children");

      const { copyId } = await duplicate(parent.id, "Two Children Copy");

      expect((await listingChildren.getIds(copyId)).toSorted()).toEqual(
        children.map((one) => one.id).toSorted(),
      );
    });

    test("says nothing extra when the copy keeps the gate", async () => {
      const { parent } = await parentOf(1, "Quiet Copy");

      const { message } = await duplicate(parent.id, "Quiet Copy Made");

      expect(message).toBe(t("success.listing_created"));
    });
  },
);

describeWithEnv("a plain create is not a duplicate", { db: true }, () => {
  test("copies nothing when no source is named", async () => {
    await parentOf(1, "Not The Source");

    const { copyId, message } = await duplicate(null, "Fresh Listing");

    expect(await listingChildren.getIds(copyId)).toEqual([]);
    expect(message).toBe(t("success.listing_created"));
  });

  test("copies nothing when the source gates no listings", async () => {
    const source = await createTestListing({ name: "Gateless" });

    const { copyId } = await duplicate(source.id, "Gateless Copy");

    expect(await listingChildren.getIds(copyId)).toEqual([]);
  });
});

describeWithEnv("when the gate cannot be carried over", { db: true }, () => {
  test("keeps the copy, drops the gate, and names the reason", async () => {
    // A child that is itself a parent is a shape the editor forbids, but the
    // source already holds it. Re-checking the copy's edge fails, so the copy
    // is made without the gate rather than with an invalid one.
    const parent = await createTestListing({ name: "Nested Base" });
    const middle = await createTestListing({ name: "Nested Middle" });
    const leaf = await createTestListing({ name: "Nested Leaf" });
    await listingChildren.setIds(parent.id, [middle.id]);
    await listingChildren.setIds(middle.id, [leaf.id]);

    const { copyId, message } = await duplicate(parent.id, "Nested Copy");

    expect(await listingChildren.getIds(copyId)).toEqual([]);
    expect(message).toBe(
      `${t("success.listing_created")} but: ${t(
        "listings_table.duplicate_children_dropped",
        {
          reason: t("listings_table.children_err_child_is_parent", {
            name: "Nested Middle",
          }),
        },
      )}`,
    );
  });
});

describeWithEnv("duplicating into a hidden package", { db: true }, () => {
  test("keeps the copy but drops the gate, and says so", async () => {
    const { parent } = await parentOf(1, "Packaged");
    const hidden = await createTestGroup({ isPackage: true, name: "Hidden" });
    await groups.table.update(hidden.id, { hidePackageListings: true });

    const { copyId, message } = await duplicate(
      parent.id,
      "Packaged Copy",
      hidden.id,
    );

    expect(await listingChildren.getIds(copyId)).toEqual([]);
    expect(message).toBe(
      `${t("success.listing_created")} but: ${t(
        "listings_table.duplicate_children_dropped",
        { reason: t("error.package_member_no_children") },
      )}`,
    );
  });

  test("keeps the gate when the package shows its members", async () => {
    const { children, parent } = await parentOf(1, "Visible Packaged");
    const visible = await createTestGroup({ isPackage: true, name: "Shown" });

    const { copyId, message } = await duplicate(
      parent.id,
      "Visible Packaged Copy",
      visible.id,
    );

    expect(await listingChildren.getIds(copyId)).toEqual([children[0]!.id]);
    expect(message).toBe(t("success.listing_created"));
  });
});
