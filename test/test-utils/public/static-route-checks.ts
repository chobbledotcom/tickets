import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { awaitTestRequest, mockRequest } from "#test-utils/mocks.ts";

/**
 * Every small static-file route (robots.txt, favicon.ico, style.css,
 * admin.js, the embed bundles, ...) shares the same three-part contract: a
 * GET returns 200 with a fixed content-type (and the caller can poke at the
 * body), a non-GET request 404s, and the response carries a one-year
 * immutable cache-control header. These three curried checks are the shared
 * shape behind `static-assets.test.ts` and `embed-bundles.test.ts` — the
 * varying bits (path, content-type, body check) are the sole arguments.
 */
export const expectStaticFile = async (
  path: string,
  contentType: string,
  checkBody?: (body: string) => void,
): Promise<void> => {
  const response = await handleRequest(mockRequest(path));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(contentType);
  if (checkBody) checkBody(await response.text());
};

export const expectLongCacheHeaders = async (path: string): Promise<void> => {
  const response = await handleRequest(mockRequest(path));
  expect(response.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
};

export const expect404ForNonGetStatic = async (path: string): Promise<void> => {
  const response = await awaitTestRequest(path, { data: {}, method: "POST" });
  expect(response.status).toBe(404);
};
