/** The Bunny CDN directory-listing call, on the shared API client. The caller
 *  filters and sorts the entries. This module only reads the directory. */

import * as v from "valibot";
import { defineApiClient, jsonBodyOrUndefined } from "#shared/api-client.ts";
import { readFetchResult } from "#shared/fetch.ts";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";

/** The Bunny CDN listing client: the base URL, the AccessKey header, and the
 * labeled subrequest count. */
const bunnyListingClient = (zoneName: string, zoneKey: string) =>
  defineApiClient({
    baseUrl: `https://storage.bunnycdn.com/${zoneName}`,
    fetchImpl: async (url, buildInit) => {
      countExternalSubrequest("storage directory listing");
      return readFetchResult(await fetch(url, buildInit()));
    },
    headers: () => ({ AccessKey: zoneKey }),
  });

/** One listing entry: an object per stored file or folder. The caller reads
 * the entry's fields by name. */
const ListingEntriesSchema = v.array(v.record(v.string(), v.unknown()));

/** List a Bunny CDN directory's entries. A folder with no objects yet (for
 *  example a site that has never been backed up) answers 404. Treat only
 *  that 404 as an empty directory, the way readDirSafe handles a missing
 *  directory. Other failures must surface, not read as an empty zone. */
export const listBunnyDir = async (
  zoneName: string,
  zoneKey: string,
  dir: string,
  label: string,
): Promise<Record<string, unknown>[]> => {
  const where = `Storage listing for ${label || "the zone root"}`;
  const response = await bunnyListingClient(zoneName, zoneKey).raw(`/${dir}`);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`${where} failed: HTTP ${response.status}`);
  }
  const parsed = jsonBodyOrUndefined(response.text);
  if (parsed === undefined) {
    throw new Error(`${where} returned invalid JSON`);
  }
  if (!v.is(ListingEntriesSchema, parsed)) {
    throw new Error(`${where} returned an invalid response`);
  }
  return parsed;
};
