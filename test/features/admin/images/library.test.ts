/**
 * The image library list and upload routes, and the Site-content gate that
 * keeps a manager away from images that news posts or pages use.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { appendImageToItem, getAllImages } from "#db/images.ts";
import { records } from "#db/record-table.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  adminGet,
  formRequest,
  imageNamesForItem,
  imageUploadRequest,
  makeImage,
} from "#test-utils/admin-images.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import {
  mockMultipartRequest,
  mockRequest,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils/mocks.ts";
import {
  createTestManagerSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

const NEWS_GATED =
  "This image is used by public site content — only site editors can manage it.";

describeWithEnv(
  "admin image library list and upload",
  { db: true, storage: "cdn" },
  () => {
    test("lists the images while storage is on, and none while it is off", async () => {
      await makeImage("Sunrise banner");
      await expectHtmlResponse(
        await adminGet("/admin/images"),
        200,
        "Sunrise banner",
      );

      await withStorageDisabled(async () => {
        const html = await (await adminGet("/admin/images")).text();
        expect(html).not.toContain("Sunrise banner");
      });
    });

    test("sends an upload with no file back to the upload form", async () => {
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/images",
          {
            altText: "Missing file alt",
            csrfToken: await testCsrfToken(),
            name: "Missing file",
          },
          await testCookie(),
        ),
      );

      await expectFlashRedirect(
        "/admin/images/new",
        "Choose an image file to upload",
        false,
      )(response);
      expect(await getAllImages()).toEqual([]);
    });

    test("an upload creates the image, logs it, and opens its edit page", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await withStorageMock(async () => {
        const response = await handleRequest(
          await imageUploadRequest(
            "/admin/images",
            cookie,
            csrfToken,
            "New library image",
          ),
        );
        const location = response.headers.get("location") ?? "";
        const path = new URL(location, "http://localhost").pathname;
        expect(path).toMatch(/^\/admin\/images\/\d+\/edit$/);
        await expectFlashRedirect(
          path,
          "Image created",
          true,
          cookie,
        )(response);
      });

      expect((await getAllImages()).map((image) => image.name)).toEqual([
        "New library image",
      ]);
      expect(await activityMessages()).toContain(
        "Image 'New library image' uploaded",
      );
    });
  },
);

describeWithEnv(
  "admin image links and the Site-content gate",
  { db: true, storage: "cdn" },
  () => {
    /** Save one image's edit form with the given link boxes. */
    const saveImageEdit = async (
      imageId: number,
      cookie: string,
      items: string[],
    ): Promise<Response> =>
      handleRequest(
        formRequest(
          `/admin/images/${imageId}/edit`,
          [
            ["csrfToken", await signCsrfToken()],
            ["name", "Renamed"],
            ["altText", "alt"],
            ...items.map((item): [string, string] => ["imageItems", item]),
          ],
          cookie,
        ),
      );

    describe("the edit page", () => {
      test("offers news posts to an owner, and not to a manager", async () => {
        const post = await createTestNewsPost("Linkable post");
        const listing = await createTestListing({ name: "Linkable listing" });
        const image = await makeImage("Library image");
        const path = `/admin/images/${image.id}/edit`;

        const owner = await (await adminGet(path)).text();
        const manager = await (
          await handleRequest(
            mockRequest(path, {
              headers: { cookie: await createTestManagerSession() },
            }),
          )
        ).text();

        expect(owner).toContain(`value="news:${post.id}"`);
        expect(manager).toContain(`value="listing:${listing.id}"`);
        expect(manager).not.toContain(`value="news:${post.id}"`);
      });
    });

    describe("saving the edit form", () => {
      test("blocks a manager from an image a news post uses, with an error flash", async () => {
        const post = await createTestNewsPost("Guarded post");
        const image = await makeImage("Managed image");
        await appendImageToItem(image.id, { id: post.id, kind: "news" });
        const managerCookie = await createTestManagerSession();

        const response = await saveImageEdit(image.id, managerCookie, []);

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          NEWS_GATED,
          false,
          managerCookie,
        )(response);
        expect((await records.images.find(image.id))?.name).toBe(
          "Managed image",
        );
      });

      test("keeps a manager's listing link and drops the news link it smuggled", async () => {
        const post = await createTestNewsPost("Off-limits post");
        const listing = await createTestListing({ name: "Allowed listing" });
        const image = await makeImage("Free image");
        const managerCookie = await createTestManagerSession();

        const response = await saveImageEdit(image.id, managerCookie, [
          `listing:${listing.id}`,
          `news:${post.id}`,
        ]);

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image updated",
          true,
          managerCookie,
        )(response);
        expect(await imageNamesForItem("listing", listing.id)).toEqual([
          "Renamed",
        ]);
        expect(await imageNamesForItem("news", post.id)).toEqual([]);
      });

      test("keeps every link an owner submits", async () => {
        const post = await createTestNewsPost("Open post");
        const listing = await createTestListing({ name: "Open listing" });
        const image = await makeImage("Owner image");
        const cookie = await testCookie();

        const response = await saveImageEdit(image.id, cookie, [
          `listing:${listing.id}`,
          `news:${post.id}`,
        ]);

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image updated",
          true,
          cookie,
        )(response);
        expect(await imageNamesForItem("listing", listing.id)).toEqual([
          "Renamed",
        ]);
        expect(await imageNamesForItem("news", post.id)).toEqual(["Renamed"]);
      });
    });
  },
);
