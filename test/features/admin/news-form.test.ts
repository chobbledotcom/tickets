import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { allEnglishMessages } from "#test-utils/i18n.ts";

await allEnglishMessages();
const { newsPostEditForm, newsPostForm, newsPostToValues } = await import(
  "#routes/admin/news-form.ts"
);

describe("news post forms", () => {
  test("a new post has no slug box — its permalink is auto-generated", () => {
    expect(newsPostForm.fields.map((f) => f.name)).toEqual([
      "name",
      "meta_title",
      "meta_description",
      "snippet",
      "content",
    ]);
  });

  test("the edit form adds the slug, linked to the live news page", () => {
    expect(newsPostEditForm.fields.map((f) => f.name)).toEqual([
      "name",
      "slug",
      "meta_title",
      "meta_description",
      "snippet",
      "content",
    ]);
    const slug = newsPostEditForm.fields[1] as {
      publicLinkPath?: (slug: string) => string;
    };
    expect(slug.publicLinkPath?.("hello")).toBe("/news/hello");
  });

  test("the snippet is a plain textarea capped at 500 characters", () => {
    const snippet = newsPostForm.fields.find((f) => f.name === "snippet");
    expect(snippet).toMatchObject({
      maxlength: 500,
      name: "snippet",
      type: "textarea",
    });
  });

  test("newsPostToValues pre-fills every edit field, snippet included", () => {
    const values = newsPostToValues({
      content: "Body",
      created_at: "2026-01-01T00:00:00Z",
      id: 1,
      meta_description: "Desc",
      meta_title: "Title",
      name: "Post",
      slug: "post-1",
      snippet: "Short",
    });
    expect(values).toEqual({
      content: "Body",
      meta_description: "Desc",
      meta_title: "Title",
      name: "Post",
      slug: "post-1",
      snippet: "Short",
    });
  });
});
