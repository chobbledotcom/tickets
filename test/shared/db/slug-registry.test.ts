import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { createSitePage, sitePages, updateSitePage } from "#db/site-pages.ts";
import { isSlugTakenAnywhere } from "#db/slug-registry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const pageInput = (name: string, slug: string) => ({
  content: `The ${name} body.`,
  metaDescription: `${name} description`,
  metaTitle: `${name} title`,
  name,
  slug,
});

const makePage = async (slug: string) =>
  sitePages.table.insert({
    name: `Name ${slug}`,
    slug,
    slugIndex: await hmacHash(slug),
    sortOrder: 0,
  });

describeWithEnv("db > slug-registry", { db: true }, () => {
  test("a free slug is not taken", async () => {
    expect(await isSlugTakenAnywhere("nothing-here")).toBe(false);
  });

  test("detects a slug owned by a listing, a group, or a page", async () => {
    const listing = await createTestListing({ name: "L" });
    await createTestGroup({ name: "G", slug: "group-slug" });
    await makePage("page-slug");
    expect(await isSlugTakenAnywhere(listing.slug)).toBe(true);
    expect(await isSlugTakenAnywhere("group-slug")).toBe(true);
    expect(await isSlugTakenAnywhere("page-slug")).toBe(true);
  });

  test("exclude skips the named row so it can keep its own slug", async () => {
    const page = await makePage("keep");
    // Excluding the page itself frees the slug (only that row owns it)…
    expect(
      await isSlugTakenAnywhere("keep", { id: page.id, table: "site_pages" }),
    ).toBe(false);
    // …but excluding an unrelated table's row does not (the page still owns it).
    expect(
      await isSlugTakenAnywhere("keep", { id: 999, table: "listings" }),
    ).toBe(true);
  });

  test("the shared update names a missing row and a slug another page owns", async () => {
    const mine = await createSitePage(pageInput("My Page", "mine"));
    const other = await createSitePage(pageInput("Other Page", "other"));
    expect(mine.ok).toBe(true);
    expect(other.ok).toBe(true);

    const missing = await updateSitePage(-1, pageInput("Ghost Page", "ghost"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBe("notFound");
    }

    const taken =
      mine.ok && other.ok
        ? await updateSitePage(mine.value.id, pageInput("My Page", "other"))
        : null;
    expect(taken?.ok).toBe(false);
    if (taken && !taken.ok) {
      expect(taken.error).toBe("slugTaken");
    }
  });
});
