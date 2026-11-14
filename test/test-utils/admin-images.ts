import { encrypt } from "#crypto/encryption.ts";
import { toBase64 } from "#crypto/utils.ts";
import { execute } from "#db/client.ts";
import { getImagesForItem, imagesTable, setItemsForImage } from "#db/images.ts";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { nonEmptyString } from "#shared/validation/string.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectApiError } from "#test-utils/assertions.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { mockMultipartRequest, mockRequest } from "#test-utils/mocks.ts";
import { apiRequest, testCookie } from "#test-utils/session.ts";
import { makeTestPng } from "#test-utils/test-image.ts";
import type { Image, ImageUseItemType } from "#types";
import { sql } from "#db/sql.ts";

export const makeImage = (name: string): Promise<Image> =>
  imagesTable.insert({
    altText: `Alt ${name}`,
    filename: nonEmptyString(`${name.toLowerCase()}.webp`),
    filenameThumb: nonEmptyString(`${name.toLowerCase()}-thumb.webp`),
    name,
  });

/** A stored image shown on one listing. Returns the image and the listing's
 *  id, which the tests read back through. */
export const imageOnListing = async (
  imageName: string,
  listingName = "Summer",
): Promise<{ image: Image; listingId: number }> => {
  const image = await makeImage(imageName);
  const listing = await createTestListing({ name: listingName });
  await setItemsForImage(image.id, [{ id: listing.id, kind: "listing" }]);
  return { image, listingId: listing.id };
};

/** A stored image shown on one site page. */
export const imageOnPage = async (
  imageName: string,
  slug: string,
  pageName: string,
): Promise<Image> => {
  const image = await makeImage(imageName);
  const page = await createTestSitePage(slug, { name: pageName });
  await setItemsForImage(image.id, [{ id: page.id, kind: "page" }]);
  return image;
};

/** Store an image row whose filename is an encrypted empty string — the broken
 * shape the first-class images migration copied from a legacy listing whose
 * image_url was an encrypted "". The thumbnail is broken the same way unless a
 * working `thumbFilename` is given. Returns the row id. */
export const insertBrokenImage = async (
  options: { name?: string; thumbFilename?: string } = {},
): Promise<number> => {
  const brokenFilename = await encrypt("");
  const result = await execute(
    sql`INSERT INTO images (name, filename, filename_thumb, alt_text)
     VALUES (${await encrypt(options.name ?? "Broken")}, ${brokenFilename}, ${options.thumbFilename === undefined
        ? brokenFilename
        : await encrypt(options.thumbFilename)}, '')`
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

/** Assert the image library answers its 404 for this request. */
export const expectImageNotFound = (
  request: Promise<Response>,
): Promise<unknown> => expectApiError(request, 404, "Image not found");

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

/** The activity log's messages. A library write bumps the settings version,
 *  which leaves the snapshot at its defaults until it reloads, and the log's
 *  decryption needs the wrapped private key the snapshot holds. */
export const loggedMessages = async (): Promise<string[]> => {
  await settings.loadKeys(ALL_SETTINGS_KEYS);
  return activityMessages();
};
