// Contract tests for the image library's admin JSON API reads and upload: the
// list order, one image with the records that show it, and the create body's
// validation. Technical surface — direct Deno tests (docs/e2e-tests.md).
import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toBase64 } from "#crypto/utils.ts";
import { getImageById, setItemsForImage } from "#db/images.ts";
import { handleRequest } from "#routes";
import {
  type ApiImageRow,
  IMAGE_API_ROOT,
  imageApiPath,
  imageUploadBody,
  loggedMessages,
  makeImage,
} from "#test-utils/admin-images.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  mockRequest,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils/mocks.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Images", { db: true, storage: "cdn" }, () => {
  describe("GET /api/admin/images", () => {
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
      const response = await handleRequest(mockRequest(IMAGE_API_ROOT));
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/images/:imageId", () => {
    test("answers one image with every record it shows on", async () => {
      const image = await makeImage("Shared");
      const listing = await createTestListing({ name: "Summer" });
      const group = await createTestGroup({ name: "Series" });
      await setItemsForImage(image.id, [
        { id: group.id, kind: "group" },
        { id: listing.id, kind: "listing" },
      ]);

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
      await assertJson(apiRequest(imageApiPath(9999)), 404, (body) => {
        expect(body.error).toBe("Image not found");
      });
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
        assertJson(
          apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
          400,
          (body) => expect(body.error).toBe("File storage is not configured."),
        ),
      );
    });

    test("refuses a file that is not base64 text", async () => {
      const body = await imageUploadBody("Not base64", { file: "not base64!" });
      await assertJson(
        apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
        400,
        (answered) => expect(answered.error).toBe("file must be base64 text"),
      );
    });

    test("refuses a format the image pipeline cannot decode", async () => {
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      const body = await imageUploadBody("Animated", {
        content_type: "image/gif",
        file: toBase64(gif),
      });
      await assertJson(
        apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
        400,
        (answered) =>
          expect(answered.error).toBe(
            "Image must be a JPEG, PNG, or WebP file",
          ),
      );
    });

    test("names the required fields it is missing", async () => {
      const bodies = [
        { content_type: "image/png", file: "AAAA" },
        { file: "AAAA", name: "No type" },
        { content_type: "image/png", name: "No file" },
      ];
      const errors = [
        "Image name is required",
        "content_type is required",
        "file is required",
      ];
      for (const [index, body] of bodies.entries()) {
        await assertJson(
          apiRequest(IMAGE_API_ROOT, { body, method: "POST" }),
          400,
          (answered) => expect(answered.error).toBe(errors[index]),
        );
      }
    });
  });
});
