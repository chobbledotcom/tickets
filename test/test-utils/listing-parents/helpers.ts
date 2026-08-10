import { listingChildren } from "#shared/db/listing-parents.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  insertModifier,
  linkModifierGroup,
  linkModifierListing,
  optInAddOnForListings,
  patchModifier,
} from "#test-utils/modifiers.ts";
import { postChildren } from "#test-utils/parents.ts";
import { apiRequest } from "#test-utils/session.ts";

type TestListing = Awaited<ReturnType<typeof createTestListing>>;
type ParentChild = { parent: TestListing; child: TestListing };

/** A plain "Base unit" parent and a plain "Add-on" child, with no edge yet. */
export const parentAndChild = async (): Promise<ParentChild> => {
  const parent = await createTestListing({ name: "Base unit" });
  const child = await createTestListing({ name: "Add-on" });
  return { child, parent };
};

/** A parent listing linked to a single child, both plain standard listings. */
export const linkedParentChild = async (): Promise<ParentChild> => {
  const { parent, child } = await parentAndChild();
  await postChildren(parent.id, [child.id]);
  return { child, parent };
};

/** An intentionally invalid stored edge for transaction recheck tests. */
export const standardParentWithDailyChildEdge =
  async (): Promise<ParentChild> => {
    const parent = await createTestListing({ name: "Standard parent" });
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily child",
    });
    await listingChildren.setIds(parent.id, [child.id]);
    return { child, parent };
  };

/** Create a listing through the admin JSON API, returning the created id. */
export const apiCreateListing = async (
  body: Record<string, unknown>,
): Promise<number> => {
  let id = 0;
  await assertJson(
    apiRequest("/api/admin/listings", { body, method: "POST" }),
    201,
    (json) => {
      id = json.listing.id as number;
    },
  );
  return id;
};

/** Link a groups-scoped opt-in add-on to a group, returning its modifier id. */
export const linkGroupAddOn = async (
  groupId: number,
  name = "Group extra",
): Promise<number> => {
  const modifier = await insertModifier({ name });
  await patchModifier(modifier.id, { scope: "groups", trigger: "optional" });
  await linkModifierGroup(modifier.id, groupId);
  return modifier.id;
};

/** A parent and child in one group, with a group-scoped opt-in add-on on it —
 * the add-on resolves to {parent, child} and loads on the parent's page. */
export const groupScopedAddOn = async (): Promise<
  ParentChild & { group: Awaited<ReturnType<typeof createTestGroup>> }
> => {
  const group = await createTestGroup({ name: "Bundle" });
  const parent = await createTestListing({
    groupId: group.id,
    name: "Base unit",
  });
  const child = await createTestListing({ groupId: group.id, name: "Add-on" });
  await linkGroupAddOn(group.id);
  return { child, group, parent };
};

/** A child-only group add-on plus a stale direct link to the parent. */
export const groupAddOnWithStaleParentLink = async (): Promise<ParentChild> => {
  const group = await createTestGroup({ name: "Child group" });
  const parent = await createTestListing({ name: "Base unit" });
  const child = await createTestListing({
    groupId: group.id,
    name: "Add-on",
  });
  const modifierId = await linkGroupAddOn(group.id, "Group child extra");
  await linkModifierListing(modifierId, parent.id);
  return { child, parent };
};

/** An order-wide add-on plus a stale direct link to the child. */
export const allAddOnWithStaleChildLink = async (): Promise<ParentChild> => {
  const { parent, child } = await parentAndChild();
  const modifier = await insertModifier({ name: "Order extra" });
  await patchModifier(modifier.id, { scope: "all", trigger: "optional" });
  await linkModifierListing(modifier.id, child.id);
  return { child, parent };
};

/** A parent, its child, and a third "rescuing" page that shares a {child,
 * thatPage}-scoped opt-in add-on. The suppressed child leaves the add-on
 * reachable only through `thatPage`. */
export const rescuingPageSetup = async (): Promise<
  ParentChild & { thatPage: TestListing }
> => {
  const { parent, child } = await linkedParentChild();
  const thatPage = await createTestListing({ name: "Rescuing page" });
  await optInAddOnForListings("Child-scoped extra", [child.id, thatPage.id]);
  return { child, parent, thatPage };
};

/** A parent whose bookable-alone child is the sole seller of a child-only
 * opt-in add-on scoped just to it. */
export const soloChildAddOn = async (): Promise<ParentChild> => {
  const parent = await createTestListing({ name: "Base unit" });
  const child = await createTestListing({
    bookableAlone: true,
    name: "Solo Widget",
  });
  await postChildren(parent.id, [child.id]);
  await optInAddOnForListings("Child-only extra", [child.id]);
  return { child, parent };
};

/** POST a listing edit (building the full update form from the existing row with
 * overrides), returning the raw response so a *rejected* save (status 400) can be
 * asserted rather than throwing as `updateTestListing` does. */
export const postListingEdit = async (
  listingId: number,
  updates: Record<string, unknown> & { groupId?: number; groupIds?: number[] },
): Promise<Response> => {
  const { getListingWithCount } = await import(
    "#shared/db/listings/records.ts"
  );
  const { buildUpdateListingForm } = await import(
    "#test-utils/db-helpers/listing-forms.ts"
  );
  const { getTestSession } = await import("#test-utils/session.ts");
  const { handleRequest } = await import("#routes");
  const { mockMultipartRequest } = await import("#test-utils/mocks.ts");
  const existing = (await getListingWithCount(listingId))!;
  const form = buildUpdateListingForm(updates, existing);
  // The edit form carries group membership as `group_ids` checkboxes. Translate
  // the test's group intent (legacy groupId / groupIds) into that field; a
  // single id covers these tests (the form helper is single-value).
  const groupIds =
    updates.groupIds ??
    (typeof updates.groupId === "number" && updates.groupId > 0
      ? [updates.groupId]
      : []);
  const formWithGroups =
    groupIds.length > 0 ? { ...form, group_ids: String(groupIds[0]) } : form;
  const session = await getTestSession();
  return handleRequest(
    mockMultipartRequest(
      `/admin/listing/${listingId}/edit`,
      { ...formWithGroups, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
};

/** Turn a listing into a renewal tier (months_per_unit > 0). `execute`
 * invalidates the listings cache, so subsequent reads see the change. */
export const makeRenewalTier = async (listingId: number): Promise<void> => {
  const { execute } = await import("#shared/db/client.ts");
  await execute("UPDATE listings SET months_per_unit = 12 WHERE id = ?", [
    listingId,
  ]);
};
