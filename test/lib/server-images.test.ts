import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import {
  createTestDbWithSetup,
  createTestEvent,
  expectHtmlResponse,
  installUrlHandler,
  loginAsAdmin,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  setupEventAndLogin,
  updateTestEvent,
  withFetchMock,
} from "#test-utils";
import { encryptBytes } from "#lib/crypto.ts";
import { toMajorUnits } from "#lib/currency.ts";
import { eventsTable, getEventWithCount } from "#lib/db/events.ts";

/** JPEG magic bytes for a valid test image */
const JPEG_HEADER = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);

/** PDF magic bytes for an invalid image type test */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

/** Reusable proxy route test path */
const PROXY_PATH = "/image/abc123-def4-5678-9abc-def012345678";

/** Standard CDN 201 success response */
const cdnOkResponse = (): Response =>
  new Response(JSON.stringify({ HttpCode: 201, Message: "OK" }), { status: 201 });

/** Mock fetch to intercept Bunny CDN API calls, forwarding others to real fetch */
const withStorageMock = (
  fn: (fetchCalls: string[]) => Promise<void>,
): Promise<void> =>
  withFetchMock(async (originalFetch) => {
    const fetchCalls: string[] = [];
    installUrlHandler(originalFetch, (url) => {
      fetchCalls.push(url);
      if (url.includes("storage.bunnycdn.com") || url.includes("b-cdn.net")) {
        return Promise.resolve(cdnOkResponse());
      }
      return null;
    });
    await fn(fetchCalls);
  });

/** Mock fetch where CDN requests return a fixed response, others pass through */
const withCdnProxy = (
  respond: () => Response,
  fn: () => Promise<void>,
): Promise<void> =>
  withFetchMock(async (originalFetch) => {
    installUrlHandler(originalFetch, (url) =>
      url.includes("storage.bunnycdn.com") ? Promise.resolve(respond()) : null,
    );
    await fn();
  });

