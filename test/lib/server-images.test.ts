import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { handleRequest } from "#routes";
import {
  createTestDbWithSetup,
  createTestEvent,
  loginAsAdmin,
  mockMultipartRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  updateTestEvent,
} from "#test-utils";
import { encryptBytes } from "#lib/crypto.ts";
import { toMajorUnits } from "#lib/currency.ts";
import { eventsTable, getEventWithCount } from "#lib/db/events.ts";

/** JPEG magic bytes for a valid test image */
const JPEG_HEADER = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);

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

/** Mock fetch to intercept Bunny CDN API calls */
const withStorageMock = async (
  fn: (fetchCalls: string[]) => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push(url);
    if (url.includes("storage.bunnycdn.com") || url.includes("b-cdn.net")) {
      return Promise.resolve(new Response(JSON.stringify({ HttpCode: 201, Message: "OK" }), { status: 201 }));
    }
    return originalFetch(input, init);
  };

  try {
    await fn(fetchCalls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

/** Build form data for event edit with all required fields */
const editFormData = async (eventId: number, csrfToken: string): Promise<Record<string, string>> => {
  const event = await getEventWithCount(eventId);
  if (!event) throw new Error(`Event not found: ${eventId}`);
  return {
    csrf_token: csrfToken,
    name: event.name,
    description: event.description,
    date_date: "",
    date_time: "",
    location: event.location,
    max_attendees: String(event.max_attendees),
    max_quantity: String(event.max_quantity),
    fields: event.fields || "email",
    thank_you_url: event.thank_you_url ?? "",
    unit_price: event.unit_price != null ? toMajorUnits(event.unit_price) : "",
    webhook_url: event.webhook_url ?? "",
    closes_at_date: "",
    closes_at_time: "",
    event_type: event.event_type,
    bookable_days: event.bookable_days.join(","),
    minimum_days_before: String(event.minimum_days_before),
    maximum_days_after: String(event.maximum_days_after),
    slug: event.slug,
  };
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

  describe("POST /admin/event/:id/edit (image upload via edit form)", () => {
    test("ignores image when storage is not configured", async () => {
      Deno.env.delete("STORAGE_ZONE_NAME");
      Deno.env.delete("STORAGE_ZONE_KEY");
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const fields = await editFormData(event.id, csrfToken);
      const request = mockMultipartRequest(
        `/admin/event/${event.id}/edit`,
        fields,
        cookie,
        { fieldName: "image", name: "test.jpg", data: JPEG_HEADER, contentType: "image/jpeg" },
      );
      const response = await handleRequest(request);
      expect(response.status).toBe(302);
      const updated = await getEventWithCount(event.id);
      expect(updated?.image_url).toBe("");
    });

    test("updates event without image when no file is uploaded", async () => {
      const event = await createTestEvent();
      await updateTestEvent(event.id, { name: "Updated Name" });
      const updated = await getEventWithCount(event.id);
      expect(updated?.name).toBe("Updated Name");
      expect(updated?.image_url).toBe("");
    });

    test("redirects with image error for invalid image type", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const fields = await editFormData(event.id, csrfToken);
      const request = mockMultipartRequest(
        `/admin/event/${event.id}/edit`,
        fields,
        cookie,
        { fieldName: "image", name: "test.pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf" },
      );
      await withStorageMock(async () => {
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location).toContain("image_error=");
        expect(decodeURIComponent(location)).toContain("JPEG, PNG, GIF, or WebP");
        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toBe("");
      });
    });

    test("redirects with image error for oversized image", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const oversized = new Uint8Array(257 * 1024);
      oversized[0] = 0xFF; oversized[1] = 0xD8; oversized[2] = 0xFF;
      const fields = await editFormData(event.id, csrfToken);
      const request = mockMultipartRequest(
        `/admin/event/${event.id}/edit`,
        fields,
        cookie,
        { fieldName: "image", name: "big.jpg", data: oversized, contentType: "image/jpeg" },
      );
      await withStorageMock(async () => {
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location).toContain("image_error=");
        expect(decodeURIComponent(location)).toContain("256KB");
      });
    });

    test("redirects with image error for mismatched magic bytes", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      const fields = await editFormData(event.id, csrfToken);
      const request = mockMultipartRequest(
        `/admin/event/${event.id}/edit`,
        fields,
        cookie,
        { fieldName: "image", name: "fake.jpg", data: new Uint8Array([0x00, 0x00, 0x00, 0x00]), contentType: "image/jpeg" },
      );
      await withStorageMock(async () => {
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location).toContain("image_error=");
        expect(decodeURIComponent(location)).toContain("valid image");
      });
    });

    test("uploads image and updates event via edit form", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const fields = await editFormData(event.id, csrfToken);
        const request = mockMultipartRequest(
          `/admin/event/${event.id}/edit`,
          fields,
          cookie,
          { fieldName: "image", name: "photo.jpg", data: JPEG_HEADER, contentType: "image/jpeg" },
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);

        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).not.toBe("");
        expect(updated?.image_url).toMatch(/\.jpg$/);
      });
    });

    test("deletes old image when uploading new one via edit form", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();

      await eventsTable.update(event.id, { imageUrl: "old-image.jpg" });

      await withStorageMock(async (fetchCalls) => {
        const fields = await editFormData(event.id, csrfToken);
        const request = mockMultipartRequest(
          `/admin/event/${event.id}/edit`,
          fields,
          cookie,
          { fieldName: "image", name: "new-photo.jpg", data: JPEG_HEADER, contentType: "image/jpeg" },
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);

        const deleteCall = fetchCalls.find((url) => url.includes("old-image.jpg"));
        expect(deleteCall).not.toBeUndefined();
      });
    });

    test("succeeds even when old image delete throws", async () => {
      const event = await createTestEvent();
      const { cookie, csrfToken } = await loginAsAdmin();
      await eventsTable.update(event.id, { imageUrl: "old-failing.jpg" });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("old-failing.jpg")) {
          return Promise.reject(new Error("CDN delete failed"));
        }
        if (url.includes("storage.bunnycdn.com")) {
          return Promise.resolve(new Response(JSON.stringify({ HttpCode: 201, Message: "OK" }), { status: 201 }));
        }
        return originalFetch(input, init);
      };

      try {
        const fields = await editFormData(event.id, csrfToken);
        const request = mockMultipartRequest(
          `/admin/event/${event.id}/edit`,
          fields,
          cookie,
          { fieldName: "image", name: "new.jpg", data: JPEG_HEADER, contentType: "image/jpeg" },
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toMatch(/\.jpg$/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("POST /admin/event (image upload via create form)", () => {
    test("uploads image when creating a new event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const request = mockMultipartRequest(
          "/admin/event",
          {
            csrf_token: csrfToken,
            name: "Image Test Event",
            description: "",
            date_date: "",
            date_time: "",
            location: "",
            max_attendees: "50",
            max_quantity: "1",
            fields: "email",
            thank_you_url: "",
            unit_price: "",
            webhook_url: "",
            closes_at_date: "",
            closes_at_time: "",
            event_type: "standard",
            bookable_days: "Monday,Tuesday,Wednesday,Thursday,Friday",
            minimum_days_before: "",
            maximum_days_after: "",
          },
          cookie,
          { fieldName: "image", name: "photo.jpg", data: JPEG_HEADER, contentType: "image/jpeg" },
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);

        const { getAllEvents } = await import("#lib/db/events.ts");
        const events = await getAllEvents();
        const created = events.find((e) => e.name === "Image Test Event");
        expect(created).not.toBeUndefined();
        expect(created?.image_url).toMatch(/\.jpg$/);
      });
    });

    test("redirects with image error when creating event with invalid image", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const request = mockMultipartRequest(
          "/admin/event",
          {
            csrf_token: csrfToken,
            name: "Bad Image Event",
            description: "",
            date_date: "",
            date_time: "",
            location: "",
            max_attendees: "50",
            max_quantity: "1",
            fields: "email",
            thank_you_url: "",
            unit_price: "",
            webhook_url: "",
            closes_at_date: "",
            closes_at_time: "",
            event_type: "standard",
            bookable_days: "Monday,Tuesday,Wednesday,Thursday,Friday",
            minimum_days_before: "",
            maximum_days_after: "",
          },
          cookie,
          { fieldName: "image", name: "test.pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf" },
        );
        const response = await handleRequest(request);
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location).toContain("/admin?image_error=");
        expect(decodeURIComponent(location)).toContain("JPEG, PNG, GIF, or WebP");

        const { getAllEvents } = await import("#lib/db/events.ts");
        const events = await getAllEvents();
        const created = events.find((e) => e.name === "Bad Image Event");
        expect(created).not.toBeUndefined();
        expect(created?.image_url).toBe("");
      });
    });
  });

  describe("image error messages in rendered pages", () => {
    test("displays image error on admin dashboard", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockRequest("/admin?image_error=Image+exceeds+the+256KB+size+limit", { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Event created but image was not saved");
      expect(html).toContain("256KB");
    });

    test("displays image error on event detail page", async () => {
      const event = await createTestEvent();
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockRequest(
          `/admin/event/${event.id}?image_error=Image+must+be+a+JPEG%2C+PNG%2C+GIF%2C+or+WebP+file`,
          { headers: { cookie } },
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Event saved but image was not uploaded");
      expect(html).toContain("JPEG, PNG, GIF, or WebP");
    });

    test("does not display image error when query param is absent", async () => {
      const event = await createTestEvent();
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}`, { headers: { cookie } }),
      );
      const html = await response.text();
      expect(html).not.toContain("image was not uploaded");
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
        expect(updated?.image_url).toBe("");
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
        expect(updated?.image_url).toBe("");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("GET /image/:filename (proxy route)", () => {
    test("serves decrypted image with correct content type", async () => {
      const imageData = JPEG_HEADER;
      const encrypted = await encryptBytes(imageData);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("storage.bunnycdn.com")) {
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

    test("returns 404 when file does not exist in storage", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("storage.bunnycdn.com")) {
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

    test("propagates non-404 storage errors", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("storage.bunnycdn.com")) {
          return Promise.resolve(new Response("Unauthorized", { status: 401 }));
        }
        return originalFetch(input);
      };

      try {
        await expect(
          handleRequest(mockRequest("/image/abc123-def4-5678-9abc-def012345678.jpg")),
        ).rejects.toThrow();
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
