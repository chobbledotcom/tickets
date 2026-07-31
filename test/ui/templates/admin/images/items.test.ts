import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAllImages, setItemsForImage } from "#shared/db/images.ts";
import {
  adminGet,
  formRequest,
  imageNamesForItem,
  makeImage,
  postImageUpload,
} from "#test-utils/admin-images.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { withStorageDisabled, withStorageMock } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

describeWithEnv("admin item image routes", { db: true, storage: "cdn" }, () => {
  describe("GET /admin/groups/:id/images", () => {
    test("404s when storage is disabled", async () => {
      const group = await createTestGroup({ name: "Disabled tab group" });

      await withStorageDisabled(async () => {
        const response = await adminGet(`/admin/groups/${group.id}/images`);
        expect(response.status).toBe(404);
      });
    });
  });

  describe("POST /admin/groups/:id/images", () => {
    test("sets an ordered group image collection from existing images", async () => {
      const group = await createTestGroup({ name: "Poster group" });
      const first = await makeImage("First group image");
      const second = await makeImage("Second group image");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await handleRequest(
        formRequest(
          `/admin/groups/${group.id}/images`,
          [
            ["csrf_token", csrfToken],
            ["image_ids", String(second.id)],
            ["image_ids", String(first.id)],
          ],
          cookie,
        ),
      );

      await expectFlashRedirect(
        `/admin/groups/${group.id}/images`,
        "Images updated",
        true,
        cookie,
      )(response);
      expect(await imageNamesForItem("group", group.id)).toEqual([
        "Second group image",
        "First group image",
      ]);
    });

    test("rejects direct link edits when storage is disabled", async () => {
      const group = await createTestGroup({ name: "Disabled group" });
      const image = await makeImage("Disabled image");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await withStorageDisabled(async () => {
        const response = await handleRequest(
          formRequest(
            `/admin/groups/${group.id}/images`,
            [
              ["csrf_token", csrfToken],
              ["image_ids", String(image.id)],
            ],
            cookie,
          ),
        );
        await expectFlashRedirect(
          `/admin/groups/${group.id}/edit`,
          "File storage is not configured.",
          false,
          cookie,
        )(response);
      });
      expect(await imageNamesForItem("group", group.id)).toEqual([]);
    });
  });

  describe("POST /admin/groups/:id/images/upload", () => {
    test("rejects direct uploads when storage is disabled", async () => {
      const group = await createTestGroup({ name: "Disabled upload group" });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await withStorageDisabled(async () => {
        const response = await postImageUpload(
          `/admin/groups/${group.id}/images/upload`,
          cookie,
          csrfToken,
          "Disabled group upload",
        );
        await expectFlashRedirect(
          `/admin/groups/${group.id}/edit`,
          "File storage is not configured.",
          false,
          cookie,
        )(response);
      });

      expect(await getAllImages()).toEqual([]);
    });

    test("uploads a new image and appends it to the group", async () => {
      const group = await createTestGroup({ name: "Upload group" });
      const existing = await makeImage("Existing group image");
      await setItemsForImage(existing.id, [{ id: group.id, kind: "group" }]);
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await withStorageMock(async () => {
        const response = await postImageUpload(
          `/admin/groups/${group.id}/images/upload`,
          cookie,
          csrfToken,
          "Uploaded group image",
        );
        await expectFlashRedirect(
          `/admin/groups/${group.id}/images`,
          "Image uploaded",
          true,
          cookie,
        )(response);
      });

      expect(await imageNamesForItem("group", group.id)).toEqual([
        "Existing group image",
        "Uploaded group image",
      ]);
    });
  });
});
