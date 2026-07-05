import { handleRequest } from "#routes";
import { getImagesForItem, imagesTable } from "#shared/db/images.ts";
import type { Image } from "#shared/types.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { mockMultipartRequest, mockRequest } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";
import { makeTestPng } from "#test-utils/test-image.ts";

export const makeImage = (name: string): Promise<Image> =>
  imagesTable.insert({
    altText: `Alt ${name}`,
    filename: nonEmptyString(`${name.toLowerCase()}.webp`),
    filenameThumb: nonEmptyString(`${name.toLowerCase()}-thumb.webp`),
    name,
  });

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
  itemType: "listing" | "group",
  itemId: number,
): Promise<string[]> =>
  (await getImagesForItem(itemType, itemId)).map((image) => image.name);
