import { expect } from "@std/expect";
import { encrypt } from "#crypto/encryption.ts";
import { toBase64 } from "#crypto/utils.ts";
import { execute } from "#db/client.ts";
import {
  getImageById,
  getImagesForItem,
  imagesTable,
  setItemsForImage,
} from "#db/images.ts";
import { handleRequest } from "#routes";
import { nonEmptyString } from "#shared/validation/string.ts";
import { expectApiError } from "#test-utils/assertions.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { mockMultipartRequest, mockRequest } from "#test-utils/mocks.ts";
import { apiRequest, testCookie } from "#test-utils/session.ts";
import { makeTestPng } from "#test-utils/test-image.ts";
import type { Image, ImageUseItemType } from "#types";

export const makeImage = (name: string): Promise<Image> =>
  imagesTable.insert({
    altText: `Alt ${name}`,
    filename: nonEmptyString(`${name.toLowerCase()}.webp`),
    filenameThumb: nonEmptyString(`${name.toLowerCase()}-thumb.webp`),
    name,
  });

type ImageWithListingAndGroup = {
  group: { id: number };
  image: Image;
  listing: { id: number };
};

/** A stored image, one listing and one group. The image is on neither item. */
export const imageBesideListingAndGroup = async (
  imageName: string,
  listingName: string,
  groupName: string,
): Promise<ImageWithListingAndGroup> => {
  const image = await makeImage(imageName);
  const listing = await createTestListing({ name: listingName });
  const group = await createTestGroup({ name: groupName });
  return { group, image, listing };
};

/** A stored image shown on one listing and one group. */
export const imageOnListingAndGroup = async (
  imageName: string,
  listingName: string,
  groupName: string,
): Promise<ImageWithListingAndGroup> => {
  const { group, image, listing } = await imageBesideListingAndGroup(
    imageName,
    listingName,
    groupName,
  );
  await setItemsForImage(image.id, [
    { id: listing.id, kind: "listing" },
    { id: group.id, kind: "group" },
  ]);
  return { group, image, listing };
};

/** A stored image shown on the one item `makeItem` creates. Returns the image
 *  and the item's id. */
const imageOnItem = async (
  imageName: string,
  kind: "listing" | "page",
  makeItem: () => Promise<{ id: number }>,
): Promise<{ image: Image; itemId: number }> => {
  const image = await makeImage(imageName);
  const { id } = await makeItem();
  await setItemsForImage(image.id, [{ id, kind }]);
  return { image, itemId: id };
};

/** A stored image shown on one listing. Returns the image and the listing's
 *  id, which the tests read back through. */
export const imageOnListing = async (
  imageName: string,
  listingName = "Summer",
): Promise<{ image: Image; listingId: number }> => {
  const { image, itemId } = await imageOnItem(imageName, "listing", () =>
    createTestListing({ name: listingName }),
  );
  return { image, listingId: itemId };
};

/** A stored image shown on one site page. */
export const imageOnPage = async (
  imageName: string,
  slug: string,
  pageName: string,
): Promise<Image> =>
  (
    await imageOnItem(imageName, "page", () =>
      createTestSitePage(slug, { name: pageName }),
    )
  ).image;

/** Store an image row whose filename is an encrypted empty string — the broken
 * shape the first-class images migration copied from a legacy listing whose
 * image_url was an encrypted "". The thumbnail is broken the same way unless a
 * working `thumbFilename` is given. Returns the row id. */
export const insertBrokenImage = async (
  options: { name?: string; thumbFilename?: string } = {},
): Promise<number> => {
  const brokenFilename = await encrypt("");
  const result = await execute(
    `INSERT INTO images (name, filename, filename_thumb, alt_text)
     VALUES (?, ?, ?, '')`,
    [
      await encrypt(options.name ?? "Broken"),
      brokenFilename,
      options.thumbFilename === undefined
        ? brokenFilename
        : await encrypt(options.thumbFilename),
    ],
  );
  return Number(result.lastInsertRowid);
};

export const adminGet = async (path: string): Promise<Response> =>
  handleRequest(mockRequest(path, { headers: { cookie: await testCookie() } }));

export const formRequest = (
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

export const imageUploadRequest = async (
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

export const postImageUpload = async (
  path: string,
  cookie: string,
  csrfToken: string,
  name: string,
): Promise<Response> =>
  handleRequest(await imageUploadRequest(path, cookie, csrfToken, name));

export const imageNamesForItem = async (
  itemType: ImageUseItemType,
  itemId: number,
): Promise<string[]> =>
  (await getImagesForItem(itemType, itemId)).map((image) => image.name);

/** The image library's JSON API root. */
export const IMAGE_API_ROOT = "/api/admin/images";

export const imageApiPath = (id: number): string => `${IMAGE_API_ROOT}/${id}`;

/** A JSON route write on one image, bound to the method the route answers. */
const imageWrite =
  (method: string) =>
  (id: number, body: Record<string, unknown>): Promise<Response> =>
    apiRequest(imageApiPath(id), { body, method });

/** PUT one image's JSON route as an owner API key. */
export const putImage = imageWrite("PUT");

/** DELETE one image's JSON route as an owner API key. */
export const deleteImage = imageWrite("DELETE");

/** Assert the admin API refuses an unauthenticated request. */
export const expectUnauthorized = async (
  request: Promise<Response>,
): Promise<void> => {
  expect((await request).status).toBe(401);
};

/** Assert the image library answers its 404 for this request. */
export const expectImageNotFound = (
  request: Promise<Response>,
): Promise<unknown> => expectApiError(request, 404, "Image not found");

/** Assert one image delete's answer: its status and error text. The
 *  confirmation defaults to the image's own name. */
export const expectImageDeleteError = (
  image: Pick<Image, "id" | "name">,
  status: number,
  message: string,
  confirmIdentifier: string = image.name,
): Promise<unknown> =>
  expectApiError(
    deleteImage(image.id, { confirm_identifier: confirmIdentifier }),
    status,
    message,
  );

/** Assert the stored image still carries `name`. */
export const expectImageName = async (
  id: number,
  name: string,
): Promise<void> => {
  expect((await getImageById(id))?.name).toBe(name);
};

/** One image row as the JSON API answers with it. */
export type ApiImageRow = {
  alt_text: string;
  id: number;
  items: { item_id: number; item_type: string }[];
  name: string;
  thumb_url: string;
  url: string;
};

/** The create body that uploads a real PNG under `name`. */
export const imageUploadBody = async (
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => ({
  alt_text: `Alt ${name}`,
  content_type: "image/png",
  file: toBase64(await makeTestPng(80, 60)),
  name,
  ...overrides,
});
