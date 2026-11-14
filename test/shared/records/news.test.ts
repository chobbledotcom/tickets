import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { deleteNewsPostWithImages, getNewsPostById } from "#db/news-posts.ts";
import { newsRecord } from "#shared/records/news.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";
import { beforeNextTransaction } from "#test-utils/record-queries.ts";

const postInput = (name: string) => ({
  content: "Body",
  metaDescription: "",
  metaTitle: "",
  name,
  snippet: "",
});

describe("the news record's declaration", () => {
  test("names a news post on its pages and its delete page", () => {
    expect(newsRecord.activityName).toBe("News post");
    expect(deleteConfirmLabel(newsRecord)).toBe("Post name");
  });
});

describeWithEnv("the news record's commands", { db: true }, () => {
  test("creates a post and logs it with the post name", async () => {
    const created = await newsRecord.create(postInput("Launch"));

    expect(created).toMatchObject({
      kind: "written",
      row: { content: "Body", id: 1, name: "Launch" },
    });
    expect(await activityMessages()).toEqual(["News post 'Launch' created"]);
  });

  test("updates a post under the slug it carries and logs it", async () => {
    const post = await createTestNewsPost("Before");

    const updated = await newsRecord.update(post.id, {
      ...postInput("After"),
      slug: "after-slug",
    });

    expect(updated).toMatchObject({
      kind: "written",
      row: { id: post.id, name: "After", slug: "after-slug" },
    });
    expect(await activityMessages()).toEqual(["News post 'After' updated"]);
  });

  test("refuses a slug that another post holds", async () => {
    const first = await createTestNewsPost("First");
    const second = await createTestNewsPost("Second");

    expect(
      await newsRecord.update(second.id, {
        ...postInput("Second"),
        slug: first.slug,
      }),
    ).toEqual({
      kind: "refused",
      message: "That permalink is already used by another news post.",
    });
  });

  test("answers not-found for an update of a missing post", async () => {
    expect(
      await newsRecord.update(99, { ...postInput("Gone"), slug: "gone" }),
    ).toEqual({ kind: "not-found" });
  });

  test("answers not-found when the post is deleted before the write", async () => {
    const post = await createTestNewsPost("Vanishing");
    const restore = beforeNextTransaction(() =>
      deleteNewsPostWithImages(post.id),
    );
    try {
      expect(
        await newsRecord.update(post.id, {
          ...postInput("Vanishing"),
          slug: post.slug,
        }),
      ).toEqual({ kind: "not-found" });
    } finally {
      restore();
    }
  });

  test("refuses an update that does not carry the stored slug", async () => {
    const post = await createTestNewsPost("Slug guard");

    await expect(
      newsRecord.update(post.id, postInput("Renamed")),
    ).rejects.toThrow("A news post update must carry its slug");
  });

  test("deletes a post and logs it with the post name", async () => {
    const post = await createTestNewsPost("Old news");

    expect(await newsRecord.remove(post.id)).toEqual({ kind: "deleted" });
    expect(await getNewsPostById(post.id)).toBe(null);
    expect(await activityMessages()).toEqual(["News post 'Old news' deleted"]);
  });
});
