import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { handleRequest } from "#routes";
import {
  createTestDbWithSetup,
  createTestEvent,
  loginAsAdmin,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";
import { storageApi } from "#lib/storage.ts";
import { encryptBytes } from "#lib/crypto.ts";
import { eventsTable, getEventWithCount } from "#lib/db/events.ts";

/** JPEG magic bytes for a valid test image */
const JPEG_HEADER = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);

/** Create a multipart image upload request with authentication */
const imageUploadRequest = (
  path: string,
  csrfToken: string,
  imageData: Uint8Array,
  filename: string,
  contentType: string,
  cookie: string,
): Request => {
  const formData = new FormData();
  formData.append("csrf_token", csrfToken);
  // deno-lint-ignore no-explicit-any
  const blob = new Blob([imageData as any], { type: contentType });
  formData.append("image", blob, filename);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: formData,
    headers: { cookie, host: "localhost" },
  });
};

/** Create a form POST request with cookie */
const formPostRequest = (
  path: string,
  data: Record<string, string>,
  cookie: string,
): Request => {
  const body = new URLSearchParams(data).toString();
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      host: "localhost",
    },
  });
};

/** Mock the storage zone and intercept Bunny API fetch calls */
const withStorageMock = async (
  fn: (fetchCalls: string[]) => Promise<void>,
): Promise<void> => {
  const spy = spyOn(storageApi, "connectZone");
  spy.mockReturnValue({
    _tag: "StorageZone" as const,
    region: "de" as never,
    accessKey: "mock-key",
    name: "testzone",
  });

  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push(url);
    if (url.includes("storage.bunnycdn.com")) {
      return Promise.resolve(new Response(JSON.stringify({ HttpCode: 201, Message: "OK" }), { status: 201 }));
    }
    return originalFetch(input, init);
  };

  try {
    await fn(fetchCalls);
  } finally {
    globalThis.fetch = originalFetch;
    spy.mockRestore();
  }
};

