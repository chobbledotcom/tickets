import { assertStringIncludes } from "@std/assert";

/** Assert `response` is a download of `contentType` whose
 *  `content-disposition` carries `disposition` — the headers every export
 *  route must set before the test reads its body. */
export const expectDownloadHeaders = (
  response: Response,
  contentType: string,
  disposition: string,
): void => {
  assertStringIncludes(response.headers.get("content-type") ?? "", contentType);
  assertStringIncludes(
    response.headers.get("content-disposition") ?? "",
    disposition,
  );
};
