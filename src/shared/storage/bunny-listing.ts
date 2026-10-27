/** The Bunny CDN directory-listing call, on the shared API client. The caller
 *  filters and sorts the entries. This module only reads the directory. */

import { defineApiClient } from "#shared/api-client.ts";
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
  const response = await bunnyListingClient(zoneName, zoneKey).raw(`/${dir}`);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(
      `Storage listing for ${label || "the zone root"} failed: HTTP ${response.status}`,
    );
  }
  return JSON.parse(response.text) as Record<string, unknown>[];
};
