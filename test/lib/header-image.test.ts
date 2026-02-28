import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getHeaderImageUrl,
  loadHeaderImage,
  resetHeaderImage,
  setHeaderImageForTest,
} from "#lib/header-image.ts";
import {
  getHeaderImageUrlFromDb,
  updateHeaderImageUrl,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import { encryptBytes } from "#lib/crypto.ts";
import {
  adminGet,
  createTestDbWithSetup,
  createTestManagerSession,
  expectHtmlResponse,
  loginAsAdmin,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** JPEG magic bytes for a valid test image */
const JPEG_HEADER = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);

/** Mock fetch to intercept Bunny CDN API calls */
const withStorageMock = async (
  fn: (fetchCalls: string[]) => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    fetchCalls.push(url);
    if (url.includes("storage.bunnycdn.com") || url.includes("b-cdn.net")) {
      return Promise.resolve(
        new Response(JSON.stringify({ HttpCode: 201, Message: "OK" }), {
          status: 201,
        }),
      );
    }
    return originalFetch(input, init);
  };

  try {
    await fn(fetchCalls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

describe("header image", () => {
  afterEach(() => {
    resetHeaderImage();
  });

  describe("getHeaderImageUrl", () => {
    test("defaults to null", () => {
      expect(getHeaderImageUrl()).toBeNull();
    });

    test("returns value set by setHeaderImageForTest", () => {
      setHeaderImageForTest("test-image.jpg");
      expect(getHeaderImageUrl()).toBe("test-image.jpg");
    });
  });

  describe("resetHeaderImage", () => {
    test("resets to null after being set", () => {
      setHeaderImageForTest("test-image.jpg");
      resetHeaderImage();
      expect(getHeaderImageUrl()).toBeNull();
    });
  });

  describe("loadHeaderImage", () => {
    beforeEach(async () => {
      resetTestSlugCounter();
      await createTestDbWithSetup();
      resetHeaderImage();
    });

    afterEach(() => {
      resetDb();
    });

    test("returns null when no header image is set", async () => {
      const url = await loadHeaderImage();
      expect(url).toBeNull();
    });

    test("returns filename after updating database", async () => {
      await updateHeaderImageUrl("my-header.jpg");
      const url = await loadHeaderImage();
      expect(url).toBe("my-header.jpg");
    });

    test("makes header image available via getHeaderImageUrl after loading", async () => {
      await updateHeaderImageUrl("my-header.png");
      await loadHeaderImage();
      expect(getHeaderImageUrl()).toBe("my-header.png");
    });

    test("returns null after clearing header image", async () => {
      await updateHeaderImageUrl("my-header.jpg");
      await updateHeaderImageUrl("");
      const url = await loadHeaderImage();
      expect(url).toBeNull();
    });
  });
});

describe("header image settings DB", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  test("getHeaderImageUrlFromDb returns null when not set", async () => {
    const url = await getHeaderImageUrlFromDb();
    expect(url).toBeNull();
  });

  test("getHeaderImageUrlFromDb returns decrypted filename after update", async () => {
    await updateHeaderImageUrl("abc123.jpg");
    const url = await getHeaderImageUrlFromDb();
    expect(url).toBe("abc123.jpg");
  });

  test("updateHeaderImageUrl with empty string clears the setting", async () => {
    await updateHeaderImageUrl("abc123.jpg");
    await updateHeaderImageUrl("");
    const url = await getHeaderImageUrlFromDb();
    expect(url).toBeNull();
  });
});

describe("server (header image settings)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    resetHeaderImage();
    await createTestDbWithSetup();
    Deno.env.set("STORAGE_ZONE_NAME", "testzone");
    Deno.env.set("STORAGE_ZONE_KEY", "testkey");
  });

  afterEach(() => {
    resetDb();
    resetHeaderImage();
    Deno.env.delete("STORAGE_ZONE_NAME");
    Deno.env.delete("STORAGE_ZONE_KEY");
  });

  describe("GET /admin/settings (header image section)", () => {
    test("shows header image section when storage is enabled", async () => {
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "Header Image");
    });

    test("hides header image section when storage is disabled", async () => {
      Deno.env.delete("STORAGE_ZONE_NAME");
      Deno.env.delete("STORAGE_ZONE_KEY");
      const { response } = await adminGet("/admin/settings");
      const html = await response.text();
      expect(html).not.toContain("Header Image");
    });

    test("shows remove button when header image is set", async () => {
      await updateHeaderImageUrl("existing.jpg");
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "Remove Image", "/image/existing.jpg");
    });

    test("shows upload button when no header image exists", async () => {
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "Upload Image");
    });
  });

  describe("POST /admin/settings/header-image", () => {
    test("uploads header image successfully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const request = mockMultipartRequest(
          "/admin/settings/header-image",
          { csrf_token: csrfToken },
          cookie,
          {
            fieldName: "header_image",
            name: "logo.jpg",
            data: JPEG_HEADER,
            contentType: "image/jpeg",
          },
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("/admin/settings");

        const url = await getHeaderImageUrlFromDb();
        expect(url).not.toBeNull();
        expect(url).toMatch(/\.jpg$/);
      });
    });

    test("rejects invalid image type", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const request = mockMultipartRequest(
          "/admin/settings/header-image",
          { csrf_token: csrfToken },
          cookie,
          {
            fieldName: "header_image",
            name: "doc.pdf",
            data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            contentType: "application/pdf",
          },
        );
        const response = await handleRequest(request);
        await expectHtmlResponse(response, 400, "JPEG, PNG, GIF, or WebP");
      });
    });

    test("rejects oversized image", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const oversized = new Uint8Array(257 * 1024);
      oversized[0] = 0xFF;
      oversized[1] = 0xD8;
      oversized[2] = 0xFF;

      await withStorageMock(async () => {
        const request = mockMultipartRequest(
          "/admin/settings/header-image",
          { csrf_token: csrfToken },
          cookie,
          {
            fieldName: "header_image",
            name: "big.jpg",
            data: oversized,
            contentType: "image/jpeg",
          },
        );
        const response = await handleRequest(request);
        await expectHtmlResponse(response, 400, "256KB");
      });
    });

    test("returns 403 for non-owner admin", async () => {
      const managerCookie = await createTestManagerSession("mgr-header-session", "headerimgmgr");
      const { signCsrfToken } = await import("#lib/csrf.ts");
      const signedCsrf = await signCsrfToken();
      const request = mockMultipartRequest(
        "/admin/settings/header-image",
        { csrf_token: signedCsrf },
        managerCookie,
        {
          fieldName: "header_image",
          name: "logo.jpg",
          data: JPEG_HEADER,
          contentType: "image/jpeg",
        },
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(403);
    });

    test("rejects request with no file", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const request = mockMultipartRequest(
        "/admin/settings/header-image",
        { csrf_token: csrfToken },
        cookie,
      );
      const response = await handleRequest(request);
      await expectHtmlResponse(response, 400, "No image file provided");
    });

    test("returns error when storage is not configured", async () => {
      Deno.env.delete("STORAGE_ZONE_NAME");
      Deno.env.delete("STORAGE_ZONE_KEY");
      const { cookie, csrfToken } = await loginAsAdmin();

      const request = mockMultipartRequest(
        "/admin/settings/header-image",
        { csrf_token: csrfToken },
        cookie,
        {
          fieldName: "header_image",
          name: "logo.jpg",
          data: JPEG_HEADER,
          contentType: "image/jpeg",
        },
      );
      const response = await handleRequest(request);
      await expectHtmlResponse(response, 400, "Image storage is not configured");
    });

    test("deletes old header image when uploading new one", async () => {
      await updateHeaderImageUrl("old-header.jpg");
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async (fetchCalls) => {
        const request = mockMultipartRequest(
          "/admin/settings/header-image",
          { csrf_token: csrfToken },
          cookie,
          {
            fieldName: "header_image",
            name: "new-logo.jpg",
            data: JPEG_HEADER,
            contentType: "image/jpeg",
          },
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("/admin/settings");

        const deleteCall = fetchCalls.find((url) =>
          url.includes("old-header.jpg")
        );
        expect(deleteCall).not.toBeUndefined();

        const url = await getHeaderImageUrlFromDb();
        expect(url).toMatch(/\.jpg$/);
        expect(url).not.toBe("old-header.jpg");
      });
    });

    test("rejects mismatched magic bytes", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const request = mockMultipartRequest(
          "/admin/settings/header-image",
          { csrf_token: csrfToken },
          cookie,
          {
            fieldName: "header_image",
            name: "fake.jpg",
            data: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
            contentType: "image/jpeg",
          },
        );
        const response = await handleRequest(request);
        await expectHtmlResponse(response, 400, "valid image");
      });
    });
  });

  describe("POST /admin/settings/header-image/delete", () => {
    test("removes header image", async () => {
      await updateHeaderImageUrl("to-delete.jpg");
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const request = mockFormRequest(
          "/admin/settings/header-image/delete",
          { csrf_token: csrfToken },
          cookie,
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("/admin/settings");

        const url = await getHeaderImageUrlFromDb();
        expect(url).toBeNull();
      });
    });

    test("returns error when no header image exists", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const request = mockFormRequest(
        "/admin/settings/header-image/delete",
        { csrf_token: csrfToken },
        cookie,
      );
      const response = await handleRequest(request);
      await expectHtmlResponse(response, 400, "No header image to remove");
    });

    test("succeeds even when storage delete throws", async () => {
      await updateHeaderImageUrl("failing.jpg");
      const { cookie, csrfToken } = await loginAsAdmin();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (): Promise<Response> => {
        return Promise.reject(new Error("CDN unreachable"));
      };

      try {
        const request = mockFormRequest(
          "/admin/settings/header-image/delete",
          { csrf_token: csrfToken },
          cookie,
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("/admin/settings");

        const url = await getHeaderImageUrlFromDb();
        expect(url).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("header image in layout", () => {
    test("renders header image in page when set", async () => {
      await updateHeaderImageUrl("my-header.jpg");
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, 'class="header-image"', "/image/my-header.jpg");
    });

    test("does not render header image when not set", async () => {
      resetHeaderImage();
      const { response } = await adminGet("/admin/settings");
      const html = await response.text();
      expect(html).not.toContain('class="header-image"');
    });
  });

  describe("header image proxy", () => {
    test("serves header image via proxy route", async () => {
      const imageData = JPEG_HEADER;
      const encrypted = await encryptBytes(imageData);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string"
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
        expect(response.headers.get("content-type")).toBe("image/jpeg");
        expect(response.headers.get("cache-control")).toContain("immutable");
        const body = new Uint8Array(await response.arrayBuffer());
        expect(body).toEqual(imageData);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
