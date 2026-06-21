import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getChildIds } from "#shared/db/listing-parents.ts";
import {
  createTestListing,
  describeWithEnv,
  getTestSession,
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
