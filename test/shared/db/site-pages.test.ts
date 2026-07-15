import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { executeBatch, queryAll } from "#shared/db/client.ts";
import { isGroupSlugTaken } from "#shared/db/groups.ts";
import {
  appendImageToItem,
  getImageById,
  getImagesForItem,
} from "#shared/db/images.ts";
import {
  getListingNamesByIds,
  isSlugTaken,
} from "#shared/db/listings/records.ts";
import {
  addPageItem,
  clearItemEdgesStatement,
  deleteSitePageWithEdges,
  getAllPageItems,
  getItemsForPage,
  invalidatePageItemsCache,
  removePageItem,
  swapPageItemOrder,
} from "#shared/db/site-page-items.ts";
import {
  computeSitePageSlugIndex,
  getSitePageById,
  getSitePageBySlugIndex,
  type SitePageInput,
  sitePages,
  swapSitePageOrder,
  updateSitePage,
} from "#shared/db/site-pages.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import type { SitePage } from "#shared/types.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { expectEncryptedAtRest } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";

const makePage = async (
  slug: string,
  extra: Partial<SitePageInput> = {},
): Promise<SitePage> => {
  const slugIndex = await computeSitePageSlugIndex(slug);
  return sitePages.table.insert({
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
      expectEncryptedAtRest(raw[0]?.name, raw[0]?.slug, raw[0]?.content);
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
      sitePages.invalidate();
      const rows = await sitePages.getAll();
      expect(rows.map((r) => r.slug)).toEqual(["a", "b"]);
      expect(rows[0]).not.toHaveProperty("content");
    });

    test("getSitePageBySlugIndex finds a page by its blind index", async () => {
      await makePage("terms-of-use");
      const idx = await computeSitePageSlugIndex("terms-of-use");
      const found = await getSitePageBySlugIndex(idx);
      expect(found?.slug).toBe("terms-of-use");
    });

    test("createSitePage assigns distinct, increasing trailing orders", async () => {
      const make = async (slug: string): Promise<number> =>
        (
          await createTestSitePage(slug, {
            content: "",
            metaDescription: "",
            metaTitle: "",
            name: `Name ${slug}`,
          })
        ).sort_order;
      const orders = [await make("o-a"), await make("o-b"), await make("o-c")];
      // Distinct + strictly increasing ⇒ the pages are reliably reorderable
      // (equal orders would make the move-up/down swap a no-op).
      expect(new Set(orders).size).toBe(3);
      expect(orders[0]).toBeLessThan(orders[1]!);
      expect(orders[1]).toBeLessThan(orders[2]!);
    });

    test("createSitePage clears the nav cache so the new page shows", () =>
      // The nav projection is request-scoped, so hold one request open across
      // the populate → create → re-read: the raw transactional insert must
      // invalidate the cache, or this second read returns the stale projection
      // without the new page.
      runWithRequestCache(async () => {
        await sitePages.getAll(); // populate the cached projection
        const created = await createTestSitePage("fresh-cache", {
          content: "Body",
          metaDescription: "Desc",
          metaTitle: "Meta",
          name: "Fresh",
        });
        const slugs = (await sitePages.getAll()).map((r) => r.slug);
        expect(slugs).toContain("fresh-cache");
        // The returned row is built from the input (no post-commit read-back),
        // and matches what a fresh read decrypts.
        expect(created.meta_title).toBe("Meta");
        expect(await getSitePageById(created.id)).toEqual(created);
      }));

    test("updateSitePage rewrites the fields and moves the blind index with the slug", async () => {
      const created = await createTestSitePage("before-move", {
        content: "old",
        metaDescription: "old",
        metaTitle: "old",
        name: "Old",
      });
      const updated = await updateSitePage(created.id, {
        content: "new",
        metaDescription: "new",
        metaTitle: "new",
        name: "New",
        slug: "after-move",
      });
      if (!updated.ok) throw new Error(`page update failed: ${updated.error}`);
      expect(updated.value.name).toBe("New");
      expect(updated.value.content).toBe("new");
      // slug_index is computed inside the write, so the renamed slug is
      // findable and the old one is freed - the pair can never desync.
      const byNew = await getSitePageBySlugIndex(
        await computeSitePageSlugIndex("after-move"),
      );
      expect(byNew?.id).toBe(created.id);
      expect(
        await getSitePageBySlugIndex(
          await computeSitePageSlugIndex("before-move"),
        ),
      ).toBeNull();
    });

    test("updateSitePage reports a missing id", async () => {
      expect(
        await updateSitePage(99_999, {
          content: "",
          metaDescription: "",
          metaTitle: "",
          name: "Ghost",
          slug: "ghost-page",
        }),
      ).toEqual({ error: "notFound", ok: false });
    });

    test("loads listing names without loading full listing rows", async () => {
      const listing = await createTestListing({ name: "L" });
      // The id-keyed name lookup short-circuits on empty ids (no query) and
      // decrypts names for real ids — the projection page labels lean on.
      expect((await getListingNamesByIds([])).size).toBe(0);
      expect((await getListingNamesByIds([listing.id])).get(listing.id)).toBe(
        "L",
      );
    });

    test("a page slug blocks a new listing and group (bidirectional)", async () => {
      await makePage("bidi");
      expect(await isSlugTaken("bidi")).toBe(true); // listings validator
      expect(await isGroupSlugTaken("bidi")).toBe(true); // groups validator
    });
  });

  describe("root reorder", () => {
    test("swapSitePageOrder exchanges two pages' sort_order", async () => {
      const a = await makePage("first", { sortOrder: 0 });
      const b = await makePage("second", { sortOrder: 1 });
      await swapSitePageOrder(a.id, b.id);
      sitePages.invalidate();
      expect((await sitePages.getAll()).map((r) => r.slug)).toEqual([
        "second",
        "first",
      ]);
    });

    test("swapSitePageOrder is a no-op when either row is missing", async () => {
      // A stale reorder click racing a delete must not 500 (binding an
      // undefined sort_order) — the swap simply does nothing.
      const a = await makePage("survivor", { sortOrder: 0 });
      await swapSitePageOrder(a.id, 9999);
      await swapSitePageOrder(9999, a.id);
      sitePages.invalidate();
      const row = (await sitePages.getAll()).find((r) => r.slug === "survivor");
      expect(row?.sort_order).toBe(0);
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
      expect(await addPageItem(p.id, "listing", 7)).toBe(true);
      // A repeat is reported as a conflict (false), not inserted a second time.
      expect(await addPageItem(p.id, "listing", 7)).toBe(false);
      expect((await getItemsForPage(p.id)).length).toBe(1);
    });

    test("a page cannot be nested under two parents (single-parent guard)", async () => {
      const parentA = await makePage("pa");
      const parentB = await makePage("pb");
      const child = await makePage("child");
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
      const p = await makePage("existing");
      // Host page vanished (stale add racing a delete): no dangling edge.
      expect(await addPageItem(9999, "listing", 1)).toBe(false);
      // Child page vanished: the page edge would dangle, so it is rejected.
      expect(await addPageItem(p.id, "page", 9999)).toBe(false);
      expect(await getAllPageItems()).toEqual([]);
    });

    test("a page cannot be nested inside itself (N4 self-loop)", async () => {
      const p = await makePage("self");
      expect(await addPageItem(p.id, "page", p.id)).toBe(false);
      expect(await getItemsForPage(p.id)).toEqual([]);
    });

    test("a page cannot be nested under its own descendant (N4 cycle)", async () => {
      // A contains B; nesting A under B would close an A→B→A loop.
      const a = await makePage("anc-a");
      const b = await makePage("anc-b");
      await addPageItem(a.id, "page", b.id);
      expect(await addPageItem(b.id, "page", a.id)).toBe(false);
      expect(await getItemsForPage(b.id)).toEqual([]);
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
      const q = await makePage("swap-other");
      await addPageItem(p.id, "listing", 5);
      await addPageItem(p.id, "group", 5);
      await addPageItem(q.id, "listing", 5); // same type+id on ANOTHER page
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
      // page_id is part of the match: the other page's row is untouched.
      expect((await getItemsForPage(q.id))[0]?.sort_order).toBe(0);
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

    test("deleteSitePageWithEdges prunes the page's image uses but keeps the images", async () => {
      const page = await makePage("with-image");
      const image = await makeImage("Page hero");
      await appendImageToItem(image.id, { itemId: page.id, itemType: "page" });
      expect((await getImagesForItem("page", page.id)).length).toBe(1);

      await deleteSitePageWithEdges(page.id);

      // The link is gone, but the image itself stays in the library.
      expect(await getImagesForItem("page", page.id)).toEqual([]);
      expect(await getImageById(image.id)).not.toBeNull();
    });

    test("a page-item write clears the request-scoped edge cache", async () => {
      const p = await makePage("cachebust");
      await addPageItem(p.id, "listing", 1); // seed one edge (outside the scope)
      await runWithRequestCache(async () => {
        expect((await getAllPageItems()).length).toBe(1); // warm the cache
        await removePageItem(p.id, "listing", 1); // write auto-invalidates it
        expect(await getAllPageItems()).toEqual([]); // must re-fetch fresh
      });
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
