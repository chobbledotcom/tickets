// Contract tests for the image library's admin JSON API writes: the metadata
// and link update, the roles that may change a Site image, and the delete.
// Technical surface — direct Deno tests (docs/e2e-tests.md).
import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import {
  deleteImageRecord,
  getImageById,
  getImagesForItem,
  getImageUsesForImage,
} from "#db/images.ts";
import type { SqlStatement } from "#db/sql.ts";
import { writeImageUpdate } from "#routes/admin/api-images.ts";
import {
  type ApiImageRow,
  deleteImage,
  expectImageNotFound,
  imageApiPath,
  imageOnListing,
  imageOnPage,
  loggedMessages,
  makeImage,
  putImage,
} from "#test-utils/admin-images.ts";
import {
  assertApiDeleteOk,
  assertJson,
  expectApiError,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import {
  withCdnRejecting,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils/mocks.ts";
import {
  createTestEditorSession,
  createTestManagerSession,
} from "#test-utils/session.ts";
import { apiDeleteAs, apiPutAs } from "./parity/helpers.ts";

describeWithEnv(
  "Admin API - Image writes",
  { db: true, storage: "cdn" },
  () => {
    describe("PUT /api/admin/images/:imageId", () => {
      test("renames the image and replaces the records that show it", async () => {
        const { image, listingId } = await imageOnListing("Before");
        const group = await createTestGroup({ name: "Series" });

        await assertJson<{ image: ApiImageRow }>(
          putImage(image.id, {
            alt_text: "A poster",
            items: [{ item_id: group.id, item_type: "group" }],
            name: "After",
          }),
          200,
          (body) => {
            expect(body.image).toMatchObject({
              alt_text: "A poster",
              items: [{ item_id: group.id, item_type: "group" }],
              name: "After",
            });
          },
        );
        expect(await getImageById(image.id)).toMatchObject({
          alt_text: "A poster",
          name: "After",
        });
        expect(await getImageUsesForImage(image.id)).toEqual([
          {
            image_id: image.id,
            item_id: group.id,
            item_type: "group",
            sort_order: 0,
          },
        ]);
        // The listing lost the image when the links were replaced.
        expect(await getImagesForItem("listing", listingId)).toEqual([]);
        assertArrayIncludes(await loggedMessages(), ["Image 'After' updated"]);
      });

      test("leaves the links alone when the body names none", async () => {
        const { image, listingId } = await imageOnListing("Keeps links");

        await assertJson(
          putImage(image.id, { name: "Renamed only" }),
          200,
          (body) => {
            expect(body.image.items).toEqual([
              { item_id: listingId, item_type: "listing" },
            ]);
          },
        );
        expect(await getImageUsesForImage(image.id)).toHaveLength(1);
      });

      test("clears every link when the body names an empty list", async () => {
        const { image } = await imageOnListing("Unlinked");

        await assertJson(putImage(image.id, { items: [] }), 200, (body) =>
          expect(body.image.items).toEqual([]),
        );
        expect(await getImageUsesForImage(image.id)).toEqual([]);
      });

      test("answers with the links the primary holds, not a lagging replica", async () => {
        const { image, listingId } = await imageOnListing("Replica lag");

        const db = getDb();
        const realExecute = db.execute.bind(db);
        // A replica that has not caught up with the links the write replaced.
        using _replica = stub(db, "execute", (statement: SqlStatement) =>
          statement.sql.includes("FROM image_uses")
            ? Promise.resolve(emptyResultSet())
            : realExecute(statement),
        );
        await assertJson<{ image: ApiImageRow }>(
          putImage(image.id, {
            items: [{ item_id: listingId, item_type: "listing" }],
          }),
          200,
          (body) => {
            expect(body.image.items).toEqual([
              { item_id: listingId, item_type: "listing" },
            ]);
          },
        );
      });

      test("refuses an image a page shows, for a manager", async () => {
        const image = await imageOnPage("On a page", "visit", "Visit");

        const response = await apiPutAs(
          imageApiPath(image.id),
          { name: "Manager rename" },
          await createTestManagerSession(),
        );
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe(
          "This image is used by public site content — only site editors can manage it.",
        );
        expect((await getImageById(image.id))?.name).toBe("On a page");
      });

      test("refuses a manager's news post link", async () => {
        const image = await makeImage("Manager link");

        const response = await apiPutAs(
          imageApiPath(image.id),
          { items: [{ item_id: 1, item_type: "news" }] },
          await createTestManagerSession(),
        );
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe(
          "Only an owner or editor can link an image to a news post or a page.",
        );
        expect(await getImageUsesForImage(image.id)).toEqual([]);
      });

      test("lets an editor link a page", async () => {
        const image = await makeImage("Editor link");
        const page = await createTestSitePage("plan", { name: "Plan" });
        const { cookie } = await createTestEditorSession();

        await assertJson(
          apiPutAs(
            imageApiPath(image.id),
            { items: [{ item_id: page.id, item_type: "page" }] },
            cookie,
          ),
          200,
          (body) => {
            expect(body.image.items).toEqual([
              { item_id: page.id, item_type: "page" },
            ]);
          },
        );
      });

      test("refuses a link that names no stored record and keeps the row as it was", async () => {
        const image = await makeImage("Kept");
        const missingId = 4242;

        await expectApiError(
          putImage(image.id, {
            items: [{ item_id: missingId, item_type: "listing" }],
            name: "Renamed",
          }),
          400,
          `items must name existing records: listing:${missingId}`,
        );
        expect((await getImageById(image.id))?.name).toBe("Kept");
        expect(await getImageUsesForImage(image.id)).toEqual([]);
      });

      test("refuses a malformed link", async () => {
        const image = await makeImage("Malformed");

        await expectApiError(
          putImage(image.id, {
            items: [{ item_id: 4, item_type: "attendee" }],
          }),
          400,
          "Each link needs an item_type of listing, group, news, page, and a whole item_id",
        );
      });

      test("refuses an empty name", async () => {
        const image = await makeImage("Named");
        await expectApiError(
          putImage(image.id, { name: " " }),
          400,
          "Image name is required",
        );
      });

      test("refuses a body field of the wrong type", async () => {
        const image = await makeImage("Wrong type");
        const cases = [
          { body: { name: 7 }, error: "name must be a string" },
          { body: { alt_text: 7 }, error: "alt_text must be a string" },
          { body: { items: "listing:1" }, error: "items must be an array" },
        ];
        for (const { body, error } of cases) {
          await expectApiError(putImage(image.id, body), 400, error);
        }
      });

      test("answers 404 for an id the library does not hold", async () => {
        await expectImageNotFound(putImage(9999, { name: "Gone" }));
      });
    });

    describe("the update transaction", () => {
      test("refuses an image deleted before the commit", async () => {
        const image = await makeImage("Vanished");
        await deleteImageRecord(image.id);

        const outcome = await writeImageUpdate(image, {
          items: null,
          metadata: { altText: "Alt Vanished", name: "Vanished" },
        });
        if ("row" in outcome) {
          throw new Error("the vanished row did not refuse the update");
        }
        expect(outcome.refusal.status).toBe(404);
        expect(await outcome.refusal.json()).toEqual({
          error: "Image not found",
        });
      });
    });

    describe("DELETE /api/admin/images/:imageId", () => {
      test("deletes the stored files, the links, and the record", async () => {
        const { image } = await imageOnListing("Discard");

        await withStorageMock(async (fetchCalls) => {
          await assertApiDeleteOk(imageApiPath(image.id), "Discard");
          expect(fetchCalls.some((url) => url.includes("discard.webp"))).toBe(
            true,
          );
          expect(
            fetchCalls.some((url) => url.includes("discard-thumb.webp")),
          ).toBe(true);
        });
        expect(await getImageById(image.id)).toBeNull();
        expect(await getImageUsesForImage(image.id)).toEqual([]);
        assertArrayIncludes(await loggedMessages(), [
          "Image 'Discard' deleted",
        ]);
      });

      test("refuses a confirmation that is not the image name", async () => {
        const image = await makeImage("Keep me");
        await expectApiError(
          deleteImage(image.id, { confirm_identifier: "wrong" }),
          400,
          "Image name does not match. Please provide the exact image name in confirm_identifier.",
        );
        expect(await getImageById(image.id)).not.toBeNull();
      });

      test("refuses deleting an image when storage is off", async () => {
        const image = await makeImage("No storage");
        await withStorageDisabled(() =>
          expectApiError(
            deleteImage(image.id, { confirm_identifier: image.name }),
            400,
            "File storage is not configured.",
          ),
        );
        expect(await getImageById(image.id)).not.toBeNull();
      });

      test("keeps the image when its stored files cannot be deleted", async () => {
        const image = await makeImage("Storage failure");
        await withCdnRejecting(new Error("delete down"), async () => {
          await expectApiError(
            deleteImage(image.id, { confirm_identifier: image.name }),
            500,
            "Could not delete the image files from storage. The image was kept so you can try again.",
          );
        });
        expect(await getImageById(image.id)).not.toBeNull();
      });

      test("refuses deleting an image a page shows, for a manager", async () => {
        const image = await imageOnPage("Page image", "visit", "Visit");

        const response = await apiDeleteAs(
          imageApiPath(image.id),
          { confirm_identifier: image.name },
          await createTestManagerSession(),
        );
        expect(response.status).toBe(403);
        expect(await getImageById(image.id)).not.toBeNull();
      });

      test("answers 404 for an id the library does not hold", async () => {
        await expectImageNotFound(
          deleteImage(9999, { confirm_identifier: "Gone" }),
        );
      });
    });
  },
);
