import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { encryptBytes } from "#shared/crypto/encryption.ts";
import { toMajorUnits } from "#shared/currency.ts";
import {
  getImagesForItem,
  imagesTable,
  setImagesForItem,
} from "#shared/db/images.ts";
import {
  getListing,
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings.ts";
import { MAX_IMAGE_SIZE } from "#shared/limits.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
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
  makeTestPng,
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

/** Submit an item Images-tab multipart request with an image file attached. */
const submitListingImageUpload = (
  listingId: number,
  cookie: string,
  csrfToken: string,
  file: { name: string; data: Uint8Array; contentType: string },
): Promise<Response> =>
  handleRequest(
    mockMultipartRequest(
      `/admin/listing/${listingId}/images/upload`,
      {
        alt_text: "",
        csrf_token: csrfToken,
        name: file.name,
      },
      cookie,
      { fieldName: "image", ...file },
    ),
  );

/** Submit a real (decodable) image via the Images tab.
 * Uploads are transcoded to WebP, so the source must be a genuine image — a
 * real PNG, not a magic-byte stub. */
const submitListingImagePng = async (
  listingId: number,
  cookie: string,
  csrfToken: string,
  filename: string,
): Promise<Response> =>
  submitListingImageUpload(listingId, cookie, csrfToken, {
    contentType: "image/png",
    data: await makeTestPng(80, 60),
    name: filename,
  });

const linkStoredImage = async (
  listingId: number,
  filename: string,
  filenameThumb = `${filename}-thumb.webp`,
) => {
  const image = await imagesTable.insert({
    filename: nonEmptyString(filename, "test image filename"),
    filenameThumb: nonEmptyString(
      filenameThumb,
      "test image thumbnail filename",
    ),
    name: filename,
  });
  await setImagesForItem("listing", listingId, [image.id]);
  return image;
};

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
    const response = await submitListingImageUpload(
      listingId,
      cookie,
      csrfToken,
      {
        contentType: "image/jpeg",
        ...file,
      },
    );
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

/** Submit a create-listing form with a stray image, confirm it redirects, and
 * hand back the listing that was created (looked up by its name). */
const createImageListingAndFind = async (
  cookie: string,
  csrfToken: string,
  listingName: string,
  file: { name: string; data: Uint8Array; contentType: string },
) => {
  const response = await submitCreateImage(
    cookie,
    csrfToken,
    listingName,
    file,
  );
  expect(response.status).toBe(302);

  const { getAllListings } = await import("#shared/db/listings.ts");
  const listings = await getAllListings();
  return listings.find((e) => e.name === listingName);
};

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
    describe("POST /admin/listing/:id/images/upload", () => {
      describeWithEnv(
        "when storage is not configured",
        { env: { STORAGE_ZONE_KEY: undefined, STORAGE_ZONE_NAME: undefined } },
        () => {
          test("rejects image upload", async () => {
            await withStorageDisabled(async () => {
              const { listing, cookie, csrfToken } =
                await setupListingAndLogin();

              const getResponse = await handleRequest(
                mockRequest(`/admin/listing/${listing.id}/images`, {
                  headers: { cookie },
                }),
              );
              expect(getResponse.status).toBe(404);

              const response = await submitListingImagePng(
                listing.id,
                cookie,
                csrfToken,
                "test.jpg",
              );
              await expectFlashRedirect(
                `/admin/listing/${listing.id}/edit`,
                "File storage is not configured.",
                false,
                cookie,
              )(response);
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
          const response = await submitListingImageUpload(
            listing.id,
            cookie,
            csrfToken,
            {
              contentType: "application/pdf",
              data: PDF_BYTES,
              name: "test.pdf",
            },
          );
          await expectImageErrorRedirect(response, "JPEG, PNG, or WebP");
          const updated = await getListingWithCount(listing.id);
          expect(updated?.image_url).toBe("");
        });
      });

      test("redirects with image error for oversized image", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        const oversized = new Uint8Array(MAX_IMAGE_SIZE + 1);
        oversized[0] = 0xff;
        oversized[1] = 0xd8;
        oversized[2] = 0xff;

        await expectEditJpegErrorRedirect(
          listing.id,
          cookie,
          csrfToken,
          { data: oversized, name: "big.jpg" },
          "32MB",
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

      test("uploads image and links it to the listing", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async () => {
          const response = await submitListingImagePng(
            listing.id,
            cookie,
            csrfToken,
            "photo.jpg",
          );
          await expectFlashRedirect(
            `/admin/listing/${listing.id}/images`,
            "Image uploaded",
          )(response);

          const updated = await getListingWithCount(listing.id);
          // Source PNG is transcoded to a full WebP plus a WebP thumbnail.
          expect(updated?.image_url).toMatch(/\.webp$/);
          expect(updated?.image_thumb_url).toMatch(/\.webp$/);
          expect(updated?.image_thumb_url).not.toBe(updated?.image_url);
        });
      });

      test("keeps existing reusable image files when uploading a new one", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await linkStoredImage(listing.id, "old-image.jpg", "old-thumb.webp");

        await withStorageMock(async (fetchCalls) => {
          const response = await submitListingImagePng(
            listing.id,
            cookie,
            csrfToken,
            "new-photo.jpg",
          );
          expect(response.status).toBe(302);

          expect(fetchCalls.find((url) => url.includes("old-image.jpg"))).toBe(
            undefined,
          );
          expect(fetchCalls.find((url) => url.includes("old-thumb.webp"))).toBe(
            undefined,
          );
          expect(await getImagesForItem("listing", listing.id)).toHaveLength(2);
        });
      });

      test("succeeds when an existing image file would fail to delete", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await linkStoredImage(listing.id, "old-failing.jpg");

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

          const response = await submitListingImagePng(
            listing.id,
            cookie,
            csrfToken,
            "new.jpg",
          );
          expect(response.status).toBe(302);
          const updated = await getListingWithCount(listing.id);
          expect(updated?.image_url).toBe("old-failing.jpg");
          expect(await getImagesForItem("listing", listing.id)).toHaveLength(2);
        });
      });
    });

    describe("POST /admin/listing (stray image upload field)", () => {
      test("ignores image when creating a new listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const created = await createImageListingAndFind(
            cookie,
            csrfToken,
            "Image Test Listing",
            {
              contentType: "image/png",
              data: await makeTestPng(80, 60),
              name: "photo.png",
            },
          );
          expect(created).not.toBeUndefined();
          expect(created?.image_url).toBe("");
          expect(created?.image_thumb_url).toBe("");
        });
      });

      test("does not validate ignored image field when creating listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const created = await createImageListingAndFind(
            cookie,
            csrfToken,
            "Bad Image Listing",
            {
              contentType: "application/pdf",
              data: PDF_BYTES,
              name: "test.pdf",
            },
          );
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

      test("keeps attachment linked when storage deletion fails", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "guide.pdf",
          attachmentUrl: "delete-fails.pdf",
        });

        await withExpectedError(async () => {
          await withFetchMock(async (originalFetch) => {
            installUrlHandler(originalFetch, (url) =>
              url.includes("delete-fails.pdf")
                ? Promise.reject(new Error("CDN delete failed"))
                : null,
            );
            const response = await submitAttachmentDelete(
              listing.id,
              cookie,
              csrfToken,
            );
            await expectFlashRedirect(
              `/admin/listing/${listing.id}`,
              "Attachment removal failed",
              false,
            )(response);
          });
        });

        const updated = await getListingWithCount(listing.id);
        expect(updated?.attachment_url).toBe("delete-fails.pdf");
        expect(updated?.attachment_name).toBe("guide.pdf");
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

      test("keeps linked reusable image files when listing is deleted", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await linkStoredImage(listing.id, "listing-image.jpg");

        const fetchCalls = await deleteListingAndCaptureCalls(
          listing,
          cookie,
          csrfToken,
        );
        expect(
          fetchCalls.find((url) => url.includes("listing-image.jpg")),
        ).toBeUndefined();

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

      test("deletes attachment but keeps image when listing is deleted", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await linkStoredImage(listing.id, "both-image.jpg");
        await listingsTable.update(listing.id, {
          attachmentName: "both.pdf",
          attachmentUrl: "both-attachment.pdf",
        });

        const fetchCalls = await deleteListingAndCaptureCalls(
          listing,
          cookie,
          csrfToken,
        );
        expect(
          fetchCalls.find((url) => url.includes("both-image.jpg")),
        ).toBeUndefined();
        expect(
          fetchCalls.find((url) => url.includes("both-attachment.pdf")),
        ).not.toBeUndefined();
      });

      test("succeeds when linked image storage deletion would fail during listing deletion", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await linkStoredImage(listing.id, "failing-image.jpg");

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
