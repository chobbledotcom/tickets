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

/** Checks the redirect, then that the saved post holds the given fields. */
const expectSavedPost = async (
  response: Response,
  id: number,
  flash: string,
  fields: Record<string, string>,
) => {
  expectRedirectWithFlash(`${BASE}/${id}/edit`, flash)(response);
  expect(await records.news_posts.find(id)).toMatchObject(fields);
};

/** Checks the post's image order and the activity log entry. */
const expectLinkedImages = async (
  id: number,
  name: string,
  imageNames: string[],
) => {
  expect(await imageNamesForItem("news", id)).toEqual(imageNames);
  expect(await loggedMessages()).toContain(`Images updated for news '${name}'`);
};

describeWithEnv("admin news routes", { db: true, storage: "cdn" }, () => {
  describe("create", () => {
    test("keeps the snippet and the shared content fields", async () => {
      const form = {
        content: "Body text",
        metaDescription: "Meta description",
        metaTitle: "Meta title",
        name: "Opening day",
        snippet: "Doors open at ten.",
      };

      const { response } = await adminFormPost(BASE, form);

      const [card] = await getNewsPostCards();
      await expectSavedPost(response, card!.id, "News post created", form);
    });
  });

  describe("edit", () => {
    test("normalises the slug and keeps the snippet", async () => {
      const post = await createTestNewsPost("Before");
      const form = { name: "After", snippet: "Half price." };

      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        ...form,
        slug: "  Spring Sale  ",
      });

      await expectSavedPost(response, post.id, "News post updated", {
        ...form,
        slug: "spring-sale",
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
      await expectLinkedImages(post.id, "Pictured post", ["Second", "First"]);
    });

    test("answers not found for a post that does not exist", async () => {
      const { response } = await adminFormPost(`${BASE}/9999/images`, {
        imageIds: "1",
      });

      expect(response.status).toBe(404);
    });
  });
});
