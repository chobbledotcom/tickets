import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { updateNewsPost } from "#shared/db/news-posts.ts";
import {
  createSitePage,
  type SitePageWriteInput,
  updateSitePage,
} from "#shared/db/site-pages.ts";
import type { Result } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createTestNewsPost,
  createTestSitePage,
} from "#test-utils/db-helpers/misc.ts";

const pageInput = (slug: string): SitePageWriteInput => ({
  content: "",
  metaDescription: "",
  metaTitle: "",
  name: `Page ${slug}`,
  slug,
});

const renameNewsPost = (id: number, slug: string) =>
  updateNewsPost(id, {
    content: "",
    metaDescription: "",
    metaTitle: "",
    name: "Renamed",
    slug,
    snippet: "",
  });

const expectOneSlugConflict = <T>(
  results: Result<T, "notFound" | "slugTaken">[],
): void => {
  expect(results.filter((result) => result.ok).length).toBe(1);
  expect(results.filter((result) => !result.ok)).toEqual([
    { error: "slugTaken", ok: false },
  ]);
};

describeWithEnv("db > content slug writes", { db: true }, () => {
  describe("site pages", () => {
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

  describe("news posts", () => {
    test("concurrent updates settle as one rename and one slug conflict", async () => {
      const first = await createTestNewsPost("First race post");
      const second = await createTestNewsPost("Second race post");

      const results = await Promise.all([
        renameNewsPost(first.id, "same-news-slug"),
        renameNewsPost(second.id, "same-news-slug"),
      ]);

      expectOneSlugConflict(results);
    });

    test("update reports a missing post", async () => {
      expect(await renameNewsPost(99_999, "missing-news-post")).toEqual({
        error: "notFound",
        ok: false,
      });
    });
  });
});
