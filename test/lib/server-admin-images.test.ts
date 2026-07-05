import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getDb } from "#shared/db/client.ts";
import {
  getAllImages,
  getImageById,
  getImagesForItem,
  imagesTable,
  setImagesForItem,
  setItemsForImage,
} from "#shared/db/images.ts";
import type { Image } from "#shared/types.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  makeTestPng,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  testCookie,
  testCsrfToken,
  withBunnyStorageStub,
  withCdnRejecting,
  withExpectedError,
  withStorageMock,
} from "#test-utils";

const makeImage = (name: string): Promise<Image> =>
  imagesTable.insert({
    altText: `Alt ${name}`,
    filename: nonEmptyString(`${name.toLowerCase()}.webp`),
    filenameThumb: nonEmptyString(`${name.toLowerCase()}-thumb.webp`),
    name,
  });

const adminGet = async (path: string): Promise<Response> =>
  handleRequest(mockRequest(path, { headers: { cookie: await testCookie() } }));

const formRequest = (
  path: string,
  entries: [string, string][],
  cookie: string,
): Request =>
  new Request(`http://localhost${path}`, {
    body: new URLSearchParams(entries),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      host: "localhost",
    },
    method: "POST",
  });

const imageUploadRequest = async (
  path: string,
  cookie: string,
  csrfToken: string,
  name: string,
): Promise<Request> =>
  mockMultipartRequest(
    path,
    { alt_text: `Alt ${name}`, csrf_token: csrfToken, name },
    cookie,
    {
      contentType: "image/png",
      data: await makeTestPng(80, 60),
      fieldName: "image",
      name: `${name}.png`,
    },
  );

const postImageUpload = async (
  path: string,
  cookie: string,
  csrfToken: string,
  name: string,
): Promise<Response> =>
  handleRequest(await imageUploadRequest(path, cookie, csrfToken, name));

const imageNamesForItem = async (
  itemType: "listing" | "group",
  itemId: number,
): Promise<string[]> =>
  (await getImagesForItem(itemType, itemId)).map((image) => image.name);

describeWithEnv("admin image library routes", { db: true }, () => {
  describe("GET /admin/images", () => {
    test("renders the empty state and image table", async () => {
      await expectHtmlResponse(
        await adminGet("/admin/images"),
        200,
        "No images yet.",
        "Add Image",
      );

      await makeImage("Hero");
      await expectHtmlResponse(
        await adminGet("/admin/images"),
        200,
        "Hero",
        'href="/admin/images/',
        "/image/hero-thumb.webp",
      );
    });
  });

  describe("GET /admin/images/new", () => {
    test("renders the upload form", async () => {
      await expectHtmlResponse(
        await adminGet("/admin/images/new"),
        200,
        "Create image",
        'name="name"',
        'name="image"',
        'enctype="multipart/form-data"',
      );
    });
  });

  describe("POST /admin/images", () => {
    test("rejects missing metadata before storage upload", async () => {
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/images",
          { alt_text: "", csrf_token: await testCsrfToken(), name: "" },
          await testCookie(),
        ),
      );

      await expectFlashRedirect(
        "/admin/images/new",
        "Image name is required",
        false,
      )(response);
      expect(await getAllImages()).toEqual([]);
    });

    test("rejects missing file before storage upload", async () => {
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/images",
          {
            alt_text: "Missing file alt",
            csrf_token: await testCsrfToken(),
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

    test("rejects uploads when storage fails", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await withExpectedError(async () => {
        await withCdnRejecting(new Error("upload down"), async () => {
          const response = await postImageUpload(
            "/admin/images",
            cookie,
            csrfToken,
            "Failed upload",
          );
          await expectFlashRedirect(
            "/admin/images/new",
            "Image upload failed: Error: upload down",
            false,
            cookie,
          )(response);
        });
      });
      expect(await getAllImages()).toEqual([]);
    });

    test("cleans up uploaded files when the image record cannot be created", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await getDb().execute("DROP TABLE images");
      await withBunnyStorageStub(
        () => new Response(null, { status: 201 }),
        async () => {
          await withExpectedError(async () => {
            const response = await postImageUpload(
              "/admin/images",
              cookie,
              csrfToken,
              "Unstored upload",
            );
            expect(response.status).toBe(503);
          });
        },
      );
    });

    test("uploads a new image record and redirects to its edit page", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await withStorageMock(async () => {
        const response = await postImageUpload(
          "/admin/images",
          cookie,
          csrfToken,
          "New library image",
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

      const [image] = await getAllImages();
      expect(image?.name).toBe("New library image");
      expect(image?.alt_text).toBe("Alt New library image");
      expect(image?.filename).toMatch(/\.webp$/);
      expect(image?.filename_thumb).toMatch(/\.webp$/);
    });
  });

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
      const listing = await createTestListing({ name: "Stable edit listing" });
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
  });

  describe("POST /admin/images/:id/delete", () => {
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
  });
});

describeWithEnv("admin item image routes", { db: true }, () => {
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
  });

  describe("POST /admin/groups/:id/images/upload", () => {
    test("uploads a new image and appends it to the group", async () => {
      const group = await createTestGroup({ name: "Upload group" });
      const existing = await makeImage("Existing group image");
      await setItemsForImage(existing.id, [
        { itemId: group.id, itemType: "group" },
      ]);
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
