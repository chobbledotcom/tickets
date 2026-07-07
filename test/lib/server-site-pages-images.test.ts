import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  appendImageToItem,
  getImageById,
  getImageUsesForImage,
} from "#shared/db/images.ts";
import { createSitePage } from "#shared/db/site-pages.ts";
import {
  createTestManagerSession,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  testCookie,
  testCsrfToken,
  withStorageMock,
} from "#test-utils";
import {
  formRequest,
  imageNamesForItem,
  makeImage,
  postImageUpload,
} from "#test-utils/admin-images.ts";
import { mockRequest } from "#test-utils/mocks.ts";

const makePage = (name: string, slug: string) =>
  createSitePage({
    content: "",
    metaDescription: "",
    metaTitle: "",
    name,
    slug,
  });

describeWithEnv(
  "admin site-page image routes",
  { db: true, storage: "cdn" },
  () => {
    describe("POST /admin/site/pages/:id/images", () => {
      test("sets an ordered image collection on a page and bounces to the images tab", async () => {
        const page = await makePage("Illustrated page", "illus");
        const first = await makeImage("First page image");
        const second = await makeImage("Second page image");
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await handleRequest(
          formRequest(
            `/admin/site/pages/${page.id}/images`,
            [
              ["csrf_token", csrfToken],
              ["image_ids", String(second.id)],
              ["image_ids", String(first.id)],
            ],
            cookie,
          ),
        );

        await expectFlashRedirect(
          `/admin/site/pages/${page.id}/images`,
          "Images updated",
          true,
          cookie,
        )(response);
        expect(await imageNamesForItem("page", page.id)).toEqual([
          "Second page image",
          "First page image",
        ]);
      });

      test("404s for a missing page id", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();
        const response = await handleRequest(
          formRequest(
            "/admin/site/pages/9999/images",
            [["csrf_token", csrfToken]],
            cookie,
          ),
        );
        expect(response.status).toBe(404);
      });
    });

    describe("POST /admin/site/pages/:id/images/upload", () => {
      test("uploads a new image and appends it to the page", async () => {
        const page = await makePage("Upload page", "uploadp");
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const response = await postImageUpload(
            `/admin/site/pages/${page.id}/images/upload`,
            cookie,
            csrfToken,
            "Fresh page image",
          );
          await expectFlashRedirect(
            `/admin/site/pages/${page.id}/images`,
            "Image uploaded",
            true,
            cookie,
          )(response);
        });
        expect(await imageNamesForItem("page", page.id)).toEqual([
          "Fresh page image",
        ]);
      });
    });

    describe("the images tab", () => {
      test("renders the shared image panel for the page", async () => {
        const page = await makePage("Panel page", "panelp");
        const cookie = await testCookie();
        const html = await expectHtmlResponse(
          await handleRequest(
            mockRequest(`/admin/site/pages/${page.id}/images`, {
              headers: { cookie },
            }),
          ),
          200,
        );
        // The panel's set form posts back to the images route.
        expect(html).toContain(`action="/admin/site/pages/${page.id}/images"`);
      });
    });

    describe("image library integration", () => {
      const GATED =
        "This image is used by public site content — only site editors can manage it.";

      test("a site editor sees a page target and can link an image to it", async () => {
        const page = await makePage("Linkable page", "linkp");
        const image = await makeImage("Site image");
        const cookie = await testCookie();

        // The edit page offers the page as a checkbox to a Site role.
        const html = await expectHtmlResponse(
          await handleRequest(
            mockRequest(`/admin/images/${image.id}/edit`, {
              headers: { cookie },
            }),
          ),
          200,
        );
        expect(html).toContain(`value="page:${page.id}"`);

        // Saving with the page target linked persists it.
        const response = await handleRequest(
          formRequest(
            `/admin/images/${image.id}/edit`,
            [
              ["csrf_token", await signCsrfToken()],
              ["name", "Site image"],
              ["alt_text", ""],
              ["image_items", `page:${page.id}`],
            ],
            cookie,
          ),
        );
        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image updated",
          true,
          cookie,
        )(response);
        expect(await imageNamesForItem("page", page.id)).toEqual([
          "Site image",
        ]);
      });

      test("a manager sees no page targets and cannot edit a page-linked image", async () => {
        const page = await makePage("Guarded page", "guardp");
        const image = await makeImage("Guarded image");
        await appendImageToItem(image.id, {
          itemId: page.id,
          itemType: "page",
        });
        const managerCookie = await createTestManagerSession();

        const html = await expectHtmlResponse(
          await handleRequest(
            mockRequest(`/admin/images/${image.id}/edit`, {
              headers: { cookie: managerCookie },
            }),
          ),
          200,
        );
        expect(html).not.toContain(`value="page:${page.id}"`);

        const saveResponse = await handleRequest(
          formRequest(
            `/admin/images/${image.id}/edit`,
            [
              ["csrf_token", await signCsrfToken()],
              ["name", "Renamed by manager"],
              ["image_items", "page:9999"],
            ],
            managerCookie,
          ),
        );
        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          GATED,
          false,
          managerCookie,
        )(saveResponse);
        // Metadata unchanged and the page use survives.
        expect((await getImageById(image.id))?.name).toBe("Guarded image");
        expect(await getImageUsesForImage(image.id)).toEqual([
          {
            image_id: image.id,
            item_id: page.id,
            item_type: "page",
            sort_order: 0,
          },
        ]);
      });
    });
  },
);
