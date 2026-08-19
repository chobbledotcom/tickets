import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getImagesForItem } from "#db/images.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { handleRequest } from "#routes";
import { MAX_IMAGE_SIZE } from "#shared/limits.ts";
import {
  expectImageErrorRedirect,
  linkStoredImage,
} from "#test/integration/server/images/helpers.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { PDF_BYTES } from "#test-utils/factories.ts";
import {
  cdnOkResponse,
  installUrlHandler,
  mockMultipartRequest,
  mockRequest,
  withFetchMock,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils/mocks.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";
import { makeTestPng } from "#test-utils/test-image.ts";

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

describeWithEnv(
  "server images > upload",
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
  },
);
