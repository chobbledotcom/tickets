import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addPageItem, getItemsForPage } from "#shared/db/site-page-items.ts";
import {
  computeSitePageSlugIndex,
  createSitePage,
  getSitePageById,
  getSitePageBySlugIndex,
  getSitePageNavRows,
} from "#shared/db/site-pages.ts";
import type { SitePage } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectErrorFlash,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  getAllActivityLog,
  testRequiresAuth,
} from "#test-utils";

/** True when the activity log holds an entry whose message equals `message`. */
const wasLogged = async (message: string): Promise<boolean> =>
  (await getAllActivityLog()).some((l) => l.message === message);

const BASE = "/admin/site/pages";

describeWithEnv("server (admin site pages)", { db: true }, () => {
  /** Create a page through the real create flow (assigns slug_index + order). */
  const create = async (slug: string, fields: Record<string, string> = {}) => {
    const { response } = await adminFormPost(BASE, {
      name: `Name ${slug}`,
      slug,
      ...fields,
    });
    return response;
  };

  const findPage = async (slug: string): Promise<SitePage> => {
    const rows = await getSitePageNavRows();
    const row = rows.find((r) => r.slug === slug);
    if (!row) throw new Error(`page ${slug} not found`);
    return (await getSitePageById(row.id))!;
  };

  describe("list + new", () => {
    testRequiresAuth(BASE);

    test("empty state renders the no-pages message", async () => {
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      expect(html).toContain("No pages yet");
    });

    test("GET new renders the create form", async () => {
      const html = await expectHtmlResponse(await adminGet(`${BASE}/new`), 200);
      expect(html).toContain("Create Page");
      // The content textarea is a markdown field (preview enabled).
      expect(html).toContain("data-markdown-preview");
    });

    test("reorder arrows appear only where a move is possible", async () => {
      await create("a1");
      await create("a2");
      await create("a3");
      const rows = await getSitePageNavRows();
      const first = rows[0]!;
      const last = rows[2]!;
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      // Roots exist, so the all-empty message must not show.
      expect(html).not.toContain("No pages yet");
      // The first row can only move down; the last row can only move up.
      expect(html).toContain(`${BASE}/${first.id}/move-down`);
      expect(html).not.toContain(`${BASE}/${first.id}/move-up`);
      expect(html).toContain(`${BASE}/${last.id}/move-up`);
      expect(html).not.toContain(`${BASE}/${last.id}/move-down`);
    });

    test("list shows root and nested pages with reorder arrows", async () => {
      await create("root-a");
      await create("root-b");
      const parent = await findPage("root-a");
      await create("child-a");
      const child = await findPage("child-a");
      await addPageItem(parent.id, "page", child.id);
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      expect(html).toContain("Top-level pages");
      expect(html).toContain("Nested pages");
      expect(html).toContain("/page/root-a");
      // Two roots ⇒ both arrows render (first has "down", second has "up").
      expect(html).toContain("move-down");
      expect(html).toContain("move-up");
    });
  });

  describe("create", () => {
    test("creates a page and redirects to its editor", async () => {
      const response = await create("about");
      expectRedirect(response);
      expectFlash(response, "Page created", true);
      expect(await findPage("about")).toBeTruthy();
      expect(await wasLogged("Page 'Name about' created")).toBe(true);
    });

    test("rejects a missing name", async () => {
      const { response } = await adminFormPost(BASE, { slug: "no-name" });
      expectRedirect(response);
      expect(
        (await getSitePageNavRows()).some((r) => r.slug === "no-name"),
      ).toBe(false);
    });

    test("rejects a missing slug", async () => {
      const { response } = await adminFormPost(BASE, { name: "No Slug" });
      expectRedirect(response);
      expect((await getSitePageNavRows()).length).toBe(0);
    });

    test("rejects a reserved slug", async () => {
      const response = await create("contact");
      expectRedirect(response);
      expect((await getSitePageNavRows()).length).toBe(0);
    });

    test("rejects a duplicate slug", async () => {
      await create("dup");
      const response = await create("dup");
      expectRedirect(response);
      expect(
        (await getSitePageNavRows()).filter((r) => r.slug === "dup").length,
      ).toBe(1);
    });
  });

  describe("edit + update", () => {
    test("GET edit 404s for a missing page", async () => {
      expect((await adminGet(`${BASE}/9999/edit`)).status).toBe(404);
    });

    test("edit renders the form and item manager", async () => {
      await create("editme");
      const page = await findPage("editme");
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/edit`),
        200,
      );
      expect(html).toContain("Edit Page");
      expect(html).toContain("Add to this page");
    });

    test("updates a page's fields", async () => {
      await create("orig");
      const page = await findPage("orig");
      const { response } = await adminFormPost(`${BASE}/${page.id}/edit`, {
        name: "Renamed",
        slug: "renamed",
      });
      expectRedirect(response);
      expectFlash(response, "Page updated", true);
      expect((await getSitePageById(page.id))?.name).toBe("Renamed");
      expect(await wasLogged("Page 'Renamed' updated")).toBe(true);
      // The blind index is recomputed, so the new slug is findable and the old
      // one is freed (both key off slug_index).
      const byNew = await getSitePageBySlugIndex(
        await computeSitePageSlugIndex("renamed"),
      );
      expect(byNew?.id).toBe(page.id);
      const byOld = await getSitePageBySlugIndex(
        await computeSitePageSlugIndex("orig"),
      );
      expect(byOld).toBeNull();
    });

    test("update rejects a slug taken by another page", async () => {
      await create("keep-a");
      await create("keep-b");
      const b = await findPage("keep-b");
      const { response } = await adminFormPost(`${BASE}/${b.id}/edit`, {
        name: "B",
        slug: "keep-a",
      });
      expectRedirect(response);
      expect((await getSitePageById(b.id))?.slug).toBe("keep-b");
    });

    test("update 404s for a missing page", async () => {
      const { response } = await adminFormPost(`${BASE}/9999/edit`, {
        name: "X",
        slug: "x",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("delete", () => {
    test("GET renders the confirmation, POST deletes on the right name", async () => {
      await create("goner");
      const page = await findPage("goner");
      const getHtml = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/delete`),
        200,
      );
      expect(getHtml).toContain("Delete Page");

      const wrong = await adminFormPost(`${BASE}/${page.id}/delete`, {
        confirm_identifier: "nope",
      });
      expectRedirect(wrong.response);
      expect(await getSitePageById(page.id)).toBeTruthy();

      const right = await adminFormPost(`${BASE}/${page.id}/delete`, {
        confirm_identifier: page.name,
      });
      expectRedirect(right.response);
      expect(await getSitePageById(page.id)).toBeNull();
      expect(await wasLogged(`Page '${page.name}' deleted`)).toBe(true);
    });
  });

  describe("root reorder", () => {
    const order = async (): Promise<string[]> =>
      (await getSitePageNavRows()).map((r) => r.slug);

    test("moves roots up and down; boundary is a no-op", async () => {
      await create("r1");
      await create("r2");
      await create("r3");
      expect(await order()).toEqual(["r1", "r2", "r3"]);

      // Move the middle page up (index 1 → 0): r2, r1, r3.
      const r2 = await findPage("r2");
      const up = await adminFormPost(`${BASE}/${r2.id}/move-up`, {});
      expectFlash(up.response, "Order updated", true);
      expect(await order()).toEqual(["r2", "r1", "r3"]);

      // Move r1 (now index 1) down: r2, r3, r1.
      const r1 = await findPage("r1");
      await adminFormPost(`${BASE}/${r1.id}/move-down`, {});
      expect(await order()).toEqual(["r2", "r3", "r1"]);

      // Moving the top page up is a no-op (boundary).
      const top = (await getSitePageNavRows())[0]!;
      await adminFormPost(`${BASE}/${top.id}/move-up`, {});
      expect(await order()).toEqual(["r2", "r3", "r1"]);
    });
  });

  describe("item manager", () => {
    const seedPage = async (slug: string) => {
      await create(slug);
      return findPage(slug);
    };

    test("adds a listing, a group, and a sub-page", async () => {
      const page = await seedPage("host");
      const listing = await createTestListing({ name: "L" });
      const group = await createTestGroup({ name: "G", slug: "g-slug" });
      const child = await seedPage("kid");

      for (const [type, id] of [
        ["listing", listing.id],
        ["group", group.id],
        ["page", child.id],
      ] as const) {
        const { response } = await adminFormPost(`${BASE}/${page.id}/items`, {
          item_id: String(id),
          item_type: type,
        });
        expectRedirect(response);
        expectFlash(response, "Added to page", true);
      }
      const items = await getItemsForPage(page.id);
      expect(items.map((i) => i.item_type)).toEqual([
        "listing",
        "group",
        "page",
      ]);
      expect(await wasLogged("Item added to page 'Name host'")).toBe(true);
    });

    test("pickers omit items already on the page", async () => {
      const page = await seedPage("pick");
      const kept = await createTestListing({ name: "Kept" });
      const added = await createTestListing({ name: "Added" });
      // An un-added group must still be offered in the group picker.
      await createTestGroup({ name: "KeptG", slug: "kg" });
      await addPageItem(page.id, "listing", added.id);
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/edit`),
        200,
      );
      // The un-added listing is still offered; the added one is not.
      expect(html).toContain(`value="${kept.id}"`);
      expect(html).not.toContain(`value="${added.id}"`);
      // The un-added group is offered too.
      expect(html).toContain(">KeptG<");
    });

    test("rejects re-adding an item already on the page", async () => {
      const page = await seedPage("nodupe");
      const listing = await createTestListing({ name: "Once" });
      await addPageItem(page.id, "listing", listing.id);
      const { response } = await adminFormPost(`${BASE}/${page.id}/items`, {
        item_id: String(listing.id),
        item_type: "listing",
      });
      expectErrorFlash(response, "can't be added");
      expect((await getItemsForPage(page.id)).length).toBe(1);
    });

    test("deleting a listing or group clears its page edges", async () => {
      const page = await seedPage("edges");
      const listing = await createTestListing({ name: "Doomed listing" });
      const group = await createTestGroup({ name: "Doomed group", slug: "dg" });
      await addPageItem(page.id, "listing", listing.id);
      await addPageItem(page.id, "group", group.id);
      expect((await getItemsForPage(page.id)).length).toBe(2);

      const { deleteListing } = await import("#shared/db/listings.ts");
      const { deleteGroup } = await import("#routes/admin/groups.ts");
      await deleteListing(listing.id);
      await deleteGroup(group.id);
      // No dangling edges remain pointing at the deleted targets.
      expect((await getItemsForPage(page.id)).length).toBe(0);
    });

    test("edit resolves item labels and flags a missing target", async () => {
      const page = await seedPage("labels");
      const listing = await createTestListing({ name: "Real Listing" });
      const group = await createTestGroup({ name: "Real Group", slug: "rg" });
      const child = await seedPage("kidlabel");
      // A spare unparented page keeps the sub-page picker non-empty.
      await seedPage("spare");
      // A real sub-page whose name is empty: its label stays "" (?? keeps the
      // empty string) rather than falling back to the "(missing)" placeholder.
      const blank = await createSitePage({
        content: "",
        metaDescription: "",
        metaTitle: "",
        name: "",
        slug: "blank-page",
        slugIndex: await computeSitePageSlugIndex("blank-page"),
      });
      await addPageItem(page.id, "listing", listing.id);
      await addPageItem(page.id, "group", group.id);
      await addPageItem(page.id, "page", child.id);
      await addPageItem(page.id, "page", blank.id);
      // A dangling edge (its listing no longer exists) renders the fallback.
      await addPageItem(page.id, "listing", 999999);
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/edit`),
        200,
      );
      expect(html).toContain("Real Listing");
      expect(html).toContain("Real Group");
      expect(html).toContain("Name kidlabel");
      // Only the dangling edge (not the empty-named listing) is "(missing)".
      expect((html.match(/\(missing\)/g) ?? []).length).toBe(1);
      // The spare page is offered in the sub-page picker.
      expect(html).toContain("Name spare");
    });

    test("offers only active listings; labels keep inactive ones named", async () => {
      const page = await seedPage("actives");
      const inactive = await createTestListing({ name: "Retired Listing" });
      await addPageItem(page.id, "listing", inactive.id);
      const { deactivateTestListing } = await import("#test-utils");
      await deactivateTestListing(inactive.id);
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/edit`),
        200,
      );
      // The already-added inactive listing still labels its row...
      expect(html).toContain("Retired Listing");
      // ...but an inactive listing is never offered as a new option, and
      // neither is a renewal tier (a normal public link would take payment
      // without extending the site).
      expect(html).not.toContain(`value="${inactive.id}"`);
      const tier = await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        name: "Tier Listing",
        purchaseOnly: true,
      });
      const html2 = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/edit`),
        200,
      );
      expect(html2).not.toContain(`value="${tier.id}"`);
      // And the server revalidation rejects both.
      const other = await seedPage("actives-2");
      for (const id of [inactive.id, tier.id]) {
        const { response } = await adminFormPost(`${BASE}/${other.id}/items`, {
          item_id: String(id),
          item_type: "listing",
        });
        expectErrorFlash(response, "can't be added");
      }
      expect((await getItemsForPage(other.id)).length).toBe(0);
    });

    test("rejects an ineligible / invalid target", async () => {
      const page = await seedPage("guarded");
      // A real listing id that doesn't exist → ineligible (not "invalid").
      const bad = await adminFormPost(`${BASE}/${page.id}/items`, {
        item_id: "9999",
        item_type: "listing",
      });
      expectErrorFlash(bad.response, "can't be added");
      // A bad item_type with an otherwise-valid id → invalid-item (the type
      // check alone must reject, independent of the id).
      const badType = await adminFormPost(`${BASE}/${page.id}/items`, {
        item_id: "5",
        item_type: "nonsense",
      });
      expectErrorFlash(badType.response, "Please choose something to add");
      // A missing id with a valid type → invalid-item (the id check alone).
      const noId = await adminFormPost(`${BASE}/${page.id}/items`, {
        item_id: "",
        item_type: "listing",
      });
      expectErrorFlash(noId.response, "Please choose something to add");
      expect((await getItemsForPage(page.id)).length).toBe(0);
    });

    test("rejects nesting a page that already has a parent", async () => {
      const a = await seedPage("pa");
      const b = await seedPage("pb");
      const child = await seedPage("pc");
      await addPageItem(a.id, "page", child.id);
      // b's picker won't offer child, and the server revalidation rejects it.
      const { response } = await adminFormPost(`${BASE}/${b.id}/items`, {
        item_id: String(child.id),
        item_type: "page",
      });
      expectRedirect(response);
      expect((await getItemsForPage(b.id)).length).toBe(0);
    });

    test("removes an item and reorders within a page", async () => {
      const page = await seedPage("rmpage");
      const l1 = await createTestListing({ name: "L1" });
      const l2 = await createTestListing({ name: "L2" });
      const l3 = await createTestListing({ name: "L3" });
      await addPageItem(page.id, "listing", l1.id);
      await addPageItem(page.id, "listing", l2.id);
      await addPageItem(page.id, "listing", l3.id);
      const ids = async (): Promise<number[]> =>
        (await getItemsForPage(page.id)).map((i) => i.item_id);

      // Move the middle item up (index 1 → 0): l2, l1, l3.
      const up = await adminFormPost(
        `${BASE}/${page.id}/items/listing/${l2.id}/move-up`,
        {},
      );
      expectFlash(up.response, "Order updated", true);
      expect(await ids()).toEqual([l2.id, l1.id, l3.id]);

      // Move l1 (now index 1) down: l2, l3, l1.
      await adminFormPost(
        `${BASE}/${page.id}/items/listing/${l1.id}/move-down`,
        {},
      );
      expect(await ids()).toEqual([l2.id, l3.id, l1.id]);

      const { response } = await adminFormPost(
        `${BASE}/${page.id}/items/listing/${l1.id}/remove`,
        {},
      );
      expectRedirect(response);
      expectFlash(response, "Removed from page", true);
      expect(await ids()).toEqual([l2.id, l3.id]);
      expect(await wasLogged("Item removed from page 'Name rmpage'")).toBe(
        true,
      );
    });

    test("item routes 404 on a bad ref or missing page", async () => {
      const page = await seedPage("refs");
      expect(
        (await adminFormPost(`${BASE}/${page.id}/items/bogus/1/remove`, {}))
          .response.status,
      ).toBe(404);
      expect(
        (
          await adminFormPost(`${BASE}/9999/items`, {
            item_id: "1",
            item_type: "listing",
          })
        ).response.status,
      ).toBe(404);
    });
  });
});
