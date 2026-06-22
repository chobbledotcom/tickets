import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getChildIds } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import {
  apiRequest,
  assertJson,
  createTestGroup,
  createTestListing,
  describeWithEnv,
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

/** Turn a listing into a renewal tier (months_per_unit > 0). `execute`
 * invalidates the listings cache, so subsequent reads see the change. */
const makeRenewalTier = async (listingId: number): Promise<void> => {
  const { execute } = await import("#shared/db/client.ts");
  await execute("UPDATE listings SET months_per_unit = 12 WHERE id = ?", [
    listingId,
  ]);
};

describeWithEnv(
  "server > listing parents (flag on)",
  { db: true, env: { LISTING_PARENTS_ENABLED: "true" } },
  () => {
    test("saves the chosen children and redirects", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      const res = await postChildren(parent.id, [child.id]);
      expect(res.headers.get("location")).toContain(
        `/admin/listing/${parent.id}/edit`,
      );
      expect(await getChildIds(parent.id)).toEqual([child.id]);
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
      await postChildren(parent.id, [child.id]);
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

    test("admin API treats a non-array child_listing_ids as empty", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await postChildren(parent.id, [child.id]);
      await assertJson(
        apiRequest(`/api/admin/listings/${parent.id}`, {
          body: { child_listing_ids: "not-an-array" },
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
  },
);

describeWithEnv("server > listing parents (flag off)", { db: true }, () => {
  test("the children endpoint is hidden (404)", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const res = await postChildren(parent.id, [child.id]);
    expect(res.status).toBe(404);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("the edit page omits the children section", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const html = await editPageHtml(parent.id);
    expect(html).not.toContain("Required child listings");
  });

  test("the admin API ignores child_listing_ids", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id] },
        method: "PUT",
      }),
      200,
    );
    expect(await getChildIds(parent.id)).toEqual([]);
  });
});
