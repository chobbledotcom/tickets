import { handleRequest } from "#routes";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

/** Send the seeds form as the seeded admin, with a fresh CSRF token. */
export const postSeeds = async (values: {
  attendees_per_listing: string;
  listing_count: string;
}): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      "/admin/seeds",
      { csrf_token: await testCsrfToken(), ...values },
      await testCookie(),
    ),
  );
