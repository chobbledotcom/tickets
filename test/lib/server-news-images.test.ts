import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getImageUsesForImage } from "#shared/db/images.ts";
import {
  createTestNewsPost,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  testCookie,
  testCsrfToken,
  withStorageMock,
} from "#test-utils";
import {
  adminGet,
  formRequest,
  imageNamesForItem,
  makeImage,
  postImageUpload,
} from "#test-utils/admin-images.ts";

describeWithEnv("admin news image routes", { db: true, storage: "cdn" }, () => {
  describe("POST /admin/site/news/:id/images", () => {
    test("sets an ordered image collection on a post from existing images", async () => {
      const post = await createTestNewsPost("Illustrated post");
      const first = await makeImage("First news image");
      const second = await makeImage("Second news image");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await handleRequest(
        formRequest(
          `/admin/site/news/${post.id}/images`,
          [
            ["csrf_token", csrfToken],
            ["image_ids", String(second.id)],
            ["image_ids", String(first.id)],
          ],
          cookie,
        ),
      );

      await expectFlashRedirect(
        `/admin/site/news/${post.id}/edit`,
        "Images updated",
        true,
        cookie,
      )(response);
      expect(await imageNamesForItem("news", post.id)).toEqual([
        "Second news image",
        "First news image",
      ]);
    });

    test("404s for a missing post id", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        formRequest(
          "/admin/site/news/9999/images",
          [["csrf_token", csrfToken]],
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/site/news/:id/images/upload", () => {
    test("uploads a new image and appends it to the post", async () => {
      const post = await createTestNewsPost("Upload post");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await withStorageMock(async () => {
        const response = await postImageUpload(
          `/admin/site/news/${post.id}/images/upload`,
          cookie,
          csrfToken,
          "Fresh news image",
        );
        await expectFlashRedirect(
          `/admin/site/news/${post.id}/edit`,
          "Image uploaded",
          true,
          cookie,
        )(response);
      });
      expect(await imageNamesForItem("news", post.id)).toEqual([
        "Fresh news image",
      ]);
    });
  });

  describe("image library integration", () => {
    test("the image edit page offers news posts as link targets", async () => {
      const post = await createTestNewsPost("Linkable post");
      const image = await makeImage("Library image");
      const html = await expectHtmlResponse(
        await adminGet(`/admin/images/${image.id}/edit`),
        200,
      );
      expect(html).toContain(`value="news:${post.id}"`);
      expect(html).toContain("News: Linkable post");
    });

    test("saving the image edit form links it to a news post", async () => {
      const post = await createTestNewsPost("Target post");
      const image = await makeImage("Attach me");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await handleRequest(
        formRequest(
          `/admin/images/${image.id}/edit`,
          [
            ["csrf_token", csrfToken],
            ["name", "Attach me"],
            ["alt_text", "alt"],
            ["image_items", `news:${post.id}`],
          ],
          cookie,
        ),
      );

      expect([302, 303]).toContain(response.status);
      expect(await getImageUsesForImage(image.id)).toEqual([
        {
          image_id: image.id,
          item_id: post.id,
          item_type: "news",
          sort_order: 0,
        },
      ]);
    });
  });
});
