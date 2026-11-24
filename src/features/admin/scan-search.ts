/** The manual check-in search at one door. The scanner page carries no list
 * of the door's people: a door that wants someone by name asks this route.
 * The only way to put the whole list on a device is the logged offline
 * download in `scan-cache.ts`. */

import { sortedByString } from "#fp-strings";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RosterOption } from "#shared/roster-option.ts";
import { scopeAttendees } from "./scan-answer.ts";
import {
  doorListingNames,
  doorRoster,
  doorRoute,
  loadGroupDoor,
  loadListingDoor,
} from "./scan-door.ts";

/** The fewest characters a search takes. A shorter search can list most of
 * the door. */
const SEARCH_MIN_LENGTH = 2;

/** The most people one search answers. */
const SEARCH_MAX_RESULTS = 20;

/** The people whose name holds the search text, ignoring case, in name
 * order, up to the most one search answers. */
const matchingPeople = (
  options: readonly RosterOption[],
  text: string,
): RosterOption[] => {
  const wanted = text.toLowerCase();
  return sortedByString((option: RosterOption) => option.name)(
    options.filter((option) => option.name.toLowerCase().includes(wanted)),
  ).slice(0, SEARCH_MAX_RESULTS);
};

/** The search behind one door: the people the door can still check in whose
 * name holds `q`. */
const handleScanSearchGet = doorRoute(async (door, request) => {
  const text = new URL(request.url).searchParams.get("q")?.trim();
  if (text === undefined || text.length < SEARCH_MIN_LENGTH) {
    return apiErrorResponse("Search text is too short");
  }
  const roster = doorRoster(
    await scopeAttendees(door.scope),
    await doorListingNames(door.scope),
  );
  return jsonResponse({ options: matchingPeople(roster, text) });
});

/** The search routes of both door kinds. */
export const scanSearchRoutes = {
  "GET /admin/groups/:id/scan-search": handleScanSearchGet(loadGroupDoor),
  "GET /admin/listing/:id/scan-search": handleScanSearchGet(loadListingDoor),
};
