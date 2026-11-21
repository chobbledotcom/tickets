/**
 * The image library list and upload routes, and the Site-content gate that
 * keeps a manager away from images that news posts or pages use.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { appendImageToItem, getAllImages } from "#db/images.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  adminGet,
  expectImageName,
  formRequest,
  imageNamesForItem,
  makeImage,
  postImageUpload,
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
import type { Image } from "#types";

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

    /** Post the upload form with these fields and no image file. */
    const postWithoutFile = async (
      fields: Record<string, string>,
    ): Promise<Response> =>
      handleRequest(
        mockMultipartRequest(
          "/admin/images",
          { ...fields, csrfToken: await testCsrfToken() },
          await testCookie(),
        ),
      );

    test("sends an upload with no file back to the upload form", async () => {
      const response = await postWithoutFile({
        altText: "Missing file alt",
        name: "Missing file",
      });

      await expectFlashRedirect(
        "/admin/images/new",
        "Choose an image file to upload",
        false,
      )(response);
      expect(await getAllImages()).toEqual([]);
    });

    test("an upload creates the image, logs it, and opens its edit page", async () => {
      await withStorageMock(async () => {
        const response = await postImageUpload(
          "/admin/images",
          await testCookie(),
          await testCsrfToken(),
          "New library image",
        );
        const [image] = await getAllImages();
        await expectFlashRedirect(
          `/admin/images/${image?.id}/edit`,
          "Image created",
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

    /** A stored image that the news post of that name uses. */
    const imageOnNewsPost = async (
      imageName: string,
      postName: string,
    ): Promise<Image> => {
      const post = await createTestNewsPost(postName);
      const image = await makeImage(imageName);
      await appendImageToItem(image.id, { id: post.id, kind: "news" });
      return image;
    };

    describe("saving the edit form", () => {
      test("blocks a manager from an image a news post uses, with an error flash", async () => {
        const image = await imageOnNewsPost("Managed image", "Guarded post");
        const managerCookie = await createTestManagerSession();

        const response = await saveImageEdit(image.id, managerCookie, []);

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          NEWS_GATED,
          false,
          managerCookie,
        )(response);
        await expectImageName(image.id, "Managed image");
      });

      for (const { asOwner, name, newsLinkedNames } of [
        {
          asOwner: false,
          name: "keeps a manager's listing link and drops the news link it smuggled",
          newsLinkedNames: [],
        },
        {
          asOwner: true,
          name: "keeps every link an owner submits",
          newsLinkedNames: ["Renamed"],
        },
      ]) {
        test(name, async () => {
          const post = await createTestNewsPost("Linked post");
          const listing = await createTestListing({ name: "Linked listing" });
          const image = await makeImage("Free image");
          const cookie = asOwner
            ? await testCookie()
            : await createTestManagerSession();

          const response = await saveImageEdit(image.id, cookie, [
            `listing:${listing.id}`,
            `news:${post.id}`,
          ]);

          await expectFlashRedirect(
            "/admin/images",
            "Image updated",
            true,
            cookie,
          )(response);
          expect(await imageNamesForItem("listing", listing.id)).toEqual([
            "Renamed",
          ]);
          expect(await imageNamesForItem("news", post.id)).toEqual(
            newsLinkedNames,
          );
        });
      }
    });
  },
);
