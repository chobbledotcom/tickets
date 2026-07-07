/**
 * Shared helpers for the attendee Logistics tab test files: create attendees
 * with bookings, GET the tab as the admin, and POST its form.
 */

import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

/** Create an attendee with the given bookings, returning their id. */
export const makeAttendee = async (
  name: string,
  bookings: ListingBooking[],
): Promise<number> => {
  const result = await createAttendeeAtomic({ bookings, email: "", name });
  // Callers pass listings with capacity, so the booking always succeeds; cast
  // the union rather than guard (a never-taken failure branch would be an
  // uncovered line).
  return (result as Extract<typeof result, { success: true }>).attendees[0]!.id;
};

/** GET an attendee's Logistics tab HTML as the admin. */
export const logisticsTabHtml = async (attendeeId: number): Promise<string> => {
  const { cookie } = await getTestSession();
  const response = await awaitTestRequest(
    `/admin/attendees/${attendeeId}/logistics`,
    { cookie },
  );
  expect(response.status).toBe(200);
  return response.text();
};

/** POST the Logistics tab form (session + CSRF handled). */
export const postLogistics = async (
  attendeeId: number,
  fields: Record<string, string>,
): Promise<Response> => {
  const { cookie, csrfToken } = await getTestSession();
  return handleRequest(
    mockFormRequest(
      `/admin/attendees/${attendeeId}/logistics`,
      { csrf_token: csrfToken, ...fields },
      cookie,
    ),
  );
};

/** A delivered (logistics) listing with one agent, booked by one attendee. */
export const deliveredListingSetup = async (
  agentName: string,
  attendeeName: string,
) => {
  settings.setForTest({ has_logistics: true });
  const listing = await createTestListing({ maxAttendees: 10 });
  await listingsTable.update(listing.id, { usesLogistics: true });
  const van = await logisticsAgents.table.insert({ name: agentName });
  const id = await makeAttendee(attendeeName, [{ listingId: listing.id }]);
  return { id, listing, van };
};
