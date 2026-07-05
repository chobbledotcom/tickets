import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  getImageById,
  setImagesForItem,
  setItemsForImage,
} from "#shared/db/images.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  withCdnRejecting,
  withExpectedError,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils";
import {
  adminGet,
  formRequest,
  imageNamesForItem,
  makeImage,
} from "#test-utils/admin-images.ts";

describeWithEnv(
  "admin image edit and delete routes",
  { db: true, storage: "cdn" },
  () => {
    describe("GET /admin/images/:id/edit", () => {
      test("renders selected listing and group links", async () => {
        const image = await makeImage("Shared");
        const listing = await createTestListing({ name: "Image listing" });
        const group = await createTestGroup({ name: "Image group" });
        await setItemsForImage(image.id, [
          { itemId: listing.id, itemType: "listing" },
          { itemId: group.id, itemType: "group" },
        ]);

        await expectHtmlResponse(
          await adminGet(`/admin/images/${image.id}/edit`),
          200,
          "Edit Shared",
          `checked name="image_items" type="checkbox" value="listing:${listing.id}"`,
          `checked name="image_items" type="checkbox" value="group:${group.id}"`,
        );
      });

      test("redirects away from edit when storage is disabled", async () => {
        const image = await makeImage("Disabled edit");

        await withStorageDisabled(async () => {
          const response = await adminGet(`/admin/images/${image.id}/edit`);
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
          )(response);
        });
      });
    });

    describe("POST /admin/images/:id/edit", () => {
      test("rejects empty image names", async () => {
        const image = await makeImage("Named");
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await handleRequest(
          formRequest(
            `/admin/images/${image.id}/edit`,
            [
              ["csrf_token", csrfToken],
              ["name", ""],
              ["alt_text", "Still invalid"],
            ],
            cookie,
          ),
        );

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image name is required",
          false,
          cookie,
        )(response);
        expect(await getImageById(image.id)).toMatchObject({ name: "Named" });
      });

      test("updates image metadata and linked items", async () => {
        const image = await makeImage("Original");
        const listing = await createTestListing({ name: "Editable listing" });
        const group = await createTestGroup({ name: "Editable group" });
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await handleRequest(
          formRequest(
            `/admin/images/${image.id}/edit`,
            [
              ["csrf_token", csrfToken],
              ["name", "Updated"],
              ["alt_text", "Updated alt"],
              ["image_items", `listing:${listing.id}`],
              ["image_items", `group:${group.id}`],
              ["image_items", "not-an-item"],
            ],
            cookie,
          ),
        );

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image updated",
          true,
          cookie,
        )(response);
        expect(await getImageById(image.id)).toMatchObject({
          alt_text: "Updated alt",
          name: "Updated",
        });
        expect(await imageNamesForItem("listing", listing.id)).toEqual([
          "Updated",
        ]);
        expect(await imageNamesForItem("group", group.id)).toEqual(["Updated"]);
      });

      test("keeps an existing item image order during metadata-only saves", async () => {
        const listing = await createTestListing({
          name: "Stable edit listing",
        });
        const image = await makeImage("Original first");
        const trailing = await makeImage("Original trailing");
        await setImagesForItem("listing", listing.id, [image.id, trailing.id]);
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await handleRequest(
          formRequest(
            `/admin/images/${image.id}/edit`,
            [
              ["csrf_token", csrfToken],
              ["name", "Renamed first"],
              ["alt_text", "Updated alt"],
              ["image_items", `listing:${listing.id}`],
            ],
            cookie,
          ),
        );

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image updated",
          true,
          cookie,
        )(response);
        expect(await imageNamesForItem("listing", listing.id)).toEqual([
          "Renamed first",
          "Original trailing",
        ]);
      });

      test("rejects direct metadata saves when storage is disabled", async () => {
        const image = await makeImage("Storage-off edit");
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageDisabled(async () => {
          const response = await handleRequest(
            formRequest(
              `/admin/images/${image.id}/edit`,
              [
                ["csrf_token", csrfToken],
                ["name", "Should not save"],
                ["alt_text", "Should not save"],
              ],
              cookie,
            ),
          );
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
            cookie,
          )(response);
        });
        expect(await getImageById(image.id)).toMatchObject({
          alt_text: "Alt Storage-off edit",
          name: "Storage-off edit",
        });
      });
    });

    describe("POST /admin/images/:id/delete", () => {
      test("redirects away from delete confirmation when storage is disabled", async () => {
        const image = await makeImage("Disabled delete");

        await withStorageDisabled(async () => {
          const response = await adminGet(`/admin/images/${image.id}/delete`);
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
          )(response);
        });
      });

      test("rejects direct deletes when storage is disabled", async () => {
        const image = await makeImage("Storage-off delete");
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageDisabled(async () => {
          const response = await handleRequest(
            mockFormRequest(
              `/admin/images/${image.id}/delete`,
              { confirm_identifier: image.name, csrf_token: csrfToken },
              cookie,
            ),
          );
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
            cookie,
          )(response);
        });
        expect(await getImageById(image.id)).not.toBeNull();
      });

      test("requires the image name, then deletes storage files and image rows", async () => {
        const image = await makeImage("Discard");
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const mismatch = await handleRequest(
          mockFormRequest(
            `/admin/images/${image.id}/delete`,
            { confirm_identifier: "wrong", csrf_token: csrfToken },
            cookie,
          ),
        );
        await expectFlashRedirect(
          `/admin/images/${image.id}/delete`,
          "Confirmation did not match the image name",
          false,
          cookie,
        )(mismatch);
        expect(await getImageById(image.id)).not.toBeNull();

        await withStorageMock(async (fetchCalls) => {
          const deleted = await handleRequest(
            mockFormRequest(
              `/admin/images/${image.id}/delete`,
              { confirm_identifier: "Discard", csrf_token: csrfToken },
              cookie,
            ),
          );
          await expectFlashRedirect(
            "/admin/images",
            "Image deleted",
            true,
          )(deleted);
          expect(fetchCalls.some((url) => url.includes("discard.webp"))).toBe(
            true,
          );
          expect(
            fetchCalls.some((url) => url.includes("discard-thumb.webp")),
          ).toBe(true);
        });
        expect(await getImageById(image.id)).toBeNull();
      });

      test("deletes the image row even when storage cleanup fails", async () => {
        const image = await makeImage("Storage failure");
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withExpectedError(async () => {
          await withCdnRejecting(new Error("delete down"), async () => {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/images/${image.id}/delete`,
                { confirm_identifier: image.name, csrf_token: csrfToken },
                cookie,
              ),
            );
            await expectFlashRedirect(
              "/admin/images",
              "Image deleted",
              true,
              cookie,
            )(response);
          });
        });
        expect(await getImageById(image.id)).toBeNull();
      });
    });
  },
);
