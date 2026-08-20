import { handleRequest } from "#routes";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
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
