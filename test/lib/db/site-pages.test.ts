import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { executeBatch, queryAll } from "#shared/db/client.ts";
import {
  addPageItem,
  clearItemEdgesStatement,
  deleteSitePageWithEdges,
  getAllPageItems,
  getItemsForPage,
  invalidatePageItemsCache,
  removePageItem,
  SitePageItemConflictError,
  swapPageItemOrder,
} from "#shared/db/site-page-items.ts";
import {
  computeSitePageSlugIndex,
  getSitePageById,
  getSitePageBySlugIndex,
  getSitePageNavRows,
  invalidateSitePagesCache,
  isSitePageSlugTaken,
  type SitePageInput,
  sitePagesTable,
  swapSitePageOrder,
} from "#shared/db/site-pages.ts";
import type { SitePage } from "#shared/types.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

const makePage = async (
  slug: string,
  extra: Partial<SitePageInput> = {},
): Promise<SitePage> => {
  const slugIndex = await computeSitePageSlugIndex(slug);
  return sitePagesTable.insert({
    name: `Name ${slug}`,
    slug,
    slugIndex,
    sortOrder: 0,
    ...extra,
  });
};

describeWithEnv("db > site-pages", { db: true }, () => {
  describe("site_pages encryption + reads", () => {
    test("stores free text encrypted and decrypts on read", async () => {
      const created = await makePage("about", {
        content: "Hello **world**",
        metaTitle: "About us",
      });
      const raw = await queryAll<{
        content: string;
        name: string;
        slug: string;
      }>("SELECT slug, name, content FROM site_pages WHERE id = ?", [
        created.id,
      ]);
      // At rest, everything is ciphertext (enc:… envelope), not plaintext.
      expect(raw[0]?.name.startsWith("enc:")).toBe(true);
      expect(raw[0]?.slug.startsWith("enc:")).toBe(true);
      expect(raw[0]?.content.startsWith("enc:")).toBe(true);
      expect(raw[0]?.name).not.toContain("Name about");

      const back = await getSitePageById(created.id);
      expect(back?.name).toBe("Name about");
      expect(back?.slug).toBe("about");
      expect(back?.content).toBe("Hello **world**");
      expect(back?.meta_title).toBe("About us");
    });

    test("getSitePageById returns null for a missing id", async () => {
      expect(await getSitePageById(9999)).toBeNull();
    });

    test("nav rows are decrypted, ordered, and carry no content", async () => {
      await makePage("b", { sortOrder: 5 });
      await makePage("a", { sortOrder: 1 });
      invalidateSitePagesCache();
      const rows = await getSitePageNavRows();
      expect(rows.map((r) => r.slug)).toEqual(["a", "b"]);
      expect(rows[0]).not.toHaveProperty("content");
    });

    test("getSitePageBySlugIndex finds a page by its blind index", async () => {
      await makePage("terms-of-use");
      const idx = await computeSitePageSlugIndex("terms-of-use");
      const found = await getSitePageBySlugIndex(idx);
      expect(found?.slug).toBe("terms-of-use");
    });
  });

  describe("isSitePageSlugTaken", () => {
    test("true for an existing page slug, false for a fresh one", async () => {
      await makePage("taken");
      expect(await isSitePageSlugTaken("taken")).toBe(true);
      expect(await isSitePageSlugTaken("free")).toBe(false);
    });

    test("excludeId lets a page keep its own slug", async () => {
      const p = await makePage("keepme");
      expect(await isSitePageSlugTaken("keepme", p.id)).toBe(false);
      expect(await isSitePageSlugTaken("keepme")).toBe(true);
    });

    test("collides with an existing group slug", async () => {
      await createTestGroup({ name: "G", slug: "shared-with-group" });
      expect(await isSitePageSlugTaken("shared-with-group")).toBe(true);
    });

    test("collides with an existing listing slug", async () => {
      const listing = await createTestListing({ name: "L" });
      expect(await isSitePageSlugTaken(listing.slug)).toBe(true);
    });
  });

  describe("root reorder", () => {
    test("swapSitePageOrder exchanges two pages' sort_order", async () => {
      const a = await makePage("first", { sortOrder: 0 });
      const b = await makePage("second", { sortOrder: 1 });
      await swapSitePageOrder(a.id, b.id);
      invalidateSitePagesCache();
      expect((await getSitePageNavRows()).map((r) => r.slug)).toEqual([
        "second",
        "first",
      ]);
    });
  });

  describe("page items", () => {
    test("addPageItem appends with the next sort_order and includes page_id", async () => {
      const p = await makePage("host");
      await addPageItem(p.id, "listing", 100);
      await addPageItem(p.id, "group", 200);
      const items = await getItemsForPage(p.id);
      expect(items).toEqual([
        { item_id: 100, item_type: "listing", page_id: p.id, sort_order: 0 },
        { item_id: 200, item_type: "group", page_id: p.id, sort_order: 1 },
      ]);
    });

    test("the same item cannot be added to one page twice (unique key)", async () => {
      const p = await makePage("dupe");
      await addPageItem(p.id, "listing", 7);
      await expect(addPageItem(p.id, "listing", 7)).rejects.toThrow();
    });

    test("a page cannot be nested under two parents (single-parent guard)", async () => {
      const parentA = await makePage("pa");
      const parentB = await makePage("pb");
      const child = await makePage("child");
      await addPageItem(parentA.id, "page", child.id);
      await expect(
        addPageItem(parentB.id, "page", child.id),
      ).rejects.toBeInstanceOf(SitePageItemConflictError);
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

    test("removePageItem drops one edge by composite key", async () => {
      const p = await makePage("rm");
      await addPageItem(p.id, "listing", 1);
      await addPageItem(p.id, "group", 1); // same numeric id, different type
      await removePageItem(p.id, "listing", 1);
      expect((await getItemsForPage(p.id)).map((i) => i.item_type)).toEqual([
        "group",
      ]);
    });

    test("swapPageItemOrder swaps by full composite key", async () => {
      const p = await makePage("swap");
      await addPageItem(p.id, "listing", 5);
      await addPageItem(p.id, "group", 5);
      await swapPageItemOrder(
        p.id,
        { id: 5, type: "listing" },
        { id: 5, type: "group" },
      );
      const items = await getItemsForPage(p.id);
      expect(items).toEqual([
        { item_id: 5, item_type: "group", page_id: p.id, sort_order: 0 },
        { item_id: 5, item_type: "listing", page_id: p.id, sort_order: 1 },
      ]);
    });

    test("swapPageItemOrder is a no-op when an item is missing", async () => {
      const p = await makePage("noop");
      await addPageItem(p.id, "listing", 1);
      await swapPageItemOrder(
        p.id,
        { id: 1, type: "listing" },
        { id: 999, type: "group" },
      );
      expect((await getItemsForPage(p.id))[0]?.sort_order).toBe(0);
    });
  });

  describe("cascade delete + edge cleanup", () => {
    test("deleteSitePageWithEdges removes the row, its items, and edges naming it", async () => {
      const parent = await makePage("parent");
      const child = await makePage("kid");
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

    test("clearItemEdgesStatement removes every edge pointing at a listing/group", async () => {
      const p1 = await makePage("h1");
      const p2 = await makePage("h2");
      await addPageItem(p1.id, "listing", 50);
      await addPageItem(p2.id, "listing", 50);
      await executeBatch([clearItemEdgesStatement("listing", 50)]);
      invalidatePageItemsCache();
      const edges = await getAllPageItems();
      expect(
        edges.some((e) => e.item_type === "listing" && e.item_id === 50),
      ).toBe(false);
    });
  });
});
