import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { copyDuplicatedChildEdges } from "#routes/admin/listings-parents.ts";
import { assignListingsToGroup } from "#shared/db/groups/membership.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("duplicated listing child edges", { db: true }, () => {
  test("does not copy an edge to a package member", async () => {
    const parent = await createTestListing({ name: "Copied Parent" });
    const child = await createTestListing({ name: "Packaged Child" });
    const group = await createTestGroup({
      isPackage: true,
      name: "Child Package",
    });
    expect(await assignListingsToGroup([child.id], group.id)).toBeNull();

    expect(await copyDuplicatedChildEdges(parent, [child.id])).toBe(
      t("error.package_child_is_member"),
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });
});
