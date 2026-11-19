import { handleRequest } from "#routes";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

/** Send the seeds form as the seeded admin, with a fresh CSRF token. */
export const postSeeds = async (values: {
  attendeesPerListing: string;
  listingCount: string;
}): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      "/admin/seeds",
      { csrfToken: await testCsrfToken(), ...values },
      await testCookie(),
    ),
  );
