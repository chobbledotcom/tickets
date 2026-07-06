import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { appendImageToItem, getImageUsesForImage } from "#shared/db/images.ts";
import {
  createTestManagerSession,
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
import { mockRequest } from "#test-utils/mocks.ts";

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
    test("a manager sees no news targets and cannot attach or detach them", async () => {
      const post = await createTestNewsPost("Manager-proof post");
      const image = await makeImage("Managed image");
      await appendImageToItem(image.id, { itemId: post.id, itemType: "news" });
      const managerCookie = await createTestManagerSession();

      // The edit page offers no news checkboxes to a manager (Site-gated).
      const pageResponse = await handleRequest(
        mockRequest(`/admin/images/${image.id}/edit`, {
          headers: { cookie: managerCookie },
        }),
      );
      const html = await expectHtmlResponse(pageResponse, 200);
      expect(html).not.toContain(`value="news:${post.id}"`);

      // A manager's save — even one smuggling a news target and omitting the
      // existing link — leaves the post's image links exactly as they were.
      const saveResponse = await handleRequest(
        formRequest(
          `/admin/images/${image.id}/edit`,
          [
            ["csrf_token", await signCsrfToken()],
            ["name", "Managed image"],
            ["alt_text", "alt"],
            ["image_items", "news:9999"],
          ],
          managerCookie,
        ),
      );
      expect([302, 303]).toContain(saveResponse.status);
      expect(await getImageUsesForImage(image.id)).toEqual([
        {
          image_id: image.id,
          item_id: post.id,
          item_type: "news",
          sort_order: 0,
        },
      ]);
    });

    test("a manager cannot delete an image that a news post uses", async () => {
      const post = await createTestNewsPost("Guarded post");
      const image = await makeImage("News-linked image");
      await appendImageToItem(image.id, { itemId: post.id, itemType: "news" });
      const managerCookie = await createTestManagerSession();

      const response = await handleRequest(
        formRequest(
          `/admin/images/${image.id}/delete`,
          [
            ["csrf_token", await signCsrfToken()],
            ["confirm_identifier", "News-linked image"],
          ],
          managerCookie,
        ),
      );
      // Blocked with an error flash; the image and its news use both survive.
      await expectFlashRedirect(
        `/admin/images/${image.id}/delete`,
        "This image is used by a news post — only site editors can delete it.",
        false,
        managerCookie,
      )(response);
      expect(await imageNamesForItem("news", post.id)).toEqual([
        "News-linked image",
      ]);
    });

    test("the image edit page offers news posts as link targets", async () => {
      const post = await createTestNewsPost("Linkable post");
      const image = await makeImage("Library image");
      const html = await expectHtmlResponse(
        await adminGet(`/admin/images/${image.id}/edit`),
        200,
      );
      expect(html).toContain(`value="news:${post.id}"`);
      expect(html).toContain("Linked news");
      expect(html).toContain("Linkable post");
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
