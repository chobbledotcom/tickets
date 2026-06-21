import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { encryptBytes } from "#shared/crypto/encryption.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminGet,
  assertAdminHtml,
  createTestManagerSession,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirectWithFlash,
  JPEG_HEADER,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  PDF_BYTES,
  testCookie,
  testCsrfToken,
  withCdnProxy,
  withCdnRejecting,
  withStorageDisabled,
  withStorageEnabled,
  withStorageMock,
} from "#test-utils";

const HEADER_IMAGE_POST = "/admin/settings/header-image";
const HEADER_IMAGE_DELETE = "/admin/settings/header-image/delete";
const HEADER_IMAGE_FORM_REDIRECT =
  "/admin/settings?form=settings-header-image#settings-header-image";
const HEADER_IMAGE_DELETE_FORM_REDIRECT =
  "/admin/settings?form=settings-header-image-delete#settings-header-image-delete";
const PROXY_URL = "/image/abc123-def4-5678-9abc-def012345678.jpg";

/** Submit a file to the header-image upload endpoint */
const submitHeaderImage = async (
  file: { name: string; data: Uint8Array; contentType: string },
  cookie?: string,
  csrfToken?: string,
): Promise<Response> => {
  const csrf = csrfToken ?? (await testCsrfToken());
  const ck = cookie ?? (await testCookie());
  return handleRequest(
    mockMultipartRequest(HEADER_IMAGE_POST, { csrf_token: csrf }, ck, {
      fieldName: "header_image",
      ...file,
    }),
  );
};

/** Submit a valid JPEG to the header-image upload endpoint */
const submitHeaderJpeg = (
  filename: string,
  cookie?: string,
  csrfToken?: string,
): Promise<Response> =>
  submitHeaderImage(
    { contentType: "image/jpeg", data: JPEG_HEADER, name: filename },
    cookie,
    csrfToken,
  );

/** Submit a POST to delete the header image */
const submitHeaderImageDelete = async (): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      HEADER_IMAGE_DELETE,
      { csrf_token: await testCsrfToken() },
      await testCookie(),
    ),
  );

/** Assert a response redirects back to /admin/settings (success case) */
const expectSettingsRedirect = (response: Response): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("/admin/settings");
};