/** Build form data for event edit with all required fields */
const editFormData = async (
  eventId: number,
  csrfToken: string,
): Promise<Record<string, string>> => {
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
    unit_price: event.unit_price > 0 ? toMajorUnits(event.unit_price) : "",
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

/** Submit an edit-form multipart request with an image file attached */
const submitEditImage = async (
  eventId: number,
  cookie: string,
  csrfToken: string,
  file: { name: string; data: Uint8Array; contentType: string },
): Promise<Response> => {
  const fields = await editFormData(eventId, csrfToken);
  return handleRequest(
    mockMultipartRequest(`/admin/event/${eventId}/edit`, fields, cookie, {
      fieldName: "image",
      ...file,
    }),
  );
};

/** Submit a JPEG image via the edit form (most common upload case) */
const submitEditJpeg = (
  eventId: number,
  cookie: string,
  csrfToken: string,
  filename: string,
): Promise<Response> =>
  submitEditImage(eventId, cookie, csrfToken, {
    name: filename,
    data: JPEG_HEADER,
    contentType: "image/jpeg",
  });

/** Submit a POST to /admin/event/:id/image/delete */
const submitImageDelete = (
  eventId: number,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/event/${eventId}/image/delete`,
      { csrf_token: csrfToken },
      cookie,
    ),
  );

/** Assert a 302 redirect whose location contains `image_error=` and a decoded substring */
const expectImageErrorRedirect = (
  response: Response,
  errorSubstring: string,
): void => {
  expect(response.status).toBe(302);
  const location = response.headers.get("location") ?? "";
  expect(location).toContain("image_error=");
  expect(decodeURIComponent(location)).toContain(errorSubstring);
};

/** Shared form fields for creating a new event via POST /admin/event */
const newEventFormFields = (
  csrfToken: string,
  name: string,
): Record<string, string> => ({
  csrf_token: csrfToken,
  name,
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
});

/** Submit a create-event form with an image file attached */
const submitCreateImage = (
  cookie: string,
  csrfToken: string,
  eventName: string,
  file: { name: string; data: Uint8Array; contentType: string },
): Promise<Response> =>
  handleRequest(
    mockMultipartRequest(
      "/admin/event",
      newEventFormFields(csrfToken, eventName),
      cookie,
      { fieldName: "image", ...file },
    ),
  );

/** Request the image proxy route */
const proxyRequest = (ext = "jpg"): Promise<Response> =>
  handleRequest(mockRequest(`${PROXY_PATH}.${ext}`));

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
      const { event, cookie, csrfToken } = await setupEventAndLogin();

      const response = await submitEditJpeg(event.id, cookie, csrfToken, "test.jpg");
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
      const { event, cookie, csrfToken } = await setupEventAndLogin();

      await withStorageMock(async () => {
        const response = await submitEditImage(event.id, cookie, csrfToken, {
          name: "test.pdf",
          data: PDF_BYTES,
          contentType: "application/pdf",
        });
        await expectImageErrorRedirect(response, "JPEG, PNG, GIF, or WebP");
        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toBe("");
      });
    });

    test("redirects with image error for oversized image", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();

      const oversized = new Uint8Array(257 * 1024);
      oversized[0] = 0xFF;
      oversized[1] = 0xD8;
      oversized[2] = 0xFF;

      await withStorageMock(async () => {
        const response = await submitEditImage(event.id, cookie, csrfToken, {
          name: "big.jpg",
          data: oversized,
          contentType: "image/jpeg",
        });
        await expectImageErrorRedirect(response, "256KB");
      });
    });

    test("redirects with image error for mismatched magic bytes", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();

      await withStorageMock(async () => {
        const response = await submitEditImage(event.id, cookie, csrfToken, {
          name: "fake.jpg",
          data: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
          contentType: "image/jpeg",
        });
        await expectImageErrorRedirect(response, "valid image");
      });
    });

    test("uploads image and updates event via edit form", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();

      await withStorageMock(async () => {
        const response = await submitEditJpeg(event.id, cookie, csrfToken, "photo.jpg");
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(
          `/admin/event/${event.id}?success=Event%20updated`,
        );

        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).not.toBe("");
        expect(updated?.image_url).toMatch(/\.jpg$/);
      });
    });

    test("deletes old image when uploading new one via edit form", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();
      await eventsTable.update(event.id, { imageUrl: "old-image.jpg" });

      await withStorageMock(async (fetchCalls) => {
        const response = await submitEditJpeg(event.id, cookie, csrfToken, "new-photo.jpg");
        expect(response.status).toBe(302);

        const deleteCall = fetchCalls.find((url) =>
          url.includes("old-image.jpg")
        );
        expect(deleteCall).not.toBeUndefined();
      });
    });

    test("succeeds even when old image delete throws", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();
      await eventsTable.update(event.id, { imageUrl: "old-failing.jpg" });

      await withFetchMock(async (originalFetch) => {
        installUrlHandler(originalFetch, (url) => {
          if (url.includes("old-failing.jpg")) {
            return Promise.reject(new Error("CDN delete failed"));
          }
          if (url.includes("storage.bunnycdn.com")) {
            return Promise.resolve(cdnOkResponse());
          }
          return null;
        });

        const response = await submitEditJpeg(event.id, cookie, csrfToken, "new.jpg");
        expect(response.status).toBe(302);
        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toMatch(/\.jpg$/);
      });
    });
  });

  describe("POST /admin/event (image upload via create form)", () => {
    test("uploads image when creating a new event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await withStorageMock(async () => {
        const response = await submitCreateImage(
          cookie, csrfToken, "Image Test Event",
          { name: "photo.jpg", data: JPEG_HEADER, contentType: "image/jpeg" },
        );
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
        const response = await submitCreateImage(
          cookie, csrfToken, "Bad Image Event",
          { name: "test.pdf", data: PDF_BYTES, contentType: "application/pdf" },
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location).toContain("/admin?image_error=");
        expect(decodeURIComponent(location)).toContain(
          "JPEG, PNG, GIF, or WebP",
        );

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
        mockRequest("/admin?image_error=Image+exceeds+the+256KB+size+limit", {
          headers: { cookie },
        }),
      );
      await expectHtmlResponse(
        response,
        200,
        "Event created but image was not saved",
        "256KB",
      );
    });

    test("displays image error on event detail page", async () => {
      const { event, cookie } = await setupEventAndLogin();

      const response = await handleRequest(
        mockRequest(
          `/admin/event/${event.id}?image_error=Image+must+be+a+JPEG%2C+PNG%2C+GIF%2C+or+WebP+file`,
          { headers: { cookie } },
        ),
      );
      await expectHtmlResponse(
        response,
        200,
        "Event saved but image was not uploaded",
        "JPEG, PNG, GIF, or WebP",
      );
    });

    test("does not display image error when query param is absent", async () => {
      const { event, cookie } = await setupEventAndLogin();

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}`, { headers: { cookie } }),
      );
      const html = await response.text();
      expect(html).not.toContain("image was not uploaded");
    });
  });

  describe("POST /admin/event/:id/image/delete", () => {
    test("removes image from event and storage", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();
      await eventsTable.update(event.id, { imageUrl: "to-delete.jpg" });

      await withStorageMock(async () => {
        const response = await submitImageDelete(event.id, cookie, csrfToken);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(
          `/admin/event/${event.id}?success=Image%20removed`,
        );

        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toBe("");
      });
    });

    test("redirects when event has no image", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();

      const response = await submitImageDelete(event.id, cookie, csrfToken);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}?success=Image%20removed`);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await submitImageDelete(9999, cookie, csrfToken);
      expect(response.status).toBe(404);
    });

    test("succeeds even when storage delete throws", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();
      await eventsTable.update(event.id, { imageUrl: "failing.jpg" });

      await withFetchMock(async (originalFetch) => {
        installUrlHandler(originalFetch, () =>
          Promise.reject(new Error("CDN unreachable")),
        );

        const response = await submitImageDelete(event.id, cookie, csrfToken);
        expect(response.status).toBe(302);
        const updated = await getEventWithCount(event.id);
        expect(updated?.image_url).toBe("");
      });
    });
  });

  describe("GET /image/:filename (proxy route)", () => {
    test("serves decrypted image with correct content type", async () => {
      const imageData = JPEG_HEADER;
      const encrypted = await encryptBytes(imageData);

      await withCdnProxy(
        // deno-lint-ignore no-explicit-any
        () => new Response(encrypted as any, { status: 200 }),
        async () => {
          const response = await proxyRequest();
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("image/jpeg");
          expect(response.headers.get("cache-control")).toContain("immutable");
          const body = new Uint8Array(await response.arrayBuffer());
          expect(body).toEqual(imageData);
        },
      );
    });

    test("returns 404 when file does not exist in storage", async () => {
      await withCdnProxy(
        () => new Response("Not Found", { status: 404 }),
        async () => {
          expect((await proxyRequest()).status).toBe(404);
        },
      );
    });

    test("propagates non-404 storage errors as 503", async () => {
      await withCdnProxy(
        () => new Response("Unauthorized", { status: 401 }),
        async () => {
          await expectHtmlResponse(await proxyRequest(), 503, "Temporary Error");
        },
      );
    });

    test("returns 404 for unknown extension", async () => {
      expect((await proxyRequest("bmp")).status).toBe(404);
    });

    test("returns 404 when storage is not enabled", async () => {
      Deno.env.delete("STORAGE_ZONE_NAME");
      Deno.env.delete("STORAGE_ZONE_KEY");
      expect((await proxyRequest()).status).toBe(404);
    });

    test("returns 404 for non-GET method", async () => {
      const request = new Request(`http://localhost${PROXY_PATH}.jpg`, {
        method: "POST",
        body: "test",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "localhost",
        },
      });
      expect((await handleRequest(request)).status).toBe(404);
    });

    test("returns 404 for filename without extension", async () => {
      const response = await handleRequest(mockRequest("/image/abcdef123456"));
      expect(response.status).toBe(404);
    });
  });
});
