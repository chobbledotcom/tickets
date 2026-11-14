/** The group record's commands, called directly: the write that keeps package
 * members, and the delete that clears everything a group carries. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import {
  createExternalSourceLink,
  listExternalSourceLinks,
} from "#db/external-sources/queries.ts";
import { externalSourcesTable } from "#db/external-sources/tables.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getImagesForItem, setItemsForImage } from "#db/images.ts";
import { createOwnerNote, getNoteRows } from "#db/notes/queries.ts";
import { noteTargets } from "#db/notes/target.ts";
import { addPageItem, getItemsForPage } from "#db/site-page-items.ts";
import { groupRecord } from "#shared/records/groups.ts";
import { groupInput } from "#test/features/admin/groups/helpers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import {
  createPackageWithMember,
  createSoldPackageMember,
  createTestGroup,
  getTestPackagePrices,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import {
  expectRefused,
  expectWrittenAndLogged,
  listedNames,
} from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";
import { withTestSession } from "#test-utils/session.ts";

/** Everything one group carries that its delete must clear. */
const groupLeftovers = async (
  groupId: number,
  pageId: number,
  listingId: number,
) => ({
  edges: await getItemsForPage(pageId),
  images: await getImagesForItem("group", groupId),
  links: await withTestSession(() =>
    listExternalSourceLinks(1, { kind: "all" }),
  ),
  memberships: await listingGroups.getIds(listingId),
  notes: await getNoteRows("group", [groupId]),
  rows: await queryAll(
    "SELECT groupRow.id FROM groups AS groupRow WHERE groupRow.id = ?",
    [groupId],
  ),
});

/** A package whose one member carries a 300 package price. */
const pricedBundle = async () => {
  const { group, member } = await createPackageWithMember("Bundle");
  await groupRecord.update(
    group.id,
    await groupInput({
      isPackage: true,
      name: "Bundle",
      packageMembers: [{ listingId: member.id, price: 300 }],
      slug: group.slug,
    }),
  );
  return { group, member };
};

describeRecord(groupRecord, "Group", "Group name", () => {
  test("creates a group and logs it with the group name", async () => {
    await expectWrittenAndLogged(
      groupRecord.create(await groupInput({ name: "Club" })),
      { name: "Club" },
      ["Group 'Club' created"],
    );
    expect(await listedNames(groupRecord)).toEqual(["Club"]);
  });

  test("stores the package members an update carries", async () => {
    const { group, member } = await pricedBundle();

    expect(await getTestPackagePrices(group.id)).toEqual(
      new Map([[member.id, 300]]),
    );
  });

  test("clears the package members when a group stops being a package", async () => {
    const { group } = await pricedBundle();

    await groupRecord.update(
      group.id,
      await groupInput({
        isPackage: false,
        name: "Bundle",
        slug: group.slug,
      }),
    );

    expect(await getTestPackagePrices(group.id)).toEqual(new Map());
  });

  test("refuses to delete a hidden package with sold tickets", async () => {
    const { group } = await createSoldPackageMember("Hidden sold", true);

    await expectRefused(
      groupRecord.remove(group.id),
      "This package has sold tickets that hide listing names. Show its listing names first if you want to un-package or delete it.",
    );
  });

  test("deletes a group with every link, edge, note, and image use", async () => {
    const group = await createTestGroup({ name: "Doomed" });
    const listing = await createTestListing({ groupId: group.id });
    const page = await createTestSitePage("edges");
    await addPageItem(page.id, "group", group.id);
    const image = await makeImage("Banner");
    await setItemsForImage(image.id, [{ id: group.id, kind: "group" }]);
    const source = await externalSourcesTable.insert({
      name: "Imports",
      urlPattern: "https://example.com/{external_id}",
    });
    await createExternalSourceLink(source.id, {
      externalId: "GROUP-1",
      linkId: group.id,
      linkType: "group",
    });
    await createOwnerNote(noteTargets.of("group")(group.id), "A note");

    expect(await groupRecord.remove(group.id)).toEqual({ kind: "deleted" });
    expect(await groupLeftovers(group.id, page.id, listing.id)).toEqual({
      edges: [],
      images: [],
      links: [],
      memberships: [],
      notes: [],
      rows: [],
    });
    expect((await activityMessages())[0]).toBe("Group 'Doomed' deleted");
  });
});
