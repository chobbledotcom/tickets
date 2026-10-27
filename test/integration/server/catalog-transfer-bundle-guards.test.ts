import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { execute } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { listingParents } from "#db/listing-parents.ts";
import { getListingWithCount, listingsTable } from "#db/listings/records.ts";
import { loadCatalogNameIndex, matchName } from "#db/name-registry.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import type { CatalogBundle } from "#routes/admin/catalog-transfer/schema.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { optInAddOnForGroups } from "#test-utils/modifiers.ts";

// The bundle import bypasses the single import's write guards (one batched
// write, no per-row transaction checks), so its validation phases must refuse
// what those guards refuse. These tests pin the parity, one guard at a time.

/** The named listing does not exist after a refused import. */
const expectNoListing = async (name: string): Promise<void> => {
  const { listing } = await loadCatalogNameIndex();
  expect(matchName(listing, name).ok).toBe(false);
};

const bundleOf = (
  listing: CatalogBundle["listings"][number],
): CatalogBundle => ({
  groups: [],
  kind: "bundle",
  listings: [listing],
  version: 1,
});

/** Write the state no current write path creates: a built-site plan inside a
 * group. The plan-member rules defend it, so the tests can hold it directly. */
const storePlanInGroup = async (
  planName: string,
  groupId: number,
): Promise<void> => {
  const plan = await listingsTable.insert({
    assignBuiltSite: true,
    dayPrices: {},
    maxAttendees: 1,
    maxPrice: 0,
    name: planName,
    slug: "legacy-plan",
    slugIndex: await hmacHash("legacy-plan"),
  });
  await execute(
    "INSERT INTO group_listings (group_id, listing_id, quantity) VALUES (?, ?, 1)",
    [groupId, plan.id],
  );
};

