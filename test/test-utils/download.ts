import { assertStringIncludes } from "@std/assert";
import { requireValue } from "#shared/required-value.ts";

/** Assert `response` is a download of `contentType` whose
 *  `content-disposition` carries `disposition` — the headers every export
 *  route must set before the test reads its body. */
export const expectDownloadHeaders = (
  response: Response,
  contentType: string,
  disposition: string,
): void => {
  assertStringIncludes(
    requireValue(
      response.headers.get("content-type"),
      "The download has no content-type header.",
    ),
    contentType,
  );
  assertStringIncludes(
    requireValue(
      response.headers.get("content-disposition"),
      "The download has no content-disposition header.",
    ),
    disposition,
  );
};
