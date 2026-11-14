import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteNewsPostWithImages } from "#db/news-posts.ts";
import { newsRecord } from "#shared/records/news.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import {
  expectNotFoundAfterRacingDelete,
  expectRecordDelete,
  expectRefused,
  expectWrittenAndLogged,
  testMissingUpdate,
} from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";

const postInput = (name: string, slug?: string) => ({
  content: "Body",
  metaDescription: "",
  metaTitle: "",
  name,
  snippet: "",
  ...(slug === undefined ? {} : { slug }),
});

describeRecord(newsRecord, "News post", "Post name", () => {
  test("creates a post and logs it with the post name", async () => {
    await expectWrittenAndLogged(
      newsRecord.create(postInput("Launch")),
      { content: "Body", id: 1, name: "Launch" },
      ["News post 'Launch' created"],
    );
  });

  test("updates a post under the slug it carries and logs it", async () => {
    const post = await createTestNewsPost("Before");

    await expectWrittenAndLogged(
      newsRecord.update(post.id, postInput("After", "after-slug")),
      { id: post.id, name: "After", slug: "after-slug" },
      ["News post 'After' updated"],
    );
  });

  test("refuses a slug that another post holds", async () => {
    const first = await createTestNewsPost("First");
    const second = await createTestNewsPost("Second");

    await expectRefused(
      newsRecord.update(second.id, postInput("Second", first.slug)),
      "That permalink is already used by another news post.",
    );
  });

  testMissingUpdate(newsRecord, postInput("Gone", "gone"));

  test("answers not-found when the post is deleted before the write", async () => {
    const post = await createTestNewsPost("Vanishing");

    await expectNotFoundAfterRacingDelete(
      () => deleteNewsPostWithImages(post.id),
      () => newsRecord.update(post.id, postInput("Vanishing", post.slug)),
    );
  });

  test("refuses an update that does not carry the stored slug", async () => {
    const post = await createTestNewsPost("Slug guard");

    await expect(
      newsRecord.update(post.id, postInput("Renamed")),
    ).rejects.toThrow("A news post update must carry its slug");
  });

  test("deletes a post and logs it with the post name", async () => {
    const post = await createTestNewsPost("Old news");

    await expectRecordDelete(newsRecord, post.id, [
      "News post 'Old news' deleted",
    ]);
  });
});
