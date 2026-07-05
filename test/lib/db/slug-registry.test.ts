import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  computeSitePageSlugIndex,
  sitePagesTable,
} from "#shared/db/site-pages.ts";
import { isSlugTakenAnywhere } from "#shared/db/slug-registry.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

const makePage = async (slug: string) =>
  sitePagesTable.insert({
    name: `Name ${slug}`,
    slug,
    slugIndex: await computeSitePageSlugIndex(slug),
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
});
