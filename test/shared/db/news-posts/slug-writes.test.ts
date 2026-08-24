import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { updateNewsPost } from "#db/news-posts.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { expectOneSlugConflict } from "#test-utils/slug-conflicts.ts";

const renameNewsPost = (id: number, slug: string) =>
  updateNewsPost(id, {
    content: "",
    metaDescription: "",
    metaTitle: "",
    name: "Renamed",
    slug,
    snippet: "",
  });

describeWithEnv("db > news post slug writes", { db: true }, () => {
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
