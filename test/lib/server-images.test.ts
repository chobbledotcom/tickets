import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encryptBytes } from "#lib/crypto.ts";
import { toMajorUnits } from "#lib/currency.ts";
import { eventsTable, getEvent, getEventWithCount } from "#lib/db/events.ts";
import { runWithStorageConfig } from "#lib/storage.ts";
import { handleRequest } from "#routes";
import {
  cdnOkResponse,
  createTestEvent,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  installUrlHandler,
  JPEG_HEADER,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  PDF_BYTES,
  setTestEnv,
  setupEventAndLogin,
  testCookie,
  testCsrfToken,
  updateTestEvent,
  withCdnProxy,
  withExpectedError,
  withFetchMock,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils";

/** Reusable proxy route test path */
const PROXY_PATH = "/image/abc123-def4-5678-9abc-def012345678";

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
    max_price: toMajorUnits(event.max_price),
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

/** Assert a 302 redirect with a flash error cookie containing the given substring */
const expectImageErrorRedirect = (
  response: Response,
  errorSubstring: string,
): void => {
  expect(response.status).toBe(302);
  const cookies = response.headers.getSetCookie();
  const flash = cookies.find((c) => c.startsWith("flash_"));
  expect(flash).toBeDefined();
  const cookiePart = flash!.split(";")[0] ?? "";
  // Cookie is "flash_{id}={value}", extract value after first "="
  const decoded = decodeURIComponent(cookiePart.split("=").slice(1).join("="));
  expect(decoded).toContain(errorSubstring);
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

/** Submit a POST to /admin/event/:id/attachment/delete */
const submitAttachmentDelete = (
  eventId: number,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/event/${eventId}/attachment/delete`,
      { csrf_token: csrfToken },
      cookie,
    ),
  );

/** Submit a POST to /admin/event/:id/delete with confirmation */
const submitEventDelete = (
  eventId: number,
  eventName: string,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/event/${eventId}/delete`,
      { csrf_token: csrfToken, confirm_identifier: eventName },
      cookie,
    ),
  );

/** Submit an edit form with an attachment file */
const submitEditAttachment = async (
  eventId: number,
  cookie: string,
  csrfToken: string,
  file: { name: string; data: Uint8Array; contentType: string },
): Promise<Response> => {
  const fields = await editFormData(eventId, csrfToken);
  return handleRequest(
    mockMultipartRequest(`/admin/event/${eventId}/edit`, fields, cookie, {
      fieldName: "attachment",
      ...file,
    }),
  );
};

/** Request the image proxy route */
const proxyRequest = (ext = "jpg"): Promise<Response> =>
  handleRequest(mockRequest(`${PROXY_PATH}.${ext}`));

describeWithEnv(
  "server (event images)",
  {
    env: {
      STORAGE_ZONE_NAME: "testzone",
      STORAGE_ZONE_KEY: "testkey",
    },
    db: true,
  },
  () => {
    describe("POST /admin/event/:id/edit (image upload via edit form)", () => {
      describeWithEnv(
        "when storage is not configured",
        { env: { STORAGE_ZONE_NAME: undefined, STORAGE_ZONE_KEY: undefined } },
        () => {
          test("ignores image", async () => {
            await withStorageDisabled(async () => {
              const { event, cookie, csrfToken } = await setupEventAndLogin();

              const response = await submitEditJpeg(
                event.id,
                cookie,
                csrfToken,
                "test.jpg",
              );
              expect(response.status).toBe(302);
              const updated = await getEventWithCount(event.id);
              expect(updated?.image_url).toBe("");
            });
          });
        },
      );

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
        oversized[0] = 0xff;
        oversized[1] = 0xd8;
        oversized[2] = 0xff;

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
          const response = await submitEditJpeg(
            event.id,
            cookie,
            csrfToken,
            "photo.jpg",
          );
          expectRedirectWithFlash(
            `/admin/event/${event.id}`,
            "Event updated",
          )(response);

          const updated = await getEventWithCount(event.id);
          expect(updated?.image_url).not.toBe("");
          expect(updated?.image_url).toMatch(/\.jpg$/);
        });
      });

      test("deletes old image when uploading new one via edit form", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, { imageUrl: "old-image.jpg" });

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEditJpeg(
            event.id,
            cookie,
            csrfToken,
            "new-photo.jpg",
          );
          expect(response.status).toBe(302);

          const deleteCall = fetchCalls.find((url) =>
            url.includes("old-image.jpg"),
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

          const response = await submitEditJpeg(
            event.id,
            cookie,
            csrfToken,
            "new.jpg",
          );
          expect(response.status).toBe(302);
          const updated = await getEventWithCount(event.id);
          expect(updated?.image_url).toMatch(/\.jpg$/);
        });
      });
    });

    describe("POST /admin/event (image upload via create form)", () => {
      test("uploads image when creating a new event", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const response = await submitCreateImage(
            cookie,
            csrfToken,
            "Image Test Event",
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
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const response = await submitCreateImage(
            cookie,
            csrfToken,
            "Bad Image Event",
            {
              name: "test.pdf",
              data: PDF_BYTES,
              contentType: "application/pdf",
            },
          );
          expectImageErrorRedirect(response, "JPEG, PNG, GIF, or WebP");

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
        const cookie = await testCookie();
        const response = await handleRequest(
          mockRequest(`/admin?flash=${FLASH_TEST_ID}`, {
            headers: {
              cookie: `${cookie}; ${flashCookieHeader("Image exceeds the 256KB size limit", false)}`,
            },
          }),
        );
        await expectHtmlResponse(
          response,
          200,
          "Image exceeds the 256KB size limit",
        );
      });

      test("displays image error on event detail page", async () => {
        const { event, cookie } = await setupEventAndLogin();

        const response = await handleRequest(
          mockRequest(`/admin/event/${event.id}?flash=${FLASH_TEST_ID}`, {
            headers: {
              cookie: `${cookie}; ${flashCookieHeader("Image must be a JPEG, PNG, GIF, or WebP file", false)}`,
            },
          }),
        );
        await expectHtmlResponse(
          response,
          200,
          "Image must be a JPEG, PNG, GIF, or WebP file",
        );
      });

      test("does not display image error when flash cookie is absent", async () => {
        const { event, cookie } = await setupEventAndLogin();

        const response = await handleRequest(
          mockRequest(`/admin/event/${event.id}`, { headers: { cookie } }),
        );
        const html = await response.text();
        expect(html).not.toContain("image was not uploaded");
      });
    });

    describe("POST /admin/event/:id/image/delete", () => {
      const expectImageDeleteRedirect = (
        response: Response,
        eventId: number,
      ) => {
        expectRedirectWithFlash(
          `/admin/event/${eventId}`,
          "Image removed",
        )(response);
      };

      test("removes image from event and storage", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, { imageUrl: "to-delete.jpg" });

        await withStorageMock(async () => {
          const response = await submitImageDelete(event.id, cookie, csrfToken);
          expectImageDeleteRedirect(response, event.id);

          const updated = await getEventWithCount(event.id);
          expect(updated?.image_url).toBe("");
        });
      });

      test("redirects when event has no image", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();

        const response = await submitImageDelete(event.id, cookie, csrfToken);
        expectImageDeleteRedirect(response, event.id);
      });

      test("returns 404 for non-existent event", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await submitImageDelete(9999, cookie, csrfToken);
        expect(response.status).toBe(404);
      });

      test("reports error when storage delete throws", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, { imageUrl: "failing.jpg" });

        await withFetchMock(async (originalFetch) => {
          installUrlHandler(originalFetch, () =>
            Promise.reject(new Error("CDN unreachable")),
          );

          const response = await submitImageDelete(event.id, cookie, csrfToken);
          expectImageErrorRedirect(response, "removal failed");

          // DB record should NOT be cleared when CDN delete fails
          const updated = await getEventWithCount(event.id);
          expect(updated?.image_url).toBe("failing.jpg");
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
            expect(response.headers.get("cache-control")).toContain(
              "immutable",
            );
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
            await withExpectedError(async () => {
              await expectHtmlResponse(
                await proxyRequest(),
                503,
                "Temporary Error",
              );
            });
          },
        );
      });

      test("returns 404 for unknown extension", async () => {
        expect((await proxyRequest("bmp")).status).toBe(404);
      });

      describeWithEnv(
        "when storage is not enabled",
        { env: { STORAGE_ZONE_NAME: undefined, STORAGE_ZONE_KEY: undefined } },
        () => {
          test("returns 404", async () => {
            await withStorageDisabled(async () => {
              expect((await proxyRequest()).status).toBe(404);
            });
          });
        },
      );

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
        const response = await handleRequest(
          mockRequest("/image/abcdef123456"),
        );
        expect(response.status).toBe(404);
      });
    });

    describe("POST /admin/event/:id/edit (attachment upload via edit form)", () => {
      test("logs diagnostic when attachment field is not a File", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();

        await withStorageMock(async () => {
          const fields = await editFormData(event.id, csrfToken);
          // Add attachment as a text field instead of a file
          fields.attachment = "not-a-file";
          const response = await handleRequest(
            mockMultipartRequest(
              `/admin/event/${event.id}/edit`,
              fields,
              cookie,
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(response, "Event updated");

          const updated = await getEventWithCount(event.id);
          expect(updated?.attachment_url).toBe("");
        });
      });

      describeWithEnv(
        "when storage is not configured",
        { env: { STORAGE_ZONE_NAME: undefined, STORAGE_ZONE_KEY: undefined } },
        () => {
          test("ignores attachment", async () => {
            await withStorageDisabled(async () => {
              const { event, cookie, csrfToken } = await setupEventAndLogin();

              const response = await submitEditAttachment(
                event.id,
                cookie,
                csrfToken,
                {
                  name: "guide.pdf",
                  data: PDF_BYTES,
                  contentType: "application/pdf",
                },
              );
              expect(response.status).toBe(302);
              const updated = await getEventWithCount(event.id);
              expect(updated?.attachment_url).toBe("");
            });
          });
        },
      );

      test("uploads attachment and updates event", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();

        await withStorageMock(async () => {
          const response = await submitEditAttachment(
            event.id,
            cookie,
            csrfToken,
            {
              name: "guide.pdf",
              data: PDF_BYTES,
              contentType: "application/pdf",
            },
          );
          expectRedirectWithFlash(
            `/admin/event/${event.id}`,
            "Event updated",
          )(response);

          const updated = await getEventWithCount(event.id);
          expect(updated?.attachment_url).toMatch(/guide\.pdf$/);
          expect(updated?.attachment_name).toBe("guide.pdf");
        });
      });

      test("rejects oversized attachment", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();

        const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
        await withStorageMock(async () => {
          const response = await submitEditAttachment(
            event.id,
            cookie,
            csrfToken,
            {
              name: "huge.zip",
              data: oversized,
              contentType: "application/zip",
            },
          );
          expectImageErrorRedirect(response, "25MB");
          const updated = await getEventWithCount(event.id);
          expect(updated?.attachment_url).toBe("");
        });
      });

      test("deletes old attachment when uploading new one", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, {
          attachmentUrl: "old-file.pdf",
          attachmentName: "old.pdf",
        });

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEditAttachment(
            event.id,
            cookie,
            csrfToken,
            {
              name: "new.pdf",
              data: PDF_BYTES,
              contentType: "application/pdf",
            },
          );
          expect(response.status).toBe(302);

          const deleteCall = fetchCalls.find((url) =>
            url.includes("old-file.pdf"),
          );
          expect(deleteCall).not.toBeUndefined();
        });
      });

      test("reports error when attachment upload fails", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();

        await runWithStorageConfig(
          { zoneName: "testzone", zoneKey: "testkey" },
          () =>
            withFetchMock(async (originalFetch) => {
              installUrlHandler(originalFetch, () =>
                Promise.reject(new Error("CDN unreachable")),
              );

              const response = await submitEditAttachment(
                event.id,
                cookie,
                csrfToken,
                {
                  name: "guide.pdf",
                  data: PDF_BYTES,
                  contentType: "application/pdf",
                },
              );
              expectImageErrorRedirect(response, "upload failed");
            }),
        );
      });
    });

    describe("POST /admin/event (attachment upload via create form)", () => {
      test("uploads attachment when creating a new event", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const response = await handleRequest(
            mockMultipartRequest(
              "/admin/event",
              newEventFormFields(csrfToken, "Attachment Event"),
              cookie,
              {
                fieldName: "attachment",
                name: "info.pdf",
                data: PDF_BYTES,
                contentType: "application/pdf",
              },
            ),
          );
          expectRedirectWithFlash("/admin", "Event created")(response);

          const events = await import("#lib/db/events.ts").then((m) =>
            m.getAllEvents(),
          );
          const created = events.find((e) => e.name === "Attachment Event");
          expect(created?.attachment_url).toMatch(/info\.pdf$/);
          expect(created?.attachment_name).toBe("info.pdf");
        });
      });
    });

    describe("POST /admin/event/:id/attachment/delete", () => {
      test("removes attachment from event and storage", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, {
          attachmentUrl: "to-delete.pdf",
          attachmentName: "file.pdf",
        });

        await withStorageMock(async () => {
          const response = await submitAttachmentDelete(
            event.id,
            cookie,
            csrfToken,
          );
          expectRedirectWithFlash(
            `/admin/event/${event.id}`,
            "Attachment removed",
          )(response);

          const updated = await getEventWithCount(event.id);
          expect(updated?.attachment_url).toBe("");
          expect(updated?.attachment_name).toBe("");
        });
      });

      test("redirects when event has no attachment", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();

        const response = await submitAttachmentDelete(
          event.id,
          cookie,
          csrfToken,
        );
        expectRedirectWithFlash(
          `/admin/event/${event.id}`,
          "Attachment removed",
        )(response);
      });

      test("returns 404 for non-existent event", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await submitAttachmentDelete(9999, cookie, csrfToken);
        expect(response.status).toBe(404);
      });
    });

    describe("event deletion cleans up storage files", () => {
      test("deletes image from storage when event is deleted", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, { imageUrl: "event-image.jpg" });

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEventDelete(
            event.id,
            event.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);

          const deleteCall = fetchCalls.find((url) =>
            url.includes("event-image.jpg"),
          );
          expect(deleteCall).not.toBeUndefined();

          const deleted = await getEvent(event.id);
          expect(deleted).toBeNull();
        });
      });

      test("deletes attachment from storage when event is deleted", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, {
          attachmentUrl: "event-attachment.pdf",
          attachmentName: "doc.pdf",
        });

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEventDelete(
            event.id,
            event.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);

          const deleteCall = fetchCalls.find((url) =>
            url.includes("event-attachment.pdf"),
          );
          expect(deleteCall).not.toBeUndefined();
        });
      });

      test("deletes both image and attachment from storage when event is deleted", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, {
          imageUrl: "both-image.jpg",
          attachmentUrl: "both-attachment.pdf",
          attachmentName: "both.pdf",
        });

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEventDelete(
            event.id,
            event.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);

          const imageCall = fetchCalls.find((url) =>
            url.includes("both-image.jpg"),
          );
          const attachmentCall = fetchCalls.find((url) =>
            url.includes("both-attachment.pdf"),
          );
          expect(imageCall).not.toBeUndefined();
          expect(attachmentCall).not.toBeUndefined();
        });
      });

      test("succeeds even when storage delete fails during event deletion", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();
        await eventsTable.update(event.id, { imageUrl: "failing-image.jpg" });

        await withFetchMock(async (originalFetch) => {
          installUrlHandler(originalFetch, (url) => {
            if (url.includes("failing-image.jpg")) {
              return Promise.reject(new Error("CDN delete failed"));
            }
            if (url.includes("storage.bunnycdn.com")) {
              return Promise.resolve(cdnOkResponse());
            }
            return null;
          });

          const response = await submitEventDelete(
            event.id,
            event.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);

          const deleted = await getEvent(event.id);
          expect(deleted).toBeNull();
        });
      });

      test("skips storage cleanup when event has no image or attachment", async () => {
        const { event, cookie, csrfToken } = await setupEventAndLogin();

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEventDelete(
            event.id,
            event.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);

          const storageCalls = fetchCalls.filter((url) =>
            url.includes("storage.bunnycdn.com"),
          );
          expect(storageCalls).toHaveLength(0);
        });
      });
    });
  },
);
