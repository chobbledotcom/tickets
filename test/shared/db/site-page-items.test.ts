import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { executeBatch } from "#shared/db/client.ts";
import {
  appendImageToItem,
  getImageById,
  getImagesForItem,
} from "#shared/db/images.ts";
import {
  addPageItem,
  clearItemEdgesStatement,
  deleteSitePageWithEdges,
  getAllPageItems,
  getItemsForPage,
  invalidatePageItemsCache,
  removePageItem,
  sitePageItemOrder,
} from "#shared/db/site-page-items.ts";
import { getSitePageById } from "#shared/db/site-pages.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";

describeWithEnv("db > site-page-items", { db: true }, () => {
  describe("page items", () => {
    test("addPageItem appends with the next sort_order and includes page_id", async () => {
      const p = await createTestSitePage("host");
      await addPageItem(p.id, "listing", 100);
      await addPageItem(p.id, "group", 200);
      const items = await getItemsForPage(p.id);
      expect(items).toEqual([
        { item_id: 100, item_type: "listing", page_id: p.id, sort_order: 0 },
        { item_id: 200, item_type: "group", page_id: p.id, sort_order: 1 },
      ]);
    });

    test("the same item cannot be added to one page twice (unique key)", async () => {
      const p = await createTestSitePage("dupe");
      expect(await addPageItem(p.id, "listing", 7)).toBe(true);
      // A repeat is reported as a conflict (false), not inserted a second time.
      expect(await addPageItem(p.id, "listing", 7)).toBe(false);
      expect((await getItemsForPage(p.id)).length).toBe(1);
    });

    test("a page cannot be nested under two parents (single-parent guard)", async () => {
      const parentA = await createTestSitePage("pa");
      const parentB = await createTestSitePage("pb");
      const child = await createTestSitePage("child");
      await addPageItem(parentA.id, "page", child.id);
      expect(await addPageItem(parentB.id, "page", child.id)).toBe(false);
      // Only the first parent's edge exists.
      const edges = (await getAllPageItems()).filter(
        (e) => e.item_type === "page" && e.item_id === child.id,
      );
      expect(edges).toEqual([
        {
          item_id: child.id,
          item_type: "page",
          page_id: parentA.id,
          sort_order: 0,
        },
      ]);
    });

    test("an add is rejected when the host or child page is missing", async () => {
      const p = await createTestSitePage("existing");
      // Host page vanished (stale add racing a delete): no dangling edge.
      expect(await addPageItem(9999, "listing", 1)).toBe(false);
      // Child page vanished: the page edge would dangle, so it is rejected.
      expect(await addPageItem(p.id, "page", 9999)).toBe(false);
      expect(await getAllPageItems()).toEqual([]);
    });

    test("a page cannot be nested inside itself (N4 self-loop)", async () => {
      const p = await createTestSitePage("self");
      expect(await addPageItem(p.id, "page", p.id)).toBe(false);
      expect(await getItemsForPage(p.id)).toEqual([]);
    });

    test("a page cannot be nested under its own descendant (N4 cycle)", async () => {
      // A contains B; nesting A under B would close an A→B→A loop.
      const a = await createTestSitePage("anc-a");
      const b = await createTestSitePage("anc-b");
      await addPageItem(a.id, "page", b.id);
      expect(await addPageItem(b.id, "page", a.id)).toBe(false);
      expect(await getItemsForPage(b.id)).toEqual([]);
    });

    test("removePageItem drops one edge by composite key", async () => {
      const p = await createTestSitePage("rm");
      await addPageItem(p.id, "listing", 1);
      await addPageItem(p.id, "group", 1); // same numeric id, different type
      await removePageItem(p.id, "listing", 1);
      expect((await getItemsForPage(p.id)).map((i) => i.item_type)).toEqual([
        "group",
      ]);
    });

    test("sitePageItemOrder swaps by full composite key", async () => {
      const p = await createTestSitePage("swap");
      const q = await createTestSitePage("swap-other");
      await addPageItem(p.id, "listing", 5);
      await addPageItem(p.id, "group", 5);
      await addPageItem(q.id, "listing", 5); // same type+id on ANOTHER page
      await sitePageItemOrder.swap({
        first: ["listing", 5],
        scope: p.id,
        second: ["group", 5],
      });
      const items = await getItemsForPage(p.id);
      expect(items).toEqual([
        { item_id: 5, item_type: "group", page_id: p.id, sort_order: 0 },
        { item_id: 5, item_type: "listing", page_id: p.id, sort_order: 1 },
      ]);
      // page_id is part of the match: the other page's row is untouched.
      expect((await getItemsForPage(q.id))[0]?.sort_order).toBe(0);
    });

    test("sitePageItemOrder is a no-op when an item is missing", async () => {
      const p = await createTestSitePage("noop");
      await addPageItem(p.id, "listing", 1);
      await sitePageItemOrder.swap({
        first: ["listing", 1],
        scope: p.id,
        second: ["group", 999],
      });
      expect((await getItemsForPage(p.id))[0]?.sort_order).toBe(0);
    });
  });

  describe("cascade delete + edge cleanup", () => {
    test("deleteSitePageWithEdges removes the row, its items, and edges naming it", async () => {
      const parent = await createTestSitePage("parent");
      const child = await createTestSitePage("kid");
      await addPageItem(parent.id, "page", child.id);
      await addPageItem(child.id, "listing", 42);

      await deleteSitePageWithEdges(child.id);
      invalidatePageItemsCache();

      expect(await getSitePageById(child.id)).toBeNull();
      const edges = await getAllPageItems();
      // No edge references the deleted child (as parent OR as page item).
      expect(edges.some((e) => e.page_id === child.id)).toBe(false);
      expect(
        edges.some((e) => e.item_type === "page" && e.item_id === child.id),
      ).toBe(false);
    });

    test("deleteSitePageWithEdges prunes the page's image uses but keeps the images", async () => {
      const page = await createTestSitePage("with-image");
      const image = await makeImage("Page hero");
      await appendImageToItem(image.id, { id: page.id, kind: "page" });
      expect((await getImagesForItem("page", page.id)).length).toBe(1);

      await deleteSitePageWithEdges(page.id);

      // The link is gone, but the image itself stays in the library.
      expect(await getImagesForItem("page", page.id)).toEqual([]);
      expect(await getImageById(image.id)).not.toBeNull();
    });

    test("a page-item write clears the request-scoped edge cache", async () => {
      const p = await createTestSitePage("cachebust");
      await addPageItem(p.id, "listing", 1); // seed one edge (outside the scope)
      await runWithRequestCache(async () => {
        expect((await getAllPageItems()).length).toBe(1); // warm the cache
        await removePageItem(p.id, "listing", 1); // write auto-invalidates it
        expect(await getAllPageItems()).toEqual([]); // must re-fetch fresh
      });
    });

    test("clearItemEdgesStatement removes every edge pointing at a listing/group", async () => {
      const p1 = await createTestSitePage("h1");
      const p2 = await createTestSitePage("h2");
      await addPageItem(p1.id, "listing", 50);
      await addPageItem(p2.id, "listing", 50);
      await executeBatch([
        clearItemEdgesStatement(sitePageItemTargets.of("listing")(50)),
      ]);
      invalidatePageItemsCache();
      const edges = await getAllPageItems();
      expect(
        edges.some((e) => e.item_type === "listing" && e.item_id === 50),
      ).toBe(false);
    });
  });
});
