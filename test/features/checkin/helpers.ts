import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import type { Listing } from "#types";

interface CheckinSession {
  cookie: string;
  csrfToken: string;
}

type ListingOverrides = Parameters<typeof createTestAttendeeWithToken>[2];

/** Create an attendee, returning its token plus the admin session to act as. */
export const setupCheckinTest = async (
  name: string,
  email: string,
  listingOverrides: ListingOverrides = {},
  quantity = 1,
  phone = "",
): Promise<{ listing: Listing; session: CheckinSession; token: string }> => {
  const { listing, token } = await createTestAttendeeWithToken(
    name,
    email,
    listingOverrides,
    quantity,
    phone,
  );
  return {
    listing,
    session: { cookie: await testCookie(), csrfToken: await testCsrfToken() },
    token,
  };
};

/** Submit a check-in or check-out POST for a given token and session */
export const postCheckin = (
  token: string,
  session: CheckinSession,
  checkIn: "true" | "false",
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/checkin/${token}`,
      { check_in: checkIn, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );

/** Staff admit one leg of a two-listing booking through its own row's form,
 * the way the admin attendee page posts it. */
export const checkOneLegAsStaff = async (
  listingId: number,
  attendeeId: number,
): Promise<void> => {
  await handleRequest(
    mockFormRequest(
      `/admin/listing/${listingId}/attendee/${attendeeId}/checkin`,
      { csrf_token: await testCsrfToken() },
      await testCookie(),
    ),
  );
};

/** Read the ticket page for a token as a signed-in session sees it. */
export const readTicketPage = async (
  token: string,
  cookie: string,
): Promise<string> => {
  const response = await awaitTestRequest(`/checkin/${token}`, { cookie });
  expect(response.status).toBe(200);
  return response.text();
};
