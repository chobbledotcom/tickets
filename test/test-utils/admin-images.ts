import { encrypt } from "#crypto/encryption.ts";
import { execute } from "#db/client.ts";
import { getImagesForItem, imagesTable } from "#db/images.ts";
import { handleRequest } from "#routes";
import { nonEmptyString } from "#shared/validation/string.ts";
import { mockMultipartRequest, mockRequest } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";
import { makeTestPng } from "#test-utils/test-image.ts";
import type { Image, ImageUseItemType } from "#types";

export const makeImage = (name: string): Promise<Image> =>
  imagesTable.insert({
    altText: `Alt ${name}`,
    filename: nonEmptyString(`${name.toLowerCase()}.webp`),
    filenameThumb: nonEmptyString(`${name.toLowerCase()}-thumb.webp`),
    name,
  });

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
