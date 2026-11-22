import { assert, assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { queryAll } from "#db/client.ts";
import { isGroupSlugTaken } from "#db/groups.ts";
import { isSlugTaken, listingNamesByIds } from "#db/listings/records.ts";
import { type NewRecord, records } from "#db/record-table.ts";
import {
  getSitePageBySlugIndex,
  sitePageOrder,
  sitePages,
  updateSitePage,
} from "#db/site-pages.ts";
import { sql } from "#db/sql.ts";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { expectEncryptedAtRest } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import type { SitePage } from "#types";

const makePage = async (
  slug: string,
  extra: Partial<NewRecord<"site_pages">> = {},
): Promise<SitePage> =>
  records.site_pages.insert({
    name: `Name ${slug}`,
    slug,
    slugIndex: await hmacHash(slug),
    sortOrder: 0,
    ...extra,
  });

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
      }>(
        sql`SELECT slug, name, content FROM site_pages WHERE id = ${created.id}`,
      );
      // At rest, everything is ciphertext (enc:… envelope), not plaintext.
      expectEncryptedAtRest(raw[0]?.name, raw[0]?.slug, raw[0]?.content);
      assert(!raw[0]?.name.includes("Name about"));

      const back = await records.site_pages.find(created.id);
      expect(back?.name).toBe("Name about");
      expect(back?.slug).toBe("about");
      expect(back?.content).toBe("Hello **world**");
      expect(back?.metaTitle).toBe("About us");
    });

    test("records.site_pages.find returns null for a missing id", async () => {
      expect(await records.site_pages.find(9999)).toBeNull();
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
      const idx = await hmacHash("terms-of-use");
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
        ).sortOrder;
      const orders = [await make("o-a"), await make("o-b"), await make("o-c")];
      // Distinct + strictly increasing ⇒ the pages are reliably reorderable
      // (equal orders would leave the read order to the row id).
      expect(new Set(orders).size).toBe(3);
      expect(orders[0]).toBeLessThan(orders[1]!);
      expect(orders[1]).toBeLessThan(orders[2]!);
    });

    test("createSitePage clears the nav cache so the new page shows", async () =>
      // The nav projection is request-scoped, so hold one request open across
      // the populate → create → re-read: the raw transactional insert must
      // invalidate the cache, or this second read returns the stale projection
      // without the new page.
      await withRequestContext(async () => {
        await sitePages.getAll(); // populate the cached projection
        const created = await createTestSitePage("fresh-cache", {
          content: "Body",
          metaDescription: "Desc",
          metaTitle: "Meta",
          name: "Fresh",
        });
        const slugs = (await sitePages.getAll()).map((r) => r.slug);
        assertArrayIncludes(slugs, ["fresh-cache"]);
        // The returned row is built from the input (no post-commit read-back),
        // and matches what a fresh read decrypts.
        expect(created.metaTitle).toBe("Meta");
        expect(await records.site_pages.find(created.id)).toEqual(created);
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
        hidden: false,
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
      const byNew = await getSitePageBySlugIndex(await hmacHash("after-move"));
      expect(byNew?.id).toBe(created.id);
      expect(
        await getSitePageBySlugIndex(await hmacHash("before-move")),
      ).toBeNull();
    });

    test("updateSitePage reports a missing id", async () => {
      expect(
        await updateSitePage(99_999, {
          content: "",
          hidden: false,
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
      expect((await listingNamesByIds([])).size).toBe(0);
      expect((await listingNamesByIds([listing.id])).get(listing.id)).toBe("L");
    });

    test("a page slug blocks a new listing and group (bidirectional)", async () => {
      await makePage("bidi");
      expect(await isSlugTaken("bidi")).toBe(true); // listings validator
      expect(await isGroupSlugTaken("bidi")).toBe(true); // groups validator
    });
  });

  describe("root reorder", () => {
    test("ordered rows take the order they are arranged in", async () => {
      const a = await makePage("first", { sortOrder: 0 });
      const b = await makePage("second", { sortOrder: 1 });
      await sitePageOrder.arrange({ keys: [b.id, a.id] });
      sitePages.invalidate();
      expect((await sitePages.getAll()).map((r) => r.slug)).toEqual([
        "second",
        "first",
      ]);
    });

    test("an arrange naming a deleted page still orders the rest", async () => {
      // A stale reorder racing a delete must not fail: the gone page simply
      // matches no row.
      const a = await makePage("survivor", { sortOrder: 4 });
      await sitePageOrder.arrange({ keys: [9999, a.id] });
      sitePages.invalidate();
      const row = (await sitePages.getAll()).find((r) => r.slug === "survivor");
      expect(row?.sortOrder).toBe(1);
    });

    test("cache stats identify the site pages cache by name", () => {
      assertArrayIncludes(
        getAllCacheStats().map((stat) => stat.name),
        ["site_pages"],
      );
    });
  });
});
