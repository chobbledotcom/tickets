import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { encryptBytes } from "#lib/crypto.ts";
import { settings } from "#lib/db/settings.ts";
import { resetHeaderImage, setHeaderImageForTest } from "#lib/header-image.ts";
import { handleRequest } from "#routes";
import {
  adminGet,
  assertAdminHtml,
  createTestManagerSession,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  JPEG_HEADER,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  setTestEnv,
  testCookie,
  testCsrfToken,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils";

/** Submit a file to the header-image upload endpoint */
const submitHeaderImage = async (
  file: {
    name: string;
    data: Uint8Array;
    contentType: string;
  },
  cookie?: string,
  csrfToken?: string,
): Promise<Response> => {
  const csrf = csrfToken ?? (await testCsrfToken());
  const ck = cookie ?? (await testCookie());
  return handleRequest(
    mockMultipartRequest(
      "/admin/settings/header-image",
      { csrf_token: csrf },
      ck,
      { fieldName: "header_image", ...file },
    ),
  );
};

/** Submit a JPEG to the header-image upload endpoint */
const submitHeaderJpeg = (
  filename: string,
  cookie?: string,
  csrfToken?: string,
): Promise<Response> =>
  submitHeaderImage(
    { name: filename, data: JPEG_HEADER, contentType: "image/jpeg" },
    cookie,
    csrfToken,
  );

/** Submit a POST to delete the header image */
const submitHeaderImageDelete = async (
  cookie?: string,
  csrfToken?: string,
): Promise<Response> => {
  const csrf = csrfToken ?? (await testCsrfToken());
  const ck = cookie ?? (await testCookie());
  return handleRequest(
    mockFormRequest(
      "/admin/settings/header-image/delete",
      { csrf_token: csrf },
      ck,
    ),
  );
};

/** Assert response is a 302 redirect to /admin/settings */
const expectSettingsRedirect = (response: Response): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("/admin/settings");
};

describe("header image", () => {
  afterEach(() => {
    resetHeaderImage();
  });

  describe("settings.headerImageUrl", () => {
    test("defaults to empty string", () => {
      expect(settings.headerImageUrl).toBe("");
    });

    test("returns value set by setHeaderImageForTest", () => {
      setHeaderImageForTest("test-image.jpg");
      expect(settings.headerImageUrl).toBe("test-image.jpg");
    });
  });

  describe("resetHeaderImage", () => {
    test("resets to empty string after being set", () => {
      setHeaderImageForTest("test-image.jpg");
      resetHeaderImage();
      expect(settings.headerImageUrl).toBe("");
    });
  });
});

describeWithEnv("header image settings DB", { db: true }, () => {
  test("getHeaderImageUrlFromDb returns empty string when not set", () => {
    const url = settings.headerImageUrl;
    expect(url).toBe("");
  });

  test("getHeaderImageUrlFromDb returns decrypted filename after update", async () => {
    await settings.update.headerImageUrl("abc123.jpg");
    const url = settings.headerImageUrl;
    expect(url).toBe("abc123.jpg");
  });

  test("updateHeaderImageUrl with empty string clears the setting", async () => {
    await settings.update.headerImageUrl("abc123.jpg");
    await settings.update.headerImageUrl("");
    const url = settings.headerImageUrl;
    expect(url).toBe("");
  });
});