describe("server (event images)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    Deno.env.set("STORAGE_ZONE_NAME", "testzone");
    Deno.env.set("STORAGE_ZONE_KEY", "testkey");
  });

  afterEach(() => {
    resetDb();
    Deno.env.delete("STORAGE_ZONE_NAME");
    Deno.env.delete("STORAGE_ZONE_KEY");
  });

  describe("POST /admin/event/:id/image", () => {
    test("returns 400 when storage is not configured", async () => {
      Deno.env.delete("STORAGE_ZONE_NAME");
      Deno.env.delete("STORAGE_ZONE_KEY");
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const request = imageUploadRequest(
        `/admin/event/${event.id}/image`,
        csrfToken,
        JPEG_HEADER,
        "test.jpg",
        "image/jpeg",
        cookie,
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Image storage is not configured");
    });

    test("redirects when no file is uploaded", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const formData = new FormData();
      formData.append("csrf_token", csrfToken);
      const request = new Request(`http://localhost/admin/event/${event.id}/image`, {
        method: "POST",
        body: formData,
        headers: { cookie, host: "localhost" },
      });

      const response = await handleRequest(request);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);
    });

    test("redirects with error when file is too large", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const largeData = new Uint8Array(256 * 1024 + 1);
      largeData[0] = 0xFF;
      largeData[1] = 0xD8;
      largeData[2] = 0xFF;

      const request = imageUploadRequest(
        `/admin/event/${event.id}/image`,
        csrfToken,
        largeData,
        "huge.jpg",
        "image/jpeg",
        cookie,
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(302);
      const location = response.headers.get("location") || "";
      expect(location).toContain("image_error=");
      expect(decodeURIComponent(location)).toContain("256KB");
    });

    test("redirects with error when file type is invalid", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const request = imageUploadRequest(
        `/admin/event/${event.id}/image`,
        csrfToken,
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        "test.pdf",
        "application/pdf",
        cookie,
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(302);
      const location = response.headers.get("location") || "";
      expect(location).toContain("image_error=");
    });

    test("uploads image and updates event", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const request = imageUploadRequest(
          `/admin/event/${event.id}/image`,
          csrfToken,
          JPEG_HEADER,
          "photo.jpg",
          "image/jpeg",
          cookie,
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);

        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).not.toBeNull();
        expect(updated?.image_url).toMatch(/\.jpg$/);
      });
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const request = imageUploadRequest(
        "/admin/event/9999/image",
        csrfToken,
        JPEG_HEADER,
        "photo.jpg",
        "image/jpeg",
        cookie,
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(404);
    });

    test("deletes old image when uploading new one", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      await eventsTable.update(event.id, { imageUrl: "old-image.jpg" });

      await withStorageMock(async (fetchCalls) => {
        const request = imageUploadRequest(
          `/admin/event/${event.id}/image`,
          csrfToken,
          JPEG_HEADER,
          "new-photo.jpg",
          "image/jpeg",
          cookie,
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);

        const deleteCall = fetchCalls.find((url) => url.includes("old-image.jpg"));
        expect(deleteCall).not.toBeUndefined();
      });
    });
  });

  describe("POST /admin/event/:id/image/delete", () => {
    test("removes image from event and storage", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      await eventsTable.update(event.id, { imageUrl: "to-delete.jpg" });

      await withStorageMock(async () => {
        const request = formPostRequest(
          `/admin/event/${event.id}/image/delete`,
          { csrf_token: csrfToken },
          cookie,
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);

        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toBeNull();
      });
    });

    test("redirects when event has no image", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const request = formPostRequest(
        `/admin/event/${event.id}/image/delete`,
        { csrf_token: csrfToken },
        cookie,
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const request = formPostRequest(
        "/admin/event/9999/image/delete",
        { csrf_token: csrfToken },
        cookie,
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(404);
    });

    test("succeeds even when storage delete throws", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();
      await eventsTable.update(event.id, { imageUrl: "failing.jpg" });

      const spy = spyOn(storageApi, "connectZone");
      spy.mockReturnValue({
        _tag: "StorageZone" as const,
        region: "de" as never,
        accessKey: "mock-key",
        name: "testzone",
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (): Promise<Response> => {
        return Promise.reject(new Error("CDN unreachable"));
      };

      try {
        const request = formPostRequest(
          `/admin/event/${event.id}/image/delete`,
          { csrf_token: csrfToken },
          cookie,
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
        spy.mockRestore();
      }
    });
  });

  describe("POST /admin/event/:id/image (error paths)", () => {
    test("succeeds even when old image delete throws", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();
      await eventsTable.update(event.id, { imageUrl: "old-failing.jpg" });

      const spy = spyOn(storageApi, "connectZone");
      spy.mockReturnValue({
        _tag: "StorageZone" as const,
        region: "de" as never,
        accessKey: "mock-key",
        name: "testzone",
      });
      const originalFetch = globalThis.fetch;
      let callCount = 0;
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        callCount++;
        // First call is the delete of old image — make it fail
        if (url.includes("old-failing.jpg")) {
          return Promise.reject(new Error("CDN delete failed"));
        }
        // Upload call succeeds
        if (url.includes("storage.bunnycdn.com")) {
          return Promise.resolve(new Response(JSON.stringify({ HttpCode: 201, Message: "OK" }), { status: 201 }));
        }
        return originalFetch(input, init);
      };

      try {
        const request = imageUploadRequest(
          `/admin/event/${event.id}/image`,
          csrfToken,
          JPEG_HEADER,
          "new.jpg",
          "image/jpeg",
          cookie,
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);
        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toMatch(/\.jpg$/);
      } finally {
        globalThis.fetch = originalFetch;
        spy.mockRestore();
      }
    });

    test("redirects to /admin when not authenticated", async () => {
      const event = await createTestEvent();
      const request = imageUploadRequest(
        `/admin/event/${event.id}/image`,
        "fake-csrf",
        JPEG_HEADER,
        "test.jpg",
        "image/jpeg",
        "",
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 403 when CSRF token is invalid", async () => {
      const event = await createTestEvent();
      const { cookie } = await loginAsAdmin();
      const request = imageUploadRequest(
        `/admin/event/${event.id}/image`,
        "wrong-csrf-token",
        JPEG_HEADER,
        "test.jpg",
        "image/jpeg",
        cookie,
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(403);
    });

    test("returns 403 when CSRF token is missing from form", async () => {
      const event = await createTestEvent();
      const { cookie } = await loginAsAdmin();
      const formData = new FormData();
      // deno-lint-ignore no-explicit-any
      const blob = new Blob([JPEG_HEADER as any], { type: "image/jpeg" });
      formData.append("image", blob, "test.jpg");
      const request = new Request(`http://localhost/admin/event/${event.id}/image`, {
        method: "POST",
        body: formData,
        headers: { cookie, host: "localhost" },
      });
      const response = await handleRequest(request);
      expect(response.status).toBe(403);
    });
  });

  describe("GET /image/:filename (proxy route)", () => {
    test("serves decrypted image with correct content type", async () => {
      const imageData = JPEG_HEADER;
      const encrypted = await encryptBytes(imageData);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("b-cdn.net")) {
          // deno-lint-ignore no-explicit-any
          return Promise.resolve(new Response(encrypted as any, { status: 200 }));
        }
        return originalFetch(input);
      };

      try {
        const response = await handleRequest(mockRequest("/image/abc123-def4-5678-9abc-def012345678.jpg"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/jpeg");
        expect(response.headers.get("cache-control")).toContain("immutable");
        const body = new Uint8Array(await response.arrayBuffer());
        expect(body).toEqual(imageData);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns 404 when CDN returns error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("b-cdn.net")) {
          return Promise.resolve(new Response("Not Found", { status: 404 }));
        }
        return originalFetch(input);
      };

      try {
        const response = await handleRequest(mockRequest("/image/abc123-def4-5678-9abc-def012345678.jpg"));
        expect(response.status).toBe(404);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns 404 for unknown extension", async () => {
      const response = await handleRequest(mockRequest("/image/abc123-def4-5678-9abc-def012345678.bmp"));
      expect(response.status).toBe(404);
    });

    test("returns 404 when storage is not enabled", async () => {
      Deno.env.delete("STORAGE_ZONE_NAME");
      Deno.env.delete("STORAGE_ZONE_KEY");
      const response = await handleRequest(mockRequest("/image/abc123-def4-5678-9abc-def012345678.jpg"));
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-GET method", async () => {
      const request = new Request("http://localhost/image/abc123-def4-5678-9abc-def012345678.jpg", {
        method: "POST",
        body: "test",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" },
      });
      const response = await handleRequest(request);
      expect(response.status).toBe(404);
    });

    test("returns 404 for filename without extension", async () => {
      const response = await handleRequest(mockRequest("/image/abcdef123456"));
      expect(response.status).toBe(404);
    });
  });
});
