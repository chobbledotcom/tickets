import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingActivityLog } from "#shared/db/activityLog.ts";
import { getChildIds } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import {
  apiRequest,
  assertJson,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectFlash,
  getTestSession,
  insertModifier,
  linkModifierGroup,
  linkModifierListing,
  patchModifier,
  updateTestListing,
} from "#test-utils";

/** Create a listing through the admin JSON API, returning the created id. */
const apiCreateListing = async (
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

/** Insert an active opt-in add-on scoped to the given listing ids. */
const optInAddOnForListings = async (
  name: string,
  listingIds: number[],
): Promise<void> => {
  const modifier = await insertModifier({ name });
  await patchModifier(modifier.id, { scope: "listings", trigger: "optional" });
  for (const listingId of listingIds) {
    await linkModifierListing(modifier.id, listingId);
  }
};

/** POST the children sub-form with repeated `child_listing_ids` values
 * (mockFormRequest only supports single values per key). */
const postChildren = async (
  listingId: number,
  childIds: number[],
): Promise<Response> => {
  const { cookie, csrfToken } = await getTestSession();
  const { handleRequest } = await import("#routes");
  const body = new URLSearchParams();
  body.set("csrf_token", csrfToken);
  for (const id of childIds) body.append("child_listing_ids", String(id));
  return handleRequest(
    new Request(`http://localhost/admin/listing/${listingId}/children`, {
      body: body.toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        host: "localhost",
      },
      method: "POST",
    }),
  );
};

const editPageHtml = async (listingId: number): Promise<string> => {
  const { adminGet } = await import("#test-utils");
  const { response } = await adminGet(`/admin/listing/${listingId}/edit`);
  return response.text();
};

/** POST a listing edit (building the full update form from the existing row with
 * overrides), returning the raw response so a *rejected* save (status 400) can be
 * asserted rather than throwing as `updateTestListing` does. */
