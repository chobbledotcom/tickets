/**
 * Shared fixtures for the run-sheet tests.
 *
 * Both the run-sheet journeys and the run-sheet display tests need the same
 * set-up: a van, an owner assigned to it, a booking on a chosen day, and the
 * rendered page. One copy keeps the two files in step.
 */

import { expect } from "@std/expect";
import { getDb } from "#db/client.ts";
import { setLogisticsAssignments } from "#db/logistics.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { userAgents } from "#db/user-agents.ts";
import { getUserByUsername } from "#db/users.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { DateString } from "#shared/validation/date-string.ts";
import { testDate } from "#test-utils/dates.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { TEST_ADMIN_USERNAME } from "#test-utils/internal.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { createTestAgentSession, testCookie } from "#test-utils/session.ts";

/** Assign logistics agents (vans) to the owner test user, so the staff run
 * sheet — scoped to the viewer's own agents — has deliveries to show. */
export const assignOwnerAgents = async (agentIds: number[]): Promise<void> => {
  const owner = (await getUserByUsername(TEST_ADMIN_USERNAME))!;
  await userAgents.setIds(owner.id, agentIds);
};

/** Fetch the owner run sheet for a specific date (the `?date=` picker link). */
export const fetchDeliveriesForDate = async (date: string): Promise<string> => {
  const response = await handleRequest(
    mockRequest(`/admin/deliveries?date=${date}`, {
      headers: { cookie: await testCookie() },
    }),
  );
  expect(response.status).toBe(200);
  return response.text();
};

/** Fetch the staff run sheet as HTML, asserting the request succeeds. */
export const fetchDeliveriesHtml = async (): Promise<string> => {
  const response = await handleRequest(
    mockRequest("/admin/deliveries", {
      headers: { cookie: await testCookie() },
    }),
  );
  expect(response.status).toBe(200);
  return response.text();
};

/** Create a logistics agent and return its id. */
export const makeVan = async (name: string): Promise<number> =>
  (await logisticsAgents.table.insert({ name })).id;

/** Create a booking dropped off on `startDate` with the given drop-off/
 * collection agents. `durationDays` is the hire length in whole days: `end_at`
 * is the exclusive end (start + duration), so a 1-day hire is collected the
 * same day and a 2-day hire the next day. */
export const makeBookingOn = async (
  startAgent: number,
  endAgent: number,
  startDate: DateString,
  durationDays = 1,
  name = "Bouncy Castle",
): Promise<{ attendeeId: number; listingId: number; listingName: string }> => {
  const listing = await createTestListing({ maxAttendees: 100, name });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Alice",
    "alice@example.com",
    1,
    "07700900000",
  );
  await setLogisticsAssignments(
    attendee.id,
    false,
    new Map([
      [
        listing.id,
        {
          endAgentId: endAgent,
          endTime: "17:00",
          startAgentId: startAgent,
          startTime: "09:00",
        },
      ],
    ]),
  );
  const endDate = addDays(startDate, durationDays);
  await getDb().execute(
    sql`UPDATE listing_attendees SET start_at = ${`${startDate}T00:00:00Z`}, end_at = ${`${endDate}T00:00:00Z`} WHERE attendee_id = ${attendee.id} AND listing_id = ${listing.id}`,
  );
  return {
    attendeeId: attendee.id,
    listingId: listing.id,
    listingName: name,
  };
};

/** Create a booking dropped off today (the common case for agent run sheets). */
export const makeTodayBooking = (
  startAgent: number,
  endAgent: number,
  durationDays = 1,
  name = "Bouncy Castle",
): Promise<{ attendeeId: number; listingId: number; listingName: string }> =>
  makeBookingOn(
    startAgent,
    endAgent,
    testDate(todayInTz(settings.timezone)),
    durationDays,
    name,
  );

/** Mark a leg done or not done, as the form on the run sheet does. */
export const markRequest = async (
  cookie: string,
  data: Record<string, string>,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      "/admin/deliveries/mark",
      { csrf_token: await signCsrfToken(), ...data },
      cookie,
    ),
  );

/** Set up a van, an agent who sees it, and a today booking lasting `days`
 * days, then return that agent's rendered deliveries page HTML. */
export const agentHireDeliveriesHtml = async (
  days: number,
  token: string,
  username: string,
): Promise<string> => {
  const van = await makeVan("Van 1");
  const { cookie } = await createTestAgentSession({
    agentIds: [van],
    token,
    username,
  });
  await makeTodayBooking(van, van, days);
  return (await awaitTestRequest("/admin/deliveries", { cookie })).text();
};
