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