const postListingEdit = async (
  listingId: number,
  updates: Record<string, unknown>,
): Promise<Response> => {
  const { getListingWithCount } = await import("#shared/db/listings.ts");
  const { buildUpdateListingForm } = await import("#test-utils/db-helpers.ts");
  const { getTestSession } = await import("#test-utils/session.ts");
  const { handleRequest } = await import("#routes");
  const { mockMultipartRequest } = await import("#test-utils/mocks.ts");
  const existing = (await getListingWithCount(listingId))!;
  const form = buildUpdateListingForm(updates, existing);
  const session = await getTestSession();
  return handleRequest(
    mockMultipartRequest(
      `/admin/listing/${listingId}/edit`,
      { ...form, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
};

/** Turn a listing into a renewal tier (months_per_unit > 0). `execute`
 * invalidates the listings cache, so subsequent reads see the change. */
const makeRenewalTier = async (listingId: number): Promise<void> => {
  const { execute } = await import("#shared/db/client.ts");
  await execute("UPDATE listings SET months_per_unit = 12 WHERE id = ?", [
    listingId,
  ]);
};

describeWithEnv("server > listing parents", { db: true }, () => {
  test("saves the chosen children and redirects", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const res = await postChildren(parent.id, [child.id]);
    expect(res.headers.get("location")).toContain(
      `/admin/listing/${parent.id}/edit`,
    );
    // A success flash, not an error one.
    expectFlash(res, "Required children updated");
    expect(await getChildIds(parent.id)).toEqual([child.id]);
    // The save is recorded in the listing's activity log, with the count
    // singularised ("1 listing", not "1 listings").
    const logs = await getListingActivityLog(parent.id);
    const entry = logs.find((l) =>
      l.message.includes("required children set to"),
    );
    expect(entry?.message).toBe(
      "Listing 'Base unit' required children set to 1 listing",
    );
  });

  test("drops self-edges and unknown ids", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [parent.id, child.id, parent.id + 9999]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("renders the section with the chosen child checked", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    const html = await editPageHtml(parent.id);
    expect(html).toContain("Required child listings");
    expect(html).toContain(
      `<input checked name="child_listing_ids" type="checkbox" value="${child.id}">`,
    );
  });

  test("saves multiple children", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const childA = await createTestListing({ name: "Add-on A" });
    const childB = await createTestListing({ name: "Add-on B" });
    await postChildren(parent.id, [childA.id, childB.id]);
    expect(await getChildIds(parent.id)).toEqual(
      [childA.id, childB.id].sort((a, b) => a - b),
    );
  });

  test("renders unticked siblings without the checked attribute", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const other = await createTestListing({ name: "Unrelated" });
    await postChildren(parent.id, [child.id]);
    const html = await editPageHtml(parent.id);
    expect(html).toContain(
      `<input checked name="child_listing_ids" type="checkbox" value="${child.id}">`,
    );
    expect(html).toContain(
      `<input name="child_listing_ids" type="checkbox" value="${other.id}">`,
    );
  });

  test("shows what a child is offered under", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    const html = await editPageHtml(child.id);
    expect(html).toContain("This listing is itself offered under: Base unit");
  });

  test("pre-disables a candidate that is itself a parent (usability #4)", async () => {
    // `child` already has its own child `grandchild`, so it can't also be a
    // child of `parent` — its candidate checkbox is disabled with the reason,
    // so the operator can't tick an edge the save would reject.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Mid" });
    const grandchild = await createTestListing({ name: "Leaf" });
    await postChildren(child.id, [grandchild.id]);
    const html = await editPageHtml(parent.id);
    expect(html).toContain(
      `<input disabled name="child_listing_ids" type="checkbox" value="${child.id}">`,
    );
    expect(html).toContain("already has its own child listings");
  });

  test("pre-disables a daily candidate under a non-daily parent (usability #4)", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const daily = await createTestListing({
      listingType: "daily",
      name: "Daily add-on",
    });
    const html = await editPageHtml(parent.id);
    expect(html).toContain(
      `<input disabled name="child_listing_ids" type="checkbox" value="${daily.id}">`,
    );
  });

  test("a child listing's edit page shows the inherited-fields banner (usability #3)", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    const html = await editPageHtml(child.id);
    expect(html).toContain("This listing is offered as a child of Base unit");
    expect(html).toContain(
      "Inherited from the parent when this listing is chosen as a child",
    );
  });

  test("a non-child listing's edit page shows no inherited-fields banner", async () => {
    const standalone = await createTestListing({ name: "Standalone" });
    const html = await editPageHtml(standalone.id);
    expect(html).not.toContain("This listing is offered as a child of");
    expect(html).not.toContain(
      "Inherited from the parent when this listing is chosen as a child",
    );
  });

  test("notes when there are no other listings to choose from", async () => {
    const only = await createTestListing({ name: "Solo" });
    const html = await editPageHtml(only.id);
    expect(html).toContain("No other listings to choose from yet.");
  });

  test("rejects a daily child under a non-daily parent", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily add-on",
    });
    const res = await postChildren(parent.id, [child.id]);
    // A rejected save redirects back with an ERROR flash, not a success one.
    expectFlash(res, expect.anything(), false);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("rejects giving children to a listing that is itself a child", async () => {
    const grandparent = await createTestListing({ name: "Grandparent" });
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });
    await postChildren(grandparent.id, [parent.id]); // parent becomes a child
    await postChildren(parent.id, [child.id]); // blocked: parent is a child
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("rejects choosing a child that is itself a parent", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });
    const grandchild = await createTestListing({ name: "Grandchild" });
    await postChildren(child.id, [grandchild.id]); // child becomes a parent
    await postChildren(parent.id, [child.id]); // blocked: child is a parent
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("rejects a renewal-tier parent", async () => {
    const parent = await createTestListing({ name: "Renewal" });
    await makeRenewalTier(parent.id);
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("rejects a renewal-tier child", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Renewal add-on" });
    await makeRenewalTier(child.id);
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("rejects a daily child whose fixed duration differs from the parent", async () => {
    const parent = await createTestListing({
      durationDays: 3,
      listingType: "daily",
      name: "3-day base",
    });
    const child = await createTestListing({
      durationDays: 1,
      listingType: "daily",
      name: "1-day add-on",
    });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("rejects a customisable child that can't price the parent's fixed span", async () => {
    const parent = await createTestListing({ name: "1-day base" });
    const child = await createTestListing({
      customisableDays: true,
      dayPrices: { 2: 200, 3: 300 },
      durationDays: 3,
      name: "Add-on (no 1-day price)",
    });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("accepts a customisable child that prices the parent's fixed span", async () => {
    const parent = await createTestListing({ name: "1-day base" });
    const child = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100, 2: 200 },
      durationDays: 2,
      name: "Add-on (prices 1 day)",
    });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("accepts overlapping customisable parent and child day ranges", async () => {
    const parent = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100, 2: 200, 3: 300 },
      durationDays: 3,
      name: "Flexible base",
    });
    const child = await createTestListing({
      customisableDays: true,
      dayPrices: { 2: 20, 3: 30 },
      durationDays: 3,
      name: "Flexible add-on",
    });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("rejects non-overlapping customisable parent and child day ranges", async () => {
    const parent = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      durationDays: 1,
      name: "1-day flexible base",
    });
    const child = await createTestListing({
      customisableDays: true,
      dayPrices: { 2: 20, 3: 30 },
      durationDays: 3,
      name: "2-3 day add-on",
    });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("accepts a plain standard child under a multi-day daily parent", async () => {
    // A one-off fee/merch add-on folds date:null and inherits no span, so it
    // is valid under any parent — including a fixed 3-day daily base.
    const parent = await createTestListing({
      durationDays: 3,
      listingType: "daily",
      name: "3-day base",
    });
    const child = await createTestListing({ name: "Booking fee" });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("accepts a plain standard child under a parent with no 1-day span", async () => {
    const parent = await createTestListing({
      customisableDays: true,
      dayPrices: { 2: 200, 3: 300 },
      durationDays: 3,
      name: "2-3 day flexible base",
    });
    const child = await createTestListing({ name: "Merch add-on" });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("accepts a daily child whose span a customisable daily parent offers", async () => {
    const parent = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100, 2: 200, 3: 300 },
      durationDays: 3,
      listingType: "daily",
      name: "1-3 day base",
    });
    const child = await createTestListing({
      durationDays: 2,
      listingType: "daily",
      name: "2-day add-on",
    });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("rejects a daily child whose span a customisable daily parent can't offer", async () => {
    const parent = await createTestListing({
      customisableDays: true,
      dayPrices: { 2: 200, 3: 300 },
      durationDays: 3,
      listingType: "daily",
      name: "2-3 day base",
    });
    const child = await createTestListing({
      durationDays: 1,
      listingType: "daily",
      name: "1-day add-on",
    });
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("blocks a listing edit that would break an existing edge", async () => {
    const parent = await createTestListing({
      durationDays: 1,
      listingType: "daily",
      name: "Daily base",
    });
    const child = await createTestListing({
      durationDays: 1,
      listingType: "daily",
      name: "Daily add-on",
    });
    await postChildren(parent.id, [child.id]);
    // Flipping the daily parent to standard would orphan its daily child.
    await expect(
      updateTestListing(parent.id, { listingType: "standard" }),
    ).rejects.toThrow();
    const after = await getListingWithCount(parent.id);
    expect(after?.listing_type).toBe("daily");
  });

  test("allows a compatible listing edit while edges exist", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    const after = await updateTestListing(parent.id, {
      name: "Renamed base",
    });
    expect(after.name).toBe("Renamed base");
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("lets a listing that is itself a child save an empty children set", async () => {
    const grandparent = await createTestListing({ name: "Grandparent" });
    const parent = await createTestListing({ name: "Parent" });
    await postChildren(grandparent.id, [parent.id]); // parent becomes a child
    const res = await postChildren(parent.id, []); // empty no-op save
    expect(res.headers.get("set-cookie")).toContain(
      "Required%20children%20updated",
    );
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("admin API create writes child edges", async () => {
    const child = await createTestListing({ name: "Add-on" });
    const parentId = await apiCreateListing({
      child_listing_ids: [child.id],
      max_attendees: 10,
      name: "Base unit",
    });
    expect(await getChildIds(parentId)).toEqual([child.id]);
  });

  test("admin API update changes child edges", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const first = await createTestListing({ name: "Add-on A" });
    const second = await createTestListing({ name: "Add-on B" });
    await postChildren(parent.id, [first.id]);
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [second.id] },
        method: "PUT",
      }),
      200,
    );
    expect(await getChildIds(parent.id)).toEqual([second.id]);
  });

  test("admin API drops non-numeric and unknown child ids", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id, "oops", parent.id + 9999] },
        method: "PUT",
      }),
      200,
    );
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("admin API rejects a string child_listing_ids without clearing edges", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: "not-an-array" },
        method: "PUT",
      }),
      400,
      (json) => {
        expect(json.error).toBe(
          "child_listing_ids must be an array of listing ids",
        );
      },
    );
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("admin API rejects an object child_listing_ids without clearing edges", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: { [child.id]: true } },
        method: "PUT",
      }),
      400,
    );
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("admin API leaves edges untouched when child_listing_ids is omitted", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { name: "Renamed base" },
        method: "PUT",
      }),
      200,
    );
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("admin API clears edges when child_listing_ids is an empty array", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [] },
        method: "PUT",
      }),
      200,
    );
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("admin API rejects an invalid edge with no write", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily add-on",
    });
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id] },
        method: "PUT",
      }),
      400,
      (json) => {
        expect(typeof json.error).toBe("string");
      },
    );
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("admin API blocks a child whose add-on only it can reach", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await optInAddOnForListings("Child-only extra", [child.id]);
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id] },
        method: "PUT",
      }),
      400,
    );
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("blocks a child whose opt-in add-on only it can reach", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await optInAddOnForListings("Child-only extra", [child.id]);
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("allows a child whose add-on is also scoped to the parent", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await optInAddOnForListings("Shared extra", [parent.id, child.id]);
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("allows a child whose add-on is scoped to a group containing the parent", async () => {
    // The add-on is groups-scoped to a group holding both the parent and the
    // child, so it resolves to listing ids including the parent — still
    // reachable via the parent's page ids, so the edge is allowed.
    const group = await createTestGroup({ name: "Bundle" });
    const parent = await createTestListing({
      groupId: group.id,
      name: "Base unit",
    });
    const child = await createTestListing({
      groupId: group.id,
      name: "Add-on",
    });
    const modifier = await insertModifier({ name: "Group extra" });
    await patchModifier(modifier.id, {
      scope: "groups",
      trigger: "optional",
    });
    await linkModifierGroup(modifier.id, group.id);
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("blocks a child whose add-on is reachable only via a parent's group sibling", async () => {
    // The direct /ticket/<parent> page loads add-ons from only the parent's
    // own id, never its group siblings — so an add-on scoped to {child,
    // sibling} but not the parent is a dead end and the edge must be blocked.
    const group = await createTestGroup({ name: "Bundle" });
    const parent = await createTestListing({
      groupId: group.id,
      name: "Base unit",
    });
    const sibling = await createTestListing({
      groupId: group.id,
      name: "Sibling",
    });
    const child = await createTestListing({ name: "Add-on" });
    await optInAddOnForListings("Sibling-only extra", [sibling.id, child.id]);
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("a listing save moving a parent out of a group orphans a group-scoped add-on (rejected)", async () => {
    // An opt-in add-on is GROUP-scoped to a group holding both the parent and
    // its child, so it resolves to {parent, child} and loads on the parent's
    // page — the edge is valid. Moving the PARENT out of the group makes the
    // add-on resolve to {child} only: it would then be reachable solely through
    // the suppressed child, which can't offer it. The listing save must be
    // rejected against the would-be group_id (Fix 4), leaving the parent in its
    // group.
    const group = await createTestGroup({ name: "Bundle" });
    const parent = await createTestListing({
      groupId: group.id,
      name: "Base unit",
    });
    const child = await createTestListing({
      groupId: group.id,
      name: "Add-on",
    });
    const modifier = await insertModifier({ name: "Group extra" });
    await patchModifier(modifier.id, {
      scope: "groups",
      trigger: "optional",
    });
    await linkModifierGroup(modifier.id, group.id);
    // The edge is valid while the parent is in the group.
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);

    // Moving the parent out of the group orphans the add-on, so the save is
    // blocked (400 with the child-add-on error) and the parent stays in its
    // group.
    const res = await postListingEdit(parent.id, { groupId: 0 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Group extra");
    expect((await getListingWithCount(parent.id))?.group_id).toBe(group.id);
  });

  test("a listing save that keeps a group-scoped add-on reachable is allowed", async () => {
    // Moving the parent to ANOTHER group the add-on is also scoped to keeps the
    // add-on reachable from the parent's page, so the save is allowed (Fix 4 is
    // a reachability test, not a blanket group-change block).
    const fromGroup = await createTestGroup({ name: "From" });
    const toGroup = await createTestGroup({ name: "To" });
    const parent = await createTestListing({
      groupId: fromGroup.id,
      name: "Base unit",
    });
    const child = await createTestListing({
      groupId: fromGroup.id,
      name: "Add-on",
    });
    const modifier = await insertModifier({ name: "Group extra" });
    await patchModifier(modifier.id, {
      scope: "groups",
      trigger: "optional",
    });
    // The add-on covers both groups, so it reaches the parent in either one.
    await linkModifierGroup(modifier.id, fromGroup.id);
    await linkModifierGroup(modifier.id, toGroup.id);
    await postChildren(parent.id, [child.id]);

    await updateTestListing(parent.id, { groupId: toGroup.id });
    expect((await getListingWithCount(parent.id))?.group_id).toBe(toGroup.id);
  });

  test("saving a CHILD into a group that orphans its add-on is rejected", async () => {
    // The edge is checked from the child's side too: a child C under parent P
    // (P is the page). An add-on is group-scoped to group G, and P is NOT in G.
    // While C is ungrouped the add-on doesn't reach C, so the edge is valid.
    // Moving C INTO G makes the add-on resolve to {C, ...}: reachable only via
    // the suppressed child C, never via P's page — the save must be rejected
    // (Fix 4, the child-role branch of the edge check).
    const group = await createTestGroup({ name: "Bundle" });
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const modifier = await insertModifier({ name: "Group extra" });
    await patchModifier(modifier.id, {
      scope: "groups",
      trigger: "optional",
    });
    await linkModifierGroup(modifier.id, group.id);
    // Edge is valid while the child is ungrouped (add-on doesn't reach it).
    await postChildren(parent.id, [child.id]);
    expect(await getChildIds(parent.id)).toEqual([child.id]);

    const res = await postListingEdit(child.id, { groupId: group.id });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Group extra");
    expect((await getListingWithCount(child.id))?.group_id).toBe(0);
  });

  test("validateListingInput rejects an orphaning group change with an omitted groupId", async () => {
    // The admin JSON API may omit group_id; validateListingInput then sees
    // groupId undefined and defaults the would-be group to 0 (no group). A
    // parent whose group-scoped add-on only resolves to it via its group is
    // orphaned by dropping to no group, so the (defaulted) check still blocks.
    const { validateListingInput } = await import(
      "#shared/listings-actions.ts"
    );
    const { listingsTable } = await import("#shared/db/listings.ts");
    const group = await createTestGroup({ name: "Bundle" });
    const parent = await createTestListing({
      groupId: group.id,
      name: "Base unit",
    });
    const child = await createTestListing({
      groupId: group.id,
      name: "Add-on",
    });
    const modifier = await insertModifier({ name: "Group extra" });
    await patchModifier(modifier.id, {
      scope: "groups",
      trigger: "optional",
    });
    await linkModifierGroup(modifier.id, group.id);
    await postChildren(parent.id, [child.id]);

    const row = (await getListingWithCount(parent.id))!;
    const input = {
      ...(listingsTable.rowToInput(row, ["created"]) as Record<
        string,
        unknown
      >),
      groupId: undefined,
    } as import("#shared/db/listings.ts").ListingInput;
    const error = await validateListingInput(input, parent.id);
    expect(error).toContain("Group extra");
  });

  test("admin API PUT rejecting an invalid child does NOT persist the rename (Fix 4)", async () => {
    // The child-edge validation runs BEFORE the row write, so a rejected edge
    // leaves no partial change: the rename in the same PUT must not stick.
    const parent = await createTestListing({ name: "Base unit" });
    // A daily child under a standard parent is an invalid edge.
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily add-on",
    });
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id], name: "Renamed base" },
        method: "PUT",
      }),
      400,
    );
    // Neither the edge nor the rename persisted.
    expect(await getChildIds(parent.id)).toEqual([]);
    expect((await getListingWithCount(parent.id))?.name).toBe("Base unit");
  });

  test("admin API POST rejecting an invalid child creates NO listing row (Fix 4)", async () => {
    // On create the child-edge validation runs before the insert, so a rejected
    // edge must leave no orphan listing row behind.
    const { getAllListings } = await import("#shared/db/listings.ts");
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily add-on",
    });
    const before = (await getAllListings()).length;
    await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          child_listing_ids: [child.id],
          max_attendees: 10,
          name: "Base unit",
        },
        method: "POST",
      }),
      400,
    );
    const after = await getAllListings();
    expect(after.length).toBe(before);
    expect(after.some((l) => l.name === "Base unit")).toBe(false);
  });

  test("deactivating the only active non-child page of a child add-on is rejected (Fix 5)", async () => {
    // An opt-in add-on is scoped to {child, thatPage}. The child is suppressed
    // (it has no standalone page), so the add-on is reachable only through
    // `thatPage`. Deactivating `thatPage` — an ordinary listing with NO edges of
    // its own — would leave the add-on reachable only via the suppressed child,
    // a dead end. The deactivation must be rejected (Fix 5), and the listing
    // must stay active.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const thatPage = await createTestListing({ name: "Rescuing page" });
    await postChildren(parent.id, [child.id]);
    await optInAddOnForListings("Child-scoped extra", [child.id, thatPage.id]);

    const { handleRequest } = await import("#routes");
    const res = await handleRequest(
      new Request(`http://localhost/admin/listing/${thatPage.id}/deactivate`, {
        body: new URLSearchParams({
          confirm_identifier: thatPage.name,
          csrf_token: (await getTestSession()).csrfToken,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: (await getTestSession()).cookie,
          host: "localhost",
        },
        method: "POST",
      }),
    );
    res.body?.cancel();
    expect(res.status).toBe(302);
    const { t } = await import("#i18n");
    expectFlash(
      res,
      t("modifiers.err_child_only_addon", { name: "Child-scoped extra" }),
      false,
    );
    expect((await getListingWithCount(thatPage.id))?.active).toBe(true);
  });

  test("an admin API edit-save that deactivates the rescuing page is rejected (Fix 5)", async () => {
    // The full edit-save path (validateListingInput → validateListingEdges)
    // must also block a deactivation that orphans a child-scoped add-on, not
    // only the dedicated /deactivate route. Set `active: false` via PUT.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const thatPage = await createTestListing({ name: "Rescuing page" });
    await postChildren(parent.id, [child.id]);
    await optInAddOnForListings("Child-scoped extra", [child.id, thatPage.id]);
    await assertJson(
      apiRequest(`/api/admin/listings/${thatPage.id}`, {
        body: { active: false },
        method: "PUT",
      }),
      400,
      (json) => {
        expect(json.error).toContain("opt-in add-on reachable only through");
      },
    );
    expect((await getListingWithCount(thatPage.id))?.active).toBe(true);
  });

  test("API deactivate of the only rescuing page of a child add-on is rejected, leaving it active (Fix 5)", async () => {
    // The JSON API toggle (POST /api/admin/listings/:id/deactivate) must run the
    // same orphaned-add-on guard the HTML deactivate route does: deactivating
    // `thatPage` — the only active non-child page rescuing a {child, thatPage}-
    // scoped opt-in add-on — would leave the add-on reachable only via the
    // suppressed child. The API must reject with a 400 and the listing must stay
    // active.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const thatPage = await createTestListing({ name: "Rescuing page" });
    await postChildren(parent.id, [child.id]);
    await optInAddOnForListings("Child-scoped extra", [child.id, thatPage.id]);

    await assertJson(
      apiRequest(`/api/admin/listings/${thatPage.id}/deactivate`, {
        method: "POST",
      }),
      400,
      (json) => {
        expect(json.error).toContain("opt-in add-on reachable only through");
      },
    );
    expect((await getListingWithCount(thatPage.id))?.active).toBe(true);
  });

  test("API deactivate of a listing unrelated to any child add-on still succeeds (Fix 5)", async () => {
    // The guard must not block an ordinary API deactivation: a plain listing
    // rescuing no child-scoped add-on toggles inactive normally.
    const plain = await createTestListing({ name: "Plain" });
    await assertJson(
      apiRequest(`/api/admin/listings/${plain.id}/deactivate`, {
        method: "POST",
      }),
      200,
      (json) => {
        expect(json.listing.active).toBe(false);
      },
    );
    expect((await getListingWithCount(plain.id))?.active).toBe(false);
  });

  test("deactivating a listing unrelated to any child add-on still succeeds (Fix 5)", async () => {
    // A plain listing not rescuing any child-scoped add-on deactivates normally
    // — Fix 5 must not block ordinary deactivations.
    const plain = await createTestListing({ name: "Plain" });
    const { handleRequest } = await import("#routes");
    const session = await getTestSession();
    const res = await handleRequest(
      new Request(`http://localhost/admin/listing/${plain.id}/deactivate`, {
        body: new URLSearchParams({
          confirm_identifier: plain.name,
          csrf_token: session.csrfToken,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: session.cookie,
          host: "localhost",
        },
        method: "POST",
      }),
    );
    res.body?.cancel();
    expect((await getListingWithCount(plain.id))?.active).toBe(false);
  });

  test("the deactivate confirmation GET renders the orphaned-add-on error and does NOT redirect to itself (Fix 1)", async () => {
    // Wiring the orphan guard as a `preValidate` made the confirmation GET
    // redirect to /deactivate (its own URL) in a loop instead of rendering. The
    // fix renders the page (200) WITH the error, and only the POST blocks. Here
    // `thatPage` is the sole rescuer of a {child, thatPage}-scoped add-on.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const thatPage = await createTestListing({ name: "Rescuing page" });
    await postChildren(parent.id, [child.id]);
    await optInAddOnForListings("Child-scoped extra", [child.id, thatPage.id]);

    const { adminGet } = await import("#test-utils");
    const { response } = await adminGet(
      `/admin/listing/${thatPage.id}/deactivate`,
    );
    const body = await response.text();
    // Renders the confirmation page (200), not a 302 back to itself.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBe(null);
    const { t } = await import("#i18n");
    expect(body).toContain(
      t("modifiers.err_child_only_addon", { name: "Child-scoped extra" }),
    );
    // The listing is untouched by the GET.
    expect((await getListingWithCount(thatPage.id))?.active).toBe(true);
  });

  test("deleting the only rescuing page of a {child, thatPage}-scoped add-on is blocked (Fix 2)", async () => {
    // The delete path prunes edges but bypassed the reachability guard the
    // deactivate paths use: deleting `thatPage` (the sole active non-child page
    // of a {child, thatPage}-scoped opt-in add-on) would leave the add-on
    // reachable only via the suppressed child. The HTML delete must block and
    // keep the listing.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const thatPage = await createTestListing({ name: "Rescuing page" });
    await postChildren(parent.id, [child.id]);
    await optInAddOnForListings("Child-scoped extra", [child.id, thatPage.id]);

    const { handleRequest } = await import("#routes");
    const session = await getTestSession();
    const res = await handleRequest(
      new Request(`http://localhost/admin/listing/${thatPage.id}/delete`, {
        body: new URLSearchParams({
          confirm_identifier: thatPage.name,
          csrf_token: session.csrfToken,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: session.cookie,
          host: "localhost",
        },
        method: "POST",
      }),
    );
    res.body?.cancel();
    const { t } = await import("#i18n");
    expectFlash(
      res,
      t("modifiers.err_child_only_addon", { name: "Child-scoped extra" }),
      false,
    );
    // The listing is NOT deleted.
    expect(await getListingWithCount(thatPage.id)).not.toBe(null);
  });

  test("the unverified direct delete (verify_identifier=false) is also blocked by the orphan guard (Fix 2)", async () => {
    // The direct-delete branch (no typed-identifier confirmation) must run the
    // same guard as the confirmed path: it shares no code with the confirmed
    // handler, so it needs its own block.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const thatPage = await createTestListing({ name: "Rescuing page" });
    await postChildren(parent.id, [child.id]);
    await optInAddOnForListings("Child-scoped extra", [child.id, thatPage.id]);

    const { handleRequest } = await import("#routes");
    const session = await getTestSession();
    const res = await handleRequest(
      new Request(
        `http://localhost/admin/listing/${thatPage.id}/delete?verify_identifier=false`,
        {
          body: new URLSearchParams({ csrf_token: session.csrfToken }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: session.cookie,
            host: "localhost",
          },
          method: "POST",
        },
      ),
    );
    res.body?.cancel();
    const { t } = await import("#i18n");
    expectFlash(
      res,
      t("modifiers.err_child_only_addon", { name: "Child-scoped extra" }),
      false,
    );
    expect(await getListingWithCount(thatPage.id)).not.toBe(null);
  });

  test("API delete of the only rescuing page of a child add-on is blocked, leaving it (Fix 2)", async () => {
    // The admin JSON API delete must run the same guard as the HTML delete.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const thatPage = await createTestListing({ name: "Rescuing page" });
    await postChildren(parent.id, [child.id]);
    await optInAddOnForListings("Child-scoped extra", [child.id, thatPage.id]);

    await assertJson(
      apiRequest(`/api/admin/listings/${thatPage.id}`, {
        body: { confirm_identifier: thatPage.name },
        method: "DELETE",
      }),
      400,
      (json) => {
        expect(json.error).toContain("opt-in add-on reachable only through");
      },
    );
    expect(await getListingWithCount(thatPage.id)).not.toBe(null);
  });

  test("deleting a listing unrelated to any child add-on still works (Fix 2)", async () => {
    // The guard must not block an ordinary delete.
    const plain = await createTestListing({ name: "Disposable" });
    await assertJson(
      apiRequest(`/api/admin/listings/${plain.id}`, {
        body: { confirm_identifier: plain.name },
        method: "DELETE",
      }),
      200,
      (json) => {
        expect(json.status).toBe("ok");
      },
    );
    expect(await getListingWithCount(plain.id)).toBe(null);
  });

  test("API create of a parent in the same group as the child's group-scoped add-on is accepted (Fix 3)", async () => {
    // The child carries a GROUP-scoped opt-in add-on. Creating a NEW parent in
    // that same group must be ACCEPTED: the add-on is reachable from the new
    // parent's own page once it joins the group. The old code validated against
    // the placeholder id (never in the group) and wrongly rejected this.
    const group = await createTestGroup({ name: "Bundle" });
    const child = await createTestListing({
      groupId: group.id,
      name: "Add-on",
    });
    const modifier = await insertModifier({ name: "Group extra" });
    await patchModifier(modifier.id, { scope: "groups", trigger: "optional" });
    await linkModifierGroup(modifier.id, group.id);

    const newId = await apiCreateListing({
      child_listing_ids: [child.id],
      group_id: group.id,
      listing_type: "standard",
      max_attendees: 10,
      name: "New base unit",
    });
    expect(await getChildIds(newId)).toEqual([child.id]);
  });

  test("API update moving a parent's group so the add-on becomes unreachable is rejected (Fix 3)", async () => {
    // The add-on is group-scoped to the parent+child's group, so it's reachable
    // from the parent's page. A single PUT that BOTH moves the parent to another
    // group AND (re)sets the child edge must be judged against the would-be
    // group: after the move the add-on resolves to {child} only, a dead end —
    // so the update must be rejected and nothing persisted.
    const group = await createTestGroup({ name: "Bundle" });
    const otherGroup = await createTestGroup({ name: "Elsewhere" });
    const parent = await createTestListing({
      groupId: group.id,
      name: "Base unit",
    });
    const child = await createTestListing({
      groupId: group.id,
      name: "Add-on",
    });
    const modifier = await insertModifier({ name: "Group extra" });
    await patchModifier(modifier.id, { scope: "groups", trigger: "optional" });
    await linkModifierGroup(modifier.id, group.id);
    await postChildren(parent.id, [child.id]);

    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id], group_id: otherGroup.id },
        method: "PUT",
      }),
      400,
      (json) => {
        expect(json.error).toContain("Group extra");
      },
    );
    // Neither the group move nor the edge change is partially applied; the
    // existing edge is preserved and the parent stays in its group.
    expect((await getListingWithCount(parent.id))?.group_id).toBe(group.id);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("duplicate child_listing_ids collapse to a single edge with no error (Fix 4)", async () => {
    // `validateChildEdges` keeps duplicate ids unless deduped, so `[child,child]`
    // would make `setChildIds` insert two `(parent, child)` rows and violate the
    // unique index — and on the API side-effect path that happens after the row
    // write (a partial change). The cleaned set must be unique.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id, child.id] },
        method: "PUT",
      }),
      200,
    );
    // Exactly one edge, no error, no partial write.
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("duplicate child_listing_ids in the HTML children form collapse to one edge (Fix 4)", async () => {
    // The same dedupe applies to repeated form values.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const res = await postChildren(parent.id, [child.id, child.id]);
    res.body?.cancel();
    expectFlash(res, "Required children updated");
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });
});
