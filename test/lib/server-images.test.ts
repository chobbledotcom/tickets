import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { encryptBytes } from "#shared/crypto/encryption.ts";
import { toMajorUnits } from "#shared/currency.ts";
import {
  getListing,
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import {
  cdnOkResponse,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  installUrlHandler,
  JPEG_HEADER,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  PDF_BYTES,
  setupListingAndLogin,
  TEST_STORAGE_ZONE,
  testCookie,
  testCsrfToken,
  updateTestListing,
  withCdnProxy,
  withExpectedError,
  withFetchMock,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils";

/** Reusable proxy route test path */
const PROXY_PATH = "/image/abc123-def4-5678-9abc-def012345678";

/** Build form data for listing edit with all required fields */
const editFormData = async (
  listingId: number,
  csrfToken: string,
): Promise<Record<string, string>> => {
  const listing = await getListingWithCount(listingId);
  if (!listing) throw new Error(`Listing not found: ${listingId}`);
  return {
    bookable_days: listing.bookable_days.join(","),
    closes_at_date: "",
    closes_at_time: "",
    csrf_token: csrfToken,
    date_date: "",
    date_time: "",
    description: listing.description,
    fields: listing.fields || "email",
    listing_type: listing.listing_type,
    location: listing.location,
    max_attendees: String(listing.max_attendees),
    max_price: toMajorUnits(listing.max_price),
    max_quantity: String(listing.max_quantity),
    maximum_days_after: String(listing.maximum_days_after),
    minimum_days_before: String(listing.minimum_days_before),
    name: listing.name,
    slug: listing.slug,
    thank_you_url: listing.thank_you_url ?? "",
    unit_price: listing.unit_price > 0 ? toMajorUnits(listing.unit_price) : "",
    webhook_url: listing.webhook_url ?? "",
  };
};

const submitEditFile =
  (fieldName: string) =>
  async (
    listingId: number,
    cookie: string,
    csrfToken: string,
    file: { name: string; data: Uint8Array; contentType: string },
  ): Promise<Response> => {
    const fields = await editFormData(listingId, csrfToken);
    return handleRequest(
      mockMultipartRequest(`/admin/listing/${listingId}/edit`, fields, cookie, {
        fieldName,
        ...file,
      }),
    );
  };

/** Submit an edit-form multipart request with an image file attached */
const submitEditImage = submitEditFile("image");

/** Submit a JPEG image via the edit form (most common upload case) */
const submitEditJpeg = (
  listingId: number,
  cookie: string,
  csrfToken: string,
  filename: string,
): Promise<Response> =>
  submitEditImage(listingId, cookie, csrfToken, {
    contentType: "image/jpeg",
    data: JPEG_HEADER,
    name: filename,
  });

/** Submit a POST to /admin/listing/:id/image/delete */
const submitImageDelete = (
  listingId: number,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/listing/${listingId}/image/delete`,
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

const expectEditJpegErrorRedirect = async (
  listingId: number,
  cookie: string,
  csrfToken: string,
  file: { data: Uint8Array; name: string },
  expectedError: string,
): Promise<void> => {
  await withStorageMock(async () => {
    const response = await submitEditImage(listingId, cookie, csrfToken, {
      contentType: "image/jpeg",
      ...file,
    });
    await expectImageErrorRedirect(response, expectedError);
  });
};

/** Shared form fields for creating a new listing via POST /admin/listing */
const newListingFormFields = (
  csrfToken: string,
  name: string,
): Record<string, string> => ({
  bookable_days: "Monday,Tuesday,Wednesday,Thursday,Friday",
  closes_at_date: "",
  closes_at_time: "",
  csrf_token: csrfToken,
  date_date: "",
  date_time: "",
  description: "",
  fields: "email",
  listing_type: "standard",
  location: "",
  max_attendees: "50",
  max_quantity: "1",
  maximum_days_after: "",
  minimum_days_before: "",
  name,
  thank_you_url: "",
  unit_price: "",
  webhook_url: "",
});

/** Submit a create-listing form with an image file attached */
const submitCreateImage = (
  cookie: string,
  csrfToken: string,
  listingName: string,
  file: { name: string; data: Uint8Array; contentType: string },
): Promise<Response> =>
  handleRequest(
    mockMultipartRequest(
      "/admin/listing",
      newListingFormFields(csrfToken, listingName),
      cookie,
      { fieldName: "image", ...file },
    ),
  );

/** Submit a POST to /admin/listing/:id/attachment/delete */
const submitAttachmentDelete = (
  listingId: number,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/listing/${listingId}/attachment/delete`,
      { csrf_token: csrfToken },
      cookie,
    ),
  );

/** Submit a POST to /admin/listing/:id/delete with confirmation */
const submitListingDelete = (
  listingId: number,
  listingName: string,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/listing/${listingId}/delete`,
      { confirm_identifier: listingName, csrf_token: csrfToken },
      cookie,
    ),
  );

/** Submit an edit form with an attachment file */
const submitEditAttachment = submitEditFile("attachment");

const submitEditGuidePdf = (
  listingId: number,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  submitEditAttachment(listingId, cookie, csrfToken, {
    contentType: "application/pdf",
    data: PDF_BYTES,
    name: "guide.pdf",
  });

/** Request the image proxy route */
const proxyRequest = (ext = "jpg"): Promise<Response> =>
  handleRequest(mockRequest(`${PROXY_PATH}.${ext}`));

describeWithEnv(
  "server (listing images)",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    describe("POST /admin/listing/:id/edit (image upload via edit form)", () => {
      describeWithEnv(
        "when storage is not configured",
        { env: { STORAGE_ZONE_KEY: undefined, STORAGE_ZONE_NAME: undefined } },
        () => {
          test("ignores image", async () => {
            await withStorageDisabled(async () => {
              const { listing, cookie, csrfToken } =
                await setupListingAndLogin();

              const response = await submitEditJpeg(
                listing.id,
                cookie,
                csrfToken,
                "test.jpg",
              );
              expect(response.status).toBe(302);
              const updated = await getListingWithCount(listing.id);
              expect(updated?.image_url).toBe("");
            });
          });
        },
      );

      test("updates listing without image when no file is uploaded", async () => {
        const listing = await createTestListing();
        await updateTestListing(listing.id, { name: "Updated Name" });
        const updated = await getListingWithCount(listing.id);
        expect(updated?.name).toBe("Updated Name");
        expect(updated?.image_url).toBe("");
      });

      test("redirects with image error for invalid image type", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async () => {
          const response = await submitEditImage(
            listing.id,
            cookie,
            csrfToken,
            {
              contentType: "application/pdf",
              data: PDF_BYTES,
              name: "test.pdf",
            },
          );
          await expectImageErrorRedirect(response, "JPEG, PNG, GIF, or WebP");
          const updated = await getListingWithCount(listing.id);
          expect(updated?.image_url).toBe("");
        });
      });

      test("redirects with image error for oversized image", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        const oversized = new Uint8Array(257 * 1024);
        oversized[0] = 0xff;
        oversized[1] = 0xd8;
        oversized[2] = 0xff;

        await expectEditJpegErrorRedirect(
          listing.id,
          cookie,
          csrfToken,
          { data: oversized, name: "big.jpg" },
          "256KB",
        );
      });

      test("redirects with image error for mismatched magic bytes", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await expectEditJpegErrorRedirect(
          listing.id,
          cookie,
          csrfToken,
          { data: new Uint8Array([0x00, 0x00, 0x00, 0x00]), name: "fake.jpg" },
          "valid image",
        );
      });

      test("uploads image and updates listing via edit form", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async () => {
          const response = await submitEditJpeg(
            listing.id,
            cookie,
            csrfToken,
            "photo.jpg",
          );
          await expectFlashRedirect(
            `/admin/listing/${listing.id}`,
            "Listing updated",
          )(response);

          const updated = await getListingWithCount(listing.id);
          expect(updated?.image_url).not.toBe("");
          expect(updated?.image_url).toMatch(/\.jpg$/);
        });
      });

      test("deletes old image when uploading new one via edit form", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, { imageUrl: "old-image.jpg" });

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEditJpeg(
            listing.id,
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
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, { imageUrl: "old-failing.jpg" });

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
            listing.id,
            cookie,
            csrfToken,
            "new.jpg",
          );
          expect(response.status).toBe(302);
          const updated = await getListingWithCount(listing.id);
          expect(updated?.image_url).toMatch(/\.jpg$/);
        });
      });
    });

    describe("POST /admin/listing (image upload via create form)", () => {
      test("uploads image when creating a new listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const response = await submitCreateImage(
            cookie,
            csrfToken,
            "Image Test Listing",
            { contentType: "image/jpeg", data: JPEG_HEADER, name: "photo.jpg" },
          );
          expect(response.status).toBe(302);

          const { getAllListings } = await import("#shared/db/listings.ts");
          const listings = await getAllListings();
          const created = listings.find((e) => e.name === "Image Test Listing");
          expect(created).not.toBeUndefined();
          expect(created?.image_url).toMatch(/\.jpg$/);
        });
      });

      test("redirects with image error when creating listing with invalid image", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const response = await submitCreateImage(
            cookie,
            csrfToken,
            "Bad Image Listing",
            {
              contentType: "application/pdf",
              data: PDF_BYTES,
              name: "test.pdf",
            },
          );
          expectImageErrorRedirect(response, "JPEG, PNG, GIF, or WebP");

          const { getAllListings } = await import("#shared/db/listings.ts");
          const listings = await getAllListings();
          const created = listings.find((e) => e.name === "Bad Image Listing");
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
              cookie: `${cookie}; ${flashCookieHeader(
                "Image exceeds the 256KB size limit",
                false,
              )}`,
            },
          }),
        );
        await expectHtmlResponse(
          response,
          200,
          "Image exceeds the 256KB size limit",
        );
      });

      test("displays image error on listing detail page", async () => {
        const { listing, cookie } = await setupListingAndLogin();

        const response = await handleRequest(
          mockRequest(`/admin/listing/${listing.id}?flash=${FLASH_TEST_ID}`, {
            headers: {
              cookie: `${cookie}; ${flashCookieHeader(
                "Image must be a JPEG, PNG, GIF, or WebP file",
                false,
              )}`,
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
        const { listing, cookie } = await setupListingAndLogin();

        const response = await handleRequest(
          mockRequest(`/admin/listing/${listing.id}`, { headers: { cookie } }),
        );
        const html = await response.text();
        expect(html).not.toContain("image was not uploaded");
      });
    });

    describe("POST /admin/listing/:id/image/delete", () => {
      const expectImageDeleteRedirect = (
        response: Response,
        listingId: number,
      ): Promise<Response> =>
        expectFlashRedirect(
          `/admin/listing/${listingId}`,
          "Image removed",
        )(response);

      test("removes image from listing and storage", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, { imageUrl: "to-delete.jpg" });

        await withStorageMock(async () => {
          const response = await submitImageDelete(
            listing.id,
            cookie,
            csrfToken,
          );
          await expectImageDeleteRedirect(response, listing.id);

          const updated = await getListingWithCount(listing.id);
          expect(updated?.image_url).toBe("");
        });
      });

      test("redirects when listing has no image", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        const response = await submitImageDelete(listing.id, cookie, csrfToken);
        await expectImageDeleteRedirect(response, listing.id);
      });

      test("returns 404 for non-existent listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await submitImageDelete(9999, cookie, csrfToken);
        expect(response.status).toBe(404);
      });

      test("reports error when storage delete throws", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, { imageUrl: "failing.jpg" });

        await withFetchMock(async (originalFetch) => {
          installUrlHandler(originalFetch, () =>
            Promise.reject(new Error("CDN unreachable")),
          );

          const response = await submitImageDelete(
            listing.id,
            cookie,
            csrfToken,
          );
          expectImageErrorRedirect(response, "removal failed");

          // DB record should NOT be cleared when CDN delete fails
          const updated = await getListingWithCount(listing.id);
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
        { env: { STORAGE_ZONE_KEY: undefined, STORAGE_ZONE_NAME: undefined } },
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
          body: "test",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
          },
          method: "POST",
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

    describe("POST /admin/listing/:id/edit (attachment upload via edit form)", () => {
      test("logs diagnostic when attachment field is not a File", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async () => {
          const fields = await editFormData(listing.id, csrfToken);
          // Add attachment as a text field instead of a file
          fields.attachment = "not-a-file";
          const response = await handleRequest(
            mockMultipartRequest(
              `/admin/listing/${listing.id}/edit`,
              fields,
              cookie,
            ),
          );
          await expectFlashRedirect(
            `/admin/listing/${listing.id}`,
            "Listing updated",
          )(response);

          const updated = await getListingWithCount(listing.id);
          expect(updated?.attachment_url).toBe("");
        });
      });

      describeWithEnv(
        "when storage is not configured",
        { env: { STORAGE_ZONE_KEY: undefined, STORAGE_ZONE_NAME: undefined } },
        () => {
          test("ignores attachment", async () => {
            await withStorageDisabled(async () => {
              const { listing, cookie, csrfToken } =
                await setupListingAndLogin();

              const response = await submitEditGuidePdf(
                listing.id,
                cookie,
                csrfToken,
              );
              expect(response.status).toBe(302);
              const updated = await getListingWithCount(listing.id);
              expect(updated?.attachment_url).toBe("");
            });
          });
        },
      );

      test("uploads attachment and updates listing", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async () => {
          const response = await submitEditGuidePdf(
            listing.id,
            cookie,
            csrfToken,
          );
          await expectFlashRedirect(
            `/admin/listing/${listing.id}`,
            "Listing updated",
          )(response);

          const updated = await getListingWithCount(listing.id);
          expect(updated?.attachment_url).toMatch(/guide\.pdf$/);
          expect(updated?.attachment_name).toBe("guide.pdf");
        });
      });

      test("rejects oversized attachment", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
        await withStorageMock(async () => {
          const response = await submitEditAttachment(
            listing.id,
            cookie,
            csrfToken,
            {
              contentType: "application/zip",
              data: oversized,
              name: "huge.zip",
            },
          );
          expectImageErrorRedirect(response, "25MB");
          const updated = await getListingWithCount(listing.id);
          expect(updated?.attachment_url).toBe("");
        });
      });

      test("deletes old attachment when uploading new one", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "old.pdf",
          attachmentUrl: "old-file.pdf",
        });

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEditAttachment(
            listing.id,
            cookie,
            csrfToken,
            {
              contentType: "application/pdf",
              data: PDF_BYTES,
              name: "new.pdf",
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
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await runWithStorageConfig(TEST_STORAGE_ZONE, () =>
          withFetchMock(async (originalFetch) => {
            installUrlHandler(originalFetch, () =>
              Promise.reject(new Error("CDN unreachable")),
            );

            const response = await submitEditGuidePdf(
              listing.id,
              cookie,
              csrfToken,
            );
            expectImageErrorRedirect(response, "upload failed");
          }),
        );
      });
    });

    describe("POST /admin/listing (attachment upload via create form)", () => {
      test("uploads attachment when creating a new listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const response = await handleRequest(
            mockMultipartRequest(
              "/admin/listing",
              newListingFormFields(csrfToken, "Attachment Listing"),
              cookie,
              {
                contentType: "application/pdf",
                data: PDF_BYTES,
                fieldName: "attachment",
                name: "info.pdf",
              },
            ),
          );
          await expectFlashRedirect("/admin", "Listing created")(response);

          const m = await import("#shared/db/listings.ts");
          const listings = await m.getAllListings();
          const created = listings.find((e) => e.name === "Attachment Listing");
          expect(created?.attachment_url).toMatch(/info\.pdf$/);
          expect(created?.attachment_name).toBe("info.pdf");
        });
      });
    });

    describe("POST /admin/listing/:id/attachment/delete", () => {
      test("removes attachment from listing and storage", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "file.pdf",
          attachmentUrl: "to-delete.pdf",
        });

        await withStorageMock(async () => {
          const response = await submitAttachmentDelete(
            listing.id,
            cookie,
            csrfToken,
          );
          await expectFlashRedirect(
            `/admin/listing/${listing.id}`,
            "Attachment removed",
          )(response);

          const updated = await getListingWithCount(listing.id);
          expect(updated?.attachment_url).toBe("");
          expect(updated?.attachment_name).toBe("");
        });
      });

      test("redirects when listing has no attachment", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        const response = await submitAttachmentDelete(
          listing.id,
          cookie,
          csrfToken,
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "Attachment removed",
        )(response);
      });

      test("returns 404 for non-existent listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await submitAttachmentDelete(9999, cookie, csrfToken);
        expect(response.status).toBe(404);
      });
    });

    describe("listing deletion cleans up storage files", () => {
      /** Delete the listing and return the storage-delete fetch calls made
       *  during the request. Collapses the shared `withStorageMock` +
       *  `submitListingDelete` + `expect(302)` + `fetchCalls.find` scaffold
       *  every test in this block spells out. */
      const deleteListingAndCaptureCalls = async (
        listing: { id: number; name: string },
        cookie: string,
        csrfToken: string,
      ): Promise<string[]> => {
        const calls: string[] = [];
        await withStorageMock(async (fetchCalls) => {
          const response = await submitListingDelete(
            listing.id,
            listing.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);
          calls.push(...fetchCalls);
        });
        return calls;
      };

      test("deletes image from storage when listing is deleted", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          imageUrl: "listing-image.jpg",
        });

        const fetchCalls = await deleteListingAndCaptureCalls(
          listing,
          cookie,
          csrfToken,
        );
        expect(
          fetchCalls.find((url) => url.includes("listing-image.jpg")),
        ).not.toBeUndefined();

        const deleted = await getListing(listing.id);
        expect(deleted).toBeNull();
      });

      test("deletes attachment from storage when listing is deleted", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "doc.pdf",
          attachmentUrl: "listing-attachment.pdf",
        });

        const fetchCalls = await deleteListingAndCaptureCalls(
          listing,
          cookie,
          csrfToken,
        );
        expect(
          fetchCalls.find((url) => url.includes("listing-attachment.pdf")),
        ).not.toBeUndefined();
      });

      test("deletes both image and attachment from storage when listing is deleted", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "both.pdf",
          attachmentUrl: "both-attachment.pdf",
          imageUrl: "both-image.jpg",
        });

        const fetchCalls = await deleteListingAndCaptureCalls(
          listing,
          cookie,
          csrfToken,
        );
        expect(
          fetchCalls.find((url) => url.includes("both-image.jpg")),
        ).not.toBeUndefined();
        expect(
          fetchCalls.find((url) => url.includes("both-attachment.pdf")),
        ).not.toBeUndefined();
      });

      test("succeeds even when storage delete fails during listing deletion", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          imageUrl: "failing-image.jpg",
        });

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

          const response = await submitListingDelete(
            listing.id,
            listing.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);

          const deleted = await getListing(listing.id);
          expect(deleted).toBeNull();
        });
      });

      test("skips storage cleanup when listing has no image or attachment", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async (fetchCalls) => {
          const response = await submitListingDelete(
            listing.id,
            listing.name,
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
