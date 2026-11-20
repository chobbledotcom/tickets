/** The News routes under Site: the writes the news record owns, and the image
 * panel that its content handlers bind. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getNewsPostCards } from "#db/news-posts.ts";
import { records } from "#db/record-table.ts";
import { loggedMessages } from "#test-utils/activity-log.ts";
import { imageNamesForItem, makeImage } from "#test-utils/admin-images.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { adminFormPost } from "#test-utils/session.ts";

const BASE = "/admin/site/news";

describeWithEnv("admin news routes", { db: true, storage: "cdn" }, () => {
  describe("create", () => {
    test("keeps the snippet and the shared content fields", async () => {
      const { response } = await adminFormPost(BASE, {
        content: "Body text",
        metaDescription: "Meta description",
        metaTitle: "Meta title",
        name: "Opening day",
        snippet: "Doors open at ten.",
      });

      const [card] = await getNewsPostCards();
      const post = (await records.news_posts.find(card!.id))!;
      expectRedirectWithFlash(
        `${BASE}/${post.id}/edit`,
        "News post created",
      )(response);
      expect(post).toMatchObject({
        content: "Body text",
        metaDescription: "Meta description",
        metaTitle: "Meta title",
        name: "Opening day",
        snippet: "Doors open at ten.",
      });
    });
  });

  describe("edit", () => {
    test("normalises the slug and keeps the snippet", async () => {
      const post = await createTestNewsPost("Before");

      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        name: "After",
        slug: "  Spring Sale  ",
        snippet: "Half price.",
      });

      expectRedirectWithFlash(
        `${BASE}/${post.id}/edit`,
        "News post updated",
      )(response);
      expect(await records.news_posts.find(post.id)).toMatchObject({
        name: "After",
        slug: "spring-sale",
        snippet: "Half price.",
      });
    });
  });

  describe("images", () => {
    test("links the chosen images to the post and logs it", async () => {
      const post = await createTestNewsPost("Pictured post");
      const first = await makeImage("First");
      const second = await makeImage("Second");

      const { response } = await adminFormPost(`${BASE}/${post.id}/images`, {
        imageIds: [second.id, first.id].map(String),
      });

      expectRedirectWithFlash(
        `${BASE}/${post.id}/images`,
        "Images updated",
      )(response);
      expect(await imageNamesForItem("news", post.id)).toEqual([
        "Second",
        "First",
      ]);
      expect(await loggedMessages()).toContain(
        "Images updated for news 'Pictured post'",
      );
    });

    test("answers not found for a post that does not exist", async () => {
      const { response } = await adminFormPost(`${BASE}/9999/images`, {
        imageIds: "1",
      });

      expect(response.status).toBe(404);
    });
  });
});
