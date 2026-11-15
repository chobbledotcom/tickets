/** Fixtures for the catalog-import reference guards. */

import { execute } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { groups } from "#db/groups.ts";
import { sql } from "#db/sql.ts";
import type { ImportedBundle } from "#routes/admin/catalog-transfer/bundle-plan.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import type { ImportedEntity } from "#routes/admin/catalog-transfer/import-listing.ts";
import type { Result } from "#shared/result.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** A listing that assigns a site on booking. The admin form accepts
 *  `assignBuiltSite` only while CAN_BUILD_SITES is on, so the caller keeps that
 *  flag up for the whole test. */
export const createPlanListing = (name: string) =>
  createTestListing({
    assignBuiltSite: true,
    initialSiteMonths: 1,
    name,
  });

/** Make a group whose package listings are hidden, put one listing in it, then
 *  import a child that names that listing as its parent. The import decides
 *  from the stored flag and the group's package kind whether the name stays
 *  referenceable. */
export const importChildOfHiddenGroupMember = async (config: {
  childName: string;
  group: { isPackage?: boolean; name: string };
  parentName: string;
}): Promise<Result<ImportedEntity | ImportedBundle>> => {
  const group = await createTestGroup(config.group);
  // createTestGroup cannot set the flag, so write it directly and refresh the
  // cached group set the import reads.
  await execute(
    sql`UPDATE groups SET hide_package_listings = 1 WHERE id = ${group.id}`,
  );
  groups.cache.invalidate();
  const parent = await createTestListing({ name: config.parentName });
  await assignListingsToGroup([parent.id], group.id);
  return await importCatalog({
    kind: "listing",
    listing: { maxAttendees: 1, name: config.childName },
    parents: [parent.name],
    version: 1,
  });
};
