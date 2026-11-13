// Contract tests for the image library's admin JSON API reads and upload: the
// list order, one image with the records that show it, and the create body's
// validation. Technical surface — direct Deno tests (docs/e2e-tests.md).
import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toBase64 } from "#crypto/utils.ts";
import { getImageById, setItemsForImage } from "#db/images.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import {
  type ApiImageRow,
  expectImageNotFound,
  expectUnauthorized,
  IMAGE_API_ROOT,
  imageApiPath,
  imageOnListingAndGroup,
  imageUploadBody,
  loggedMessages,
  makeImage,
} from "#test-utils/admin-images.ts";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  mockRequest,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils/mocks.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Images", { db: true, storage: "cdn" }, () => {
  describe("GET /api/admin/images", () => {
    test("lists nothing when the library is empty", async () => {
      const body = await assertJson<{ images: unknown[] }>(
        apiRequest(IMAGE_API_ROOT),
        200,
      );
      expect(body.images).toEqual([]);
    });

    test("lists every image in the library order with the records that show it", async () => {
      // Uploaded out of name order: the list sorts by name, then by upload.
      const zebra = await makeImage("Zebra");
      const apple = await makeImage("Apple");
      const older = await makeImage("Same");
      const newer = await makeImage("Same");
      const listing = await createTestListing({ name: "Summer" });
      await setItemsForImage(apple.id, [{ id: listing.id, kind: "listing" }]);

      await assertJson<{ images: ApiImageRow[] }>(
        apiRequest(IMAGE_API_ROOT),
        200,
        (body) => {
          expect(body.images.map((image) => image.id)).toEqual([
            apple.id,
            older.id,
            newer.id,
            zebra.id,
          ]);
          expect(body.images[0]!.items).toEqual([
            { item_id: listing.id, item_type: "listing" },
          ]);
          expect(body.images[0]!.url).toBe("/image/apple.webp");
          expect(body.images[0]!.thumb_url).toBe("/image/apple-thumb.webp");
          expect(body.images[3]!.items).toEqual([]);
        },
      );
    });

    test("answers 401 without auth", async () => {
      await expectUnauthorized(handleRequest(mockRequest(IMAGE_API_ROOT)));
    });
  });

  describe("GET /api/admin/images/:imageId", () => {
    test("answers one image with every record it shows on", async () => {
      const { group, image, listing } = await imageOnListingAndGroup(
        "Shared",
        "Summer",
        "Series",
      );

      await assertJson<{ image: ApiImageRow }>(
        apiRequest(imageApiPath(image.id)),
        200,
        (body) => {
          expect(body.image).toEqual({
            alt_text: "Alt Shared",
            id: image.id,
            items: [
              { item_id: group.id, item_type: "group" },
              { item_id: listing.id, item_type: "listing" },
            ],
            name: "Shared",
            thumb_url: "/image/shared-thumb.webp",
            url: "/image/shared.webp",
          });
        },
      );
    });

    test("answers 404 for an id the library does not hold", async () => {
      await expectImageNotFound(apiRequest(imageApiPath(9999)));
    });
  });

  describe("POST /api/admin/images", () => {
    test("uploads the file and answers the stored record", async () => {
      await withStorageMock(async (fetchCalls) => {
        const body = await imageUploadBody("Summer poster");
        const answered = await assertJson<{ image: ApiImageRow }>(
          apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
          201,
          (created) => {
            expect(created.image).toMatchObject({
              alt_text: "Alt Summer poster",
              items: [],
              name: "Summer poster",
            });
            // Every stored image is transcoded to WebP under a fresh name.
            expect(created.image.url).toMatch(/^\/image\/[\w-]+\.webp$/);
            expect(created.image.thumb_url).toMatch(/^\/image\/[\w-]+\.webp$/);
            expect(created.image.thumb_url).not.toBe(created.image.url);
          },
        );
        // The full-size file and its thumbnail, one upload each.
        expect(fetchCalls.filter((url) => url.endsWith(".webp")).length).toBe(
          2,
        );
        expect(await getImageById(answered.image.id)).toMatchObject({
          alt_text: "Alt Summer poster",
          name: "Summer poster",
        });
        assertArrayIncludes(await loggedMessages(), [
          "Image 'Summer poster' uploaded",
        ]);
      });
    });

    test("refuses an upload when storage is off", async () => {
      const body = await imageUploadBody("No storage");
      await withStorageDisabled(() =>
        expectApiError(
          apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
          400,
          "File storage is not configured.",
        ),
      );
    });

    test("refuses a file that is not base64 text", async () => {
      const body = await imageUploadBody("Not base64", { file: "not base64!" });
      await expectApiError(
        apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
        400,
        "file must be base64 text",
      );
    });

    test("refuses a format the image pipeline cannot decode", async () => {
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      const body = await imageUploadBody("Animated", {
        content_type: "image/gif",
        file: toBase64(gif),
      });
      await expectApiError(
        apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
        400,
        "Image must be a JPEG, PNG, or WebP file",
      );
    });

    test("names the required fields it is missing", async () => {
      const bodies = [
        {
          body: { content_type: "image/png", file: "AAAA" },
          error: "Image name is required",
        },
        {
          body: { file: "AAAA", name: "No type" },
          error: "content_type is required",
        },
        {
          body: { content_type: "image/png", name: "No file" },
          error: "file is required",
        },
      ];
      for (const { body, error } of bodies) {
        await expectApiError(
          apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
          400,
          error,
        );
      }
    });

    test("refuses a text field that is not text", async () => {
      const nameBody = await imageUploadBody("Not text", { name: 7 });
      const altBody = await imageUploadBody("Not text", { alt_text: 7 });
      const cases = [
        { body: nameBody, error: "name must be a string" },
        { body: altBody, error: "alt_text must be a string" },
      ];
      for (const { body, error } of cases) {
        await expectApiError(
          apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
          400,
          error,
        );
      }
    });

    test("refuses a name past the image input cap", async () => {
      const body = await imageUploadBody("x".repeat(MAX_INPUT_LENGTH + 1));
      await expectApiError(
        apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
        400,
        t("fields.validation.max_length", {
          label: t("images.field.name"),
          max: MAX_INPUT_LENGTH,
        }),
      );
    });

    test("uploads an image with no alt text", async () => {
      await withStorageMock(async () => {
        const body = await imageUploadBody("No alt", { alt_text: undefined });
        await assertJson<{ image: ApiImageRow }>(
          apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
          201,
          (created) => {
            expect(created.image.alt_text).toBe("");
            expect(created.image.name).toBe("No alt");
          },
        );
      });
    });
  });
});
