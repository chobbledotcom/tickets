import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createSitePage,
  type SitePageWriteInput,
  updateSitePage,
} from "#shared/db/site-pages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { expectOneSlugConflict } from "#test-utils/slug-conflicts.ts";

const pageInput = (slug: string): SitePageWriteInput => ({
  content: "",
  metaDescription: "",
  metaTitle: "",
  name: `Page ${slug}`,
  slug,
});

describeWithEnv("db > site page slug writes", { db: true }, () => {
  test("concurrent creates settle as one page and one slug conflict", async () => {
    const input = pageInput("same-concurrent-slug");

    const results = await Promise.all([
      createSitePage(input),
      createSitePage(input),
    ]);

    expectOneSlugConflict(results);
  });

  test("concurrent updates settle as one rename and one slug conflict", async () => {
    const first = await createTestSitePage("first-before-race");
    const second = await createTestSitePage("second-before-race");
    const rename = (id: number) =>
      updateSitePage(id, pageInput("shared-after-race"));

    const results = await Promise.all([rename(first.id), rename(second.id)]);

    expectOneSlugConflict(results);
  });

  test("create returns a conflict for a listing-owned slug", async () => {
    const listing = await createTestListing({ name: "Listing owner" });

    expect(await createSitePage(pageInput(listing.slug))).toEqual({
      error: "slugTaken",
      ok: false,
    });
  });

  test("update returns a conflict for a group-owned slug", async () => {
    const page = await createTestSitePage("page-before-group-conflict");
    await createTestGroup({ name: "Group owner", slug: "group-owned-slug" });

    expect(
      await updateSitePage(page.id, pageInput("group-owned-slug")),
    ).toEqual({ error: "slugTaken", ok: false });
  });

  test("the test page creator fails loudly for a duplicate slug", async () => {
    await createTestSitePage("duplicate-test-page");
    await expect(createTestSitePage("duplicate-test-page")).rejects.toThrow(
      "site page slug is already used: duplicate-test-page",
    );
  });
});