describeWithEnv("catalog bundle import guard parity", { db: true }, () => {
  test("refuses a join into a group that holds a built-site plan", async () => {
    const group = await createTestGroup({ name: "Plan Day" });
    await storePlanInGroup("Legacy Plan", group.id);

    const result = await importCatalog(
      bundleOf({
        groups: [{ group: "Plan Day" }],
        listing: { maxAttendees: 1, maxPrice: 0, name: "Plan Joiner" },
        parents: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, "Legacy Plan");
    assertStringIncludes(result.error, "assigns its own site");
    await expectNoListing("Plan Joiner");
  });

  test("refuses a stored parent that is already a child", async () => {
    const top = await createTestListing({ name: "Stored Top" });
    const mid = await createTestListing({ name: "Stored Mid" });
    await listingParents.setIds(mid.id, [top.id]);

    const result = await importCatalog(
      bundleOf({
        groups: [],
        listing: { maxAttendees: 1, maxPrice: 0, name: "Stored Kid" },
        parents: ["Stored Mid"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, "itself a child");
    await expectNoListing("Stored Kid");
  });

  test("refuses a parent the document itself makes a child", async () => {
    await createTestListing({ name: "Doc Top" });

    const result = await importCatalog({
      groups: [],
      kind: "bundle",
      listings: [
        {
          groups: [],
          listing: { maxAttendees: 1, maxPrice: 0, name: "Doc Mid" },
          parents: ["Doc Top"],
        },
        {
          groups: [],
          listing: { maxAttendees: 1, maxPrice: 0, name: "Doc Kid" },
          parents: ["Doc Mid"],
        },
      ],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, '"Doc Kid"');
    assertStringIncludes(result.error, "itself a child");
    await expectNoListing("Doc Kid");
  });

  test("refuses a child whose group add-on cannot reach its parent", async () => {
    const group = await createTestGroup({ name: "Extra Day" });
    const otherGroup = await createTestGroup({ name: "Extra Night" });
    await createTestListing({ name: "Add-on Top" });
    // One add-on covers both groups the child joins; a second covers one.
    await optInAddOnForGroups("Day Extra", [group.id, otherGroup.id]);
    await optInAddOnForGroups("Night Extra", [group.id]);

    const result = await importCatalog(
      bundleOf({
        groups: [{ group: "Extra Day" }, { group: "Extra Night" }],
        listing: { maxAttendees: 1, maxPrice: 0, name: "Add-on Kid" },
        parents: ["Add-on Top"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, "opt-in add-on");
    await expectNoListing("Add-on Kid");
  });

  test("refuses a child whose planned parent stays outside the add-on group", async () => {
    const group = await createTestGroup({ name: "Solo Day" });
    await optInAddOnForGroups("Solo Extra", [group.id]);

    const result = await importCatalog({
      groups: [],
      kind: "bundle",
      listings: [
        {
          groups: [],
          listing: { maxAttendees: 1, maxPrice: 0, name: "Outside Top" },
          parents: [],
        },
        {
          groups: [{ group: "Solo Day" }],
          listing: { maxAttendees: 1, maxPrice: 0, name: "Outside Kid" },
          parents: ["Outside Top"],
        },
      ],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, "opt-in add-on");
    await expectNoListing("Outside Kid");
  });

  test("accepts the child when the stored parent joins the group too", async () => {
    const group = await createTestGroup({ name: "Shared Day" });
    const parent = await createTestListing({ name: "Shared Top" });
    await assignListingsToGroup([parent.id], group.id);
    await optInAddOnForGroups("Shared Extra", [group.id]);

    const result = await importCatalog(
      bundleOf({
        groups: [{ group: "Shared Day" }],
        listing: { maxAttendees: 1, maxPrice: 0, name: "Shared Kid" },
        parents: ["Shared Top"],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    const { listing } = await loadCatalogNameIndex();
    const kidId = matchName(listing, "Shared Kid");
    if (!kidId.ok) throw new Error("Shared Kid was not imported");
    expect(await listingParents.getIds(kidId.id)).toEqual([parent.id]);
  });

  test("accepts the child when the planned parent joins the site group too", async () => {
    const group = await createTestGroup({ name: "Planned Day" });
    await optInAddOnForGroups("Planned Extra", [group.id]);

    const result = await importCatalog({
      groups: [],
      kind: "bundle",
      listings: [
        {
          groups: [{ group: "Planned Day" }],
          listing: { maxAttendees: 1, maxPrice: 0, name: "Planned Top" },
          parents: [],
        },
        {
          groups: [{ group: "Planned Day" }],
          listing: { maxAttendees: 1, maxPrice: 0, name: "Planned Kid" },
          parents: ["Planned Top"],
        },
      ],
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual({ groups: 0, kind: "bundle", listings: 2 });
    const { listing } = await loadCatalogNameIndex();
    const topId = matchName(listing, "Planned Top");
    if (!topId.ok) throw new Error("Planned Top was not imported");
    const kidId = matchName(listing, "Planned Kid");
    if (!kidId.ok) throw new Error("Planned Kid was not imported");
    expect(await listingParents.getIds(kidId.id)).toEqual([topId.id]);
  });

  test("accepts a child that keeps its own booking page", async () => {
    const group = await createTestGroup({ name: "Alone Day" });
    await createTestListing({ name: "Alone Top" });
    await optInAddOnForGroups("Alone Extra", [group.id]);

    const result = await importCatalog(
      bundleOf({
        groups: [{ group: "Alone Day" }],
        listing: {
          bookableAlone: true,
          maxAttendees: 1,
          maxPrice: 0,
          name: "Alone Kid",
        },
        parents: ["Alone Top"],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual({ groups: 0, kind: "bundle", listings: 1 });
    const { listing } = await loadCatalogNameIndex();
    const topId = matchName(listing, "Alone Top");
    if (!topId.ok) throw new Error("Alone Top was not imported");
    const kidId = matchName(listing, "Alone Kid");
    if (!kidId.ok) throw new Error("Alone Kid was not imported");
    expect(await listingParents.getIds(kidId.id)).toEqual([topId.id]);
    const storedKid = await getListingWithCount(kidId.id);
    if (!storedKid) throw new Error("Alone Kid is missing after import");
    expect(storedKid.bookable_alone).toBe(true);
  });
});
