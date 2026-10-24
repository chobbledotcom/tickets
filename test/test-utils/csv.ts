import { assertExists, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { awaitTestRequest } from "#test-utils/mocks.ts";

export const expectTestAttendeeCsvColumns = (
  row: string | undefined,
  quantity = 1,
): void => {
  assertExists(row);
  assertStringIncludes(row, "John Doe");
  assertStringIncludes(row, "john@example.com");
  assertStringIncludes(row, `,${quantity},`);
};

/** Asserts a response is a 200 CSV download with the standard
 *  Content-Disposition: attachment header, whose filename contains
 *  `filenameFragment` — the shared header contract behind every CSV export
 *  route (listing exports, calendar exports, etc). */
export const expectCsvDownloadHeaders = (
  response: Response,
  filenameFragment: string,
): void => {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  const disposition = response.headers.get("content-disposition");
  assertExists(disposition);
  assertStringIncludes(disposition, "attachment");
  assertStringIncludes(disposition, filenameFragment);
};

/** Fetch a listing's CSV export as the given admin, assert 200, return the body. */
export const fetchListingExportCsv = async (
  listingId: number,
  cookie: string,
  query = "",
): Promise<string> => {
  const response = await awaitTestRequest(
    `/admin/listing/${listingId}/export${query}`,
    { cookie },
  );
  expect(response.status).toBe(200);
  return await response.text();
};