describeWithEnv("server (header image settings)", { db: true }, () => {
  describe("GET /admin/settings (header image section)", () => {
    test("shows header image section when storage is enabled", async () => {
      await withStorageEnabled(async () => {
        const { response } = await adminGet("/admin/settings");
        await expectHtmlResponse(response, 200, "Header Image");
      });
    });

    test("hides header image section when storage is disabled", async () => {
      await withStorageDisabled(async () => {
        const html = await assertAdminHtml("/admin/settings");
        expect(html).not.toContain("Header Image");
      });
    });

    test("shows remove button and proxy URL when header image is set", async () => {
      await withStorageEnabled(async () => {
        await settings.update.headerImageUrl("existing.jpg");
        const { response } = await adminGet("/admin/settings");
        await expectHtmlResponse(
          response,
          200,
          "Remove Image",
          "/image/existing.jpg",
        );
      });
    });

    test("shows upload button when no header image exists", async () => {
      await withStorageEnabled(async () => {
        const { response } = await adminGet("/admin/settings");
        await expectHtmlResponse(response, 200, "Upload Image");
      });
    });
  });

  describe("POST /admin/settings/header-image", () => {
    test("stores uploaded header image URL with .jpg extension", async () => {
      await withStorageMock(async () => {
        const response = await submitHeaderJpeg("logo.jpg");
        expectSettingsRedirect(response);
        expect(settings.headerImageUrl).toMatch(/\.jpg$/);
      });
    });

    test("rejects non-image MIME type", async () => {
      await withStorageMock(async () => {
        const response = await submitHeaderImage({
          contentType: "application/pdf",
          data: PDF_BYTES,
          name: "doc.pdf",
        });
        await expectFlashRedirect(
          HEADER_IMAGE_FORM_REDIRECT,
          expect.stringContaining("JPEG, PNG, GIF, or WebP"),
          false,
        )(response);
      });
    });

    test("rejects oversized image", async () => {
      const oversized = new Uint8Array(257 * 1024);
      oversized.set(JPEG_HEADER);

      await withStorageMock(async () => {
        const response = await submitHeaderImage({
          contentType: "image/jpeg",
          data: oversized,
          name: "big.jpg",
        });
        await expectFlashRedirect(
          HEADER_IMAGE_FORM_REDIRECT,
          expect.stringContaining("256KB"),
          false,
        )(response);
      });
    });

    test("returns 403 for non-owner admin", async () => {
      await withStorageEnabled(async () => {
        const managerCookie = await createTestManagerSession(
          "mgr-header-session",
          "headerimgmgr",
        );
        const { signCsrfToken } = await import("#shared/csrf.ts");
        const signedCsrf = await signCsrfToken();
        const response = await submitHeaderJpeg(
          "logo.jpg",
          managerCookie,
          signedCsrf,
        );
        expect(response.status).toBe(403);
      });
    });

    test("rejects request with no file attached", async () => {
      await withStorageEnabled(async () => {
        const request = mockMultipartRequest(
          HEADER_IMAGE_POST,
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        );
        const response = await handleRequest(request);
        await expectFlashRedirect(
          HEADER_IMAGE_FORM_REDIRECT,
          expect.stringContaining("No image file provided"),
          false,
        )(response);
      });
    });

    test("reports error when storage is not configured", async () => {
      await withStorageDisabled(async () => {
        const response = await submitHeaderJpeg("logo.jpg");
        // Cookie-only: with storage disabled the upload form is hidden, so the
        // settings page the error redirects to has no field to render it under.
        expectRedirectWithFlash(
          HEADER_IMAGE_FORM_REDIRECT,
          expect.stringContaining("Image storage is not configured"),
          false,
        )(response);
      });
    });

    test("deletes old header image when uploading a new one", async () => {
      await settings.update.headerImageUrl("old-header.jpg");

      await withStorageMock(async (fetchCalls) => {
        const response = await submitHeaderJpeg("new-logo.jpg");
        expectSettingsRedirect(response);

        const deleteCall = fetchCalls.find((url) =>
          url.includes("old-header.jpg"),
        );
        expect(deleteCall).not.toBeUndefined();
        expect(settings.headerImageUrl).not.toBe("old-header.jpg");
      });
    });

    test("reports error when CDN upload fails", async () => {
      await withCdnRejecting(new Error("CDN unreachable"), async () => {
        const response = await submitHeaderJpeg("logo.jpg");
        await expectFlashRedirect(
          HEADER_IMAGE_FORM_REDIRECT,
          "Header image upload failed",
          false,
        )(response);
      });
    });

    test("rejects bytes whose magic number does not match declared type", async () => {
      await withStorageMock(async () => {
        const response = await submitHeaderImage({
          contentType: "image/jpeg",
          data: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
          name: "fake.jpg",
        });
        await expectFlashRedirect(
          HEADER_IMAGE_FORM_REDIRECT,
          expect.stringContaining("valid image"),
          false,
        )(response);
      });
    });
  });

  describe("POST /admin/settings/header-image/delete", () => {
    test("clears the stored header image URL", async () => {
      await settings.update.headerImageUrl("to-delete.jpg");

      await withStorageMock(async () => {
        const response = await submitHeaderImageDelete();
        expectSettingsRedirect(response);
        expect(settings.headerImageUrl).toBe("");
      });
    });

    test("reports error when there is no header image to remove", async () => {
      await withStorageEnabled(async () => {
        const response = await submitHeaderImageDelete();
        await expectFlashRedirect(
          HEADER_IMAGE_FORM_REDIRECT,
          expect.stringContaining("No header image to remove"),
          false,
        )(response);
      });
    });

    test("keeps DB record when CDN delete fails", async () => {
      await settings.update.headerImageUrl("failing.jpg");

      await withCdnRejecting(new Error("CDN unreachable"), async () => {
        const response = await submitHeaderImageDelete();
        await expectFlashRedirect(
          HEADER_IMAGE_DELETE_FORM_REDIRECT,
          "Header image removal failed",
          false,
        )(response);
        expect(settings.headerImageUrl).toBe("failing.jpg");
      });
    });
  });

  describe("GET /image/:filename (header image proxy)", () => {
    test("streams decrypted bytes with immutable cache headers", async () => {
      const encrypted = await encryptBytes(JPEG_HEADER);

      await withCdnProxy(
        () => new Response(encrypted.buffer as BodyInit),
        async () => {
          const response = await handleRequest(mockRequest(PROXY_URL));
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("image/jpeg");
          expect(response.headers.get("cache-control")).toContain("immutable");
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            JPEG_HEADER,
          );
        },
      );
    });

    test("returns 404 when storage is disabled", async () => {
      await withStorageDisabled(async () => {
        const response = await handleRequest(mockRequest(PROXY_URL));
        expect(response.status).toBe(404);
      });
    });

    test("returns 404 when CDN reports the object missing", async () => {
      await withCdnProxy(
        () => new Response(null, { status: 404 }),
        async () => {
          const response = await handleRequest(mockRequest(PROXY_URL));
          expect(response.status).toBe(404);
        },
      );
    });
  });
});
