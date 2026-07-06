import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getDb } from "#shared/db/client.ts";
import { getAllImages } from "#shared/db/images.ts";
import {
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  getAllActivityLog,
  mockMultipartRequest,
  testCookie,
  testCsrfToken,
  withBunnyStorageStub,
  withCdnRejecting,
  withExpectedError,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils";
import {
  adminGet,
  imageUploadRequest,
  makeImage,
  postImageUpload,
} from "#test-utils/admin-images.ts";

describeWithEnv(
  "admin image library routes",
  { db: true, storage: "cdn" },
  () => {
    describe("GET /admin/images", () => {
      test("renders the empty state and image table", async () => {
        await expectHtmlResponse(
          await adminGet("/admin/images"),
          200,
          "No images yet.",
          "Add Image",
        );

        await makeImage("Hero");
        await expectHtmlResponse(
          await adminGet("/admin/images"),
          200,
          "Hero",
          'href="/admin/images/',
          "/image/hero-thumb.webp",
        );
      });

      test("shows only the storage-disabled state when storage is off", async () => {
        await makeImage("Hidden while disabled");

        await withStorageDisabled(async () => {
          await expectHtmlResponse(
            await adminGet("/admin/images"),
            200,
            "File storage is not configured.",
          );
          const html = await (await adminGet("/admin/images")).text();
          expect(html).not.toContain("Hidden while disabled");
          expect(html).not.toContain("Add Image");
        });
      });
    });

    describe("GET /admin/images/new", () => {
      test("renders the upload form", async () => {
        await expectHtmlResponse(
          await adminGet("/admin/images/new"),
          200,
          "Create image",
          'name="name"',
          'name="image"',
          'enctype="multipart/form-data"',
        );
      });

      test("redirects away from the upload form when storage is disabled", async () => {
        await withStorageDisabled(async () => {
          const response = await adminGet("/admin/images/new");
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
          )(response);
        });
      });
    });

    describe("POST /admin/images", () => {
      test("rejects direct uploads when storage is disabled", async () => {
        await withStorageDisabled(async () => {
          const response = await handleRequest(
            await imageUploadRequest(
              "/admin/images",
              await testCookie(),
              await testCsrfToken(),
              "Disabled upload",
            ),
          );
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
          )(response);
        });
        expect(await getAllImages()).toEqual([]);
      });

      test("rejects missing metadata before storage upload", async () => {
        const response = await handleRequest(
          mockMultipartRequest(
            "/admin/images",
            { alt_text: "", csrf_token: await testCsrfToken(), name: "" },
            await testCookie(),
          ),
        );

        await expectFlashRedirect(
          "/admin/images/new",
          "Image name is required",
          false,
        )(response);
        expect(await getAllImages()).toEqual([]);
      });

      test("rejects missing file before storage upload", async () => {
        const response = await handleRequest(
          mockMultipartRequest(
            "/admin/images",
            {
              alt_text: "Missing file alt",
              csrf_token: await testCsrfToken(),
              name: "Missing file",
            },
            await testCookie(),
          ),
        );

        await expectFlashRedirect(
          "/admin/images/new",
          "Choose an image file to upload",
          false,
        )(response);
        expect(await getAllImages()).toEqual([]);
      });

      test("rejects uploads when storage fails", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withExpectedError(async () => {
          await withCdnRejecting(new Error("upload down"), async () => {
            const response = await postImageUpload(
              "/admin/images",
              cookie,
              csrfToken,
              "Failed upload",
            );
            await expectFlashRedirect(
              "/admin/images/new",
              "Image upload failed: Error: upload down",
              false,
              cookie,
            )(response);
          });
        });
        expect(await getAllImages()).toEqual([]);
      });

      test("cleans up uploaded files when the image record cannot be created", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await getDb().execute("DROP TABLE images");
        await withBunnyStorageStub(
          () => new Response(null, { status: 201 }),
          async () => {
            await withExpectedError(async () => {
              const response = await postImageUpload(
                "/admin/images",
                cookie,
                csrfToken,
                "Unstored upload",
              );
              expect(response.status).toBe(503);
            });
          },
        );
      });

      test("uploads a new image record and redirects to its edit page", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const response = await postImageUpload(
            "/admin/images",
            cookie,
            csrfToken,
            "New library image",
          );
          const location = response.headers.get("location") ?? "";
          const path = new URL(location, "http://localhost").pathname;
          expect(path).toMatch(/^\/admin\/images\/\d+\/edit$/);
          await expectFlashRedirect(
            path,
            "Image created",
            true,
            cookie,
          )(response);
        });

        const [image] = await getAllImages();
        expect(image?.name).toBe("New library image");
        expect(image?.alt_text).toBe("Alt New library image");
        expect(image?.filename).toMatch(/\.webp$/);
        expect(image?.filename_thumb).toMatch(/\.webp$/);
        const messages = (await getAllActivityLog()).map(
          (entry) => entry.message,
        );
        expect(messages).toContain("Image 'New library image' uploaded");
      });
    });
  },
);