describeWithEnv(
  "server (header image settings)",
  {
    env: {
      STORAGE_ZONE_NAME: "testzone",
      STORAGE_ZONE_KEY: "testkey",
    },
    db: true,
  },
  () => {
    beforeEach(() => {
      resetHeaderImage();
    });

    afterEach(() => {
      resetHeaderImage();
    });

    describe("GET /admin/settings (header image section)", () => {
      test("shows header image section when storage is enabled", async () => {
        const { response } = await adminGet("/admin/settings");
        await expectHtmlResponse(response, 200, "Header Image");
      });

      describeWithEnv(
        "when storage is disabled",
        { env: { STORAGE_ZONE_NAME: undefined, STORAGE_ZONE_KEY: undefined } },
        () => {
          test("hides header image section", async () => {
            await withStorageDisabled(async () => {
              const html = await assertAdminHtml("/admin/settings");
              expect(html).not.toContain("Header Image");
            });
          });
        },
      );

      test("shows remove button when header image is set", async () => {
        await settings.update.headerImageUrl("existing.jpg");
        const { response } = await adminGet("/admin/settings");
        await expectHtmlResponse(
          response,
          200,
          "Remove Image",
          "/image/existing.jpg",
        );
      });

      test("shows upload button when no header image exists", async () => {
        const { response } = await adminGet("/admin/settings");
        await expectHtmlResponse(response, 200, "Upload Image");
      });
    });

    describe("POST /admin/settings/header-image", () => {
      test("uploads header image successfully", async () => {
        await withStorageMock(async () => {
          const response = await submitHeaderJpeg("logo.jpg");
          expectSettingsRedirect(response);

          const url = settings.headerImageUrl;
          expect(url).not.toBeNull();
          expect(url).toMatch(/\.jpg$/);
        });
      });

      test("rejects invalid image type", async () => {
        await withStorageMock(async () => {
          const response = await submitHeaderImage({
            name: "doc.pdf",
            data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            contentType: "application/pdf",
          });
          await expectHtmlResponse(response, 400, "JPEG, PNG, GIF, or WebP");
        });
      });

      test("rejects oversized image", async () => {
        const oversized = new Uint8Array(257 * 1024);
        oversized[0] = 0xff;
        oversized[1] = 0xd8;
        oversized[2] = 0xff;

        await withStorageMock(async () => {
          const response = await submitHeaderImage({
            name: "big.jpg",
            data: oversized,
            contentType: "image/jpeg",
          });
          await expectHtmlResponse(response, 400, "256KB");
        });
      });

      test("returns 403 for non-owner admin", async () => {
        const managerCookie = await createTestManagerSession(
          "mgr-header-session",
          "headerimgmgr",
        );
        const { signCsrfToken } = await import("#lib/csrf.ts");
        const signedCsrf = await signCsrfToken();
        const response = await submitHeaderJpeg(
          "logo.jpg",
          managerCookie,
          signedCsrf,
        );
        expect(response.status).toBe(403);
      });

      test("rejects request with no file", async () => {
        const request = mockMultipartRequest(
          "/admin/settings/header-image",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        );
        const response = await handleRequest(request);
        await expectHtmlResponse(response, 400, "No image file provided");
      });

      describeWithEnv(
        "when storage is not configured",
        { env: { STORAGE_ZONE_NAME: undefined, STORAGE_ZONE_KEY: undefined } },
        () => {
          test("returns error", async () => {
            await withStorageDisabled(async () => {
              const response = await submitHeaderJpeg("logo.jpg");
              await expectHtmlResponse(
                response,
                400,
                "Image storage is not configured",
              );
            });
          });
        },
      );

      test("deletes old header image when uploading new one", async () => {
        await settings.update.headerImageUrl("old-header.jpg");

        await withStorageMock(async (fetchCalls) => {
          const response = await submitHeaderJpeg("new-logo.jpg");
          expectSettingsRedirect(response);

          const deleteCall = fetchCalls.find((url) =>
            url.includes("old-header.jpg"),
          );
          expect(deleteCall).not.toBeUndefined();

          const url = settings.headerImageUrl;
          expect(url).toMatch(/\.jpg$/);
          expect(url).not.toBe("old-header.jpg");
        });
      });

      test("reports error when upload fails", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (): Promise<Response> => {
          return Promise.reject(new Error("CDN unreachable"));
        };

        try {
          const response = await submitHeaderJpeg("logo.jpg");
          expect(response.status).toBe(302);
          expectFlash(response, "Header image upload failed", false);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("rejects mismatched magic bytes", async () => {
        await withStorageMock(async () => {
          const response = await submitHeaderImage({
            name: "fake.jpg",
            data: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
            contentType: "image/jpeg",
          });
          await expectHtmlResponse(response, 400, "valid image");
        });
      });
    });

    describe("POST /admin/settings/header-image/delete", () => {
      test("removes header image", async () => {
        await settings.update.headerImageUrl("to-delete.jpg");

        await withStorageMock(async () => {
          const response = await submitHeaderImageDelete();
          expectSettingsRedirect(response);

          const url = settings.headerImageUrl;
          expect(url).toBe("");
        });
      });

      test("returns error when no header image exists", async () => {
        const response = await submitHeaderImageDelete();
        await expectHtmlResponse(response, 400, "No header image to remove");
      });

      test("reports error when storage delete throws", async () => {
        await settings.update.headerImageUrl("failing.jpg");

        const originalFetch = globalThis.fetch;
        globalThis.fetch = (): Promise<Response> => {
          return Promise.reject(new Error("CDN unreachable"));
        };

        try {
          const response = await submitHeaderImageDelete();
          expect(response.status).toBe(302);
          expectFlash(response, "Header image removal failed", false);

          // DB record should NOT be cleared when CDN delete fails
          const url = settings.headerImageUrl;
          expect(url).toBe("failing.jpg");
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    });

    describe("header image in layout", () => {
      test("renders header image in page when set", async () => {
        await settings.update.headerImageUrl("my-header.jpg");
        const { response } = await adminGet("/admin/settings");
        await expectHtmlResponse(
          response,
          200,
          'class="header-image"',
          "/image/my-header.jpg",
        );
      });

      test("does not render header image when not set", async () => {
        resetHeaderImage();
        const html = await assertAdminHtml("/admin/settings");
        expect(html).not.toContain('class="header-image"');
      });
    });

    describe("header image proxy", () => {
      test("serves header image via proxy route", async () => {
        const encrypted = await encryptBytes(JPEG_HEADER);

        // Set storage env vars in the test body so concurrent tests that
        // clear them (e.g. "when storage is disabled") don't cause a race
        // where isStorageEnabled() returns false.
        const restoreEnv = setTestEnv({
          STORAGE_ZONE_NAME: "testzone",
          STORAGE_ZONE_KEY: "testkey",
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (
          input: string | URL | Request,
        ): Promise<Response> => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (url.includes("storage.bunnycdn.com")) {
            return Promise.resolve(
              // deno-lint-ignore no-explicit-any
              new Response(encrypted as any, { status: 200 }),
            );
          }
          return originalFetch(input);
        };

        try {
          const response = await handleRequest(
            mockRequest("/image/abc123-def4-5678-9abc-def012345678.jpg"),
          );
          expect(response.status).toBe(200);
          const headers = response.headers;
          expect(headers.get("content-type")).toBe("image/jpeg");
          expect(headers.get("cache-control")).toContain("immutable");
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            JPEG_HEADER,
          );
        } finally {
          globalThis.fetch = originalFetch;
          restoreEnv();
        }
      });
    });
  },
);
