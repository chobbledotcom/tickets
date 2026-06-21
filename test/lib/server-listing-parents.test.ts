import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getChildIds,
  getChildIdsWithActiveParent,
} from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import {
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  getTestSession,
  updateTestListing,
} from "#test-utils";

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

    test("getChildIdsWithActiveParent returns empty for empty input", async () => {
      // The no-query short-circuit (Fix 1): no ids ⇒ no query, empty set.
      expect((await getChildIdsWithActiveParent([])).size).toBe(0);
    });

    test("getChildIdsWithActiveParent includes a child of an active parent", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await postChildren(parent.id, [child.id]);
      const ids = await getChildIdsWithActiveParent([child.id]);
      expect([...ids]).toEqual([child.id]);
    });

    test("getChildIdsWithActiveParent excludes a child whose only parent is inactive", async () => {
      // A child with no active parent has no page that can offer it, so it is
      // excluded — the discovery surface falls it back to its own CTA (Fix 1).
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await postChildren(parent.id, [child.id]);
      await deactivateTestListing(parent.id);
      expect((await getChildIdsWithActiveParent([child.id])).size).toBe(0);
    });

    test("getChildIdsWithActiveParent keeps a child with at least one active parent", async () => {
      const activeParent = await createTestListing({ name: "Active base" });
      const deadParent = await createTestListing({ name: "Dead base" });
      const child = await createTestListing({ name: "Add-on" });
      await postChildren(activeParent.id, [child.id]);
      await postChildren(deadParent.id, [child.id]);
      await deactivateTestListing(deadParent.id);
      const ids = await getChildIdsWithActiveParent([child.id]);
      expect([...ids]).toEqual([child.id]);
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
});
