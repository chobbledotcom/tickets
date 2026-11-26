/** The manual check-in search at one door. The scanner page carries no list
 * of the door's people: a door that wants someone by name asks this route.
 * The only way to put the whole list on a device is the logged offline
 * download in `scan-cache.ts`. */

import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import { matchingPeople, SEARCH_MIN_LENGTH } from "#shared/roster-option.ts";
import { scopeAttendees } from "./scan-answer.ts";
import {
  doorListingNames,
  doorRoster,
  doorRoute,
  loadGroupDoor,
  loadListingDoor,
} from "./scan-door.ts";

/** The search behind one door: the people the door can still check in whose
 * name holds `q`. */
const handleScanSearchGet = doorRoute(async (door, { request }) => {
  const text = new URL(request.url).searchParams.get("q")?.trim();
  if (text === undefined || text.length < SEARCH_MIN_LENGTH) {
    return apiErrorResponse("Search text is too short");
  }
  const roster = doorRoster(
    await scopeAttendees(door.scope),
    door.scope.checkInEveryListing,
    await doorListingNames(door.scope),
  );
  return jsonResponse({ options: matchingPeople(roster, text) });
});

/** The search routes of both door kinds. */
export const scanSearchRoutes = {
  "GET /admin/groups/:id/scan-search": handleScanSearchGet(loadGroupDoor),
  "GET /admin/listing/:id/scan-search": handleScanSearchGet(loadListingDoor),
};
