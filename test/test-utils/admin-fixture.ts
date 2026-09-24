/** The standard admin fixture and the request helpers built on it: one
 * listing, its "John Doe" attendee, and the owner session. */
import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { AdminTestContext } from "#test-utils/internal.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

export const setupAdminTest = async (
  listingOverrides: TestListingOverrides = {},
): Promise<AdminTestContext> => {
  const { createTestListing } = await import(
    "#test-utils/db-helpers/listings.ts"
  );
  const { createTestAttendee } = await import(
    "#test-utils/db-helpers/attendees.ts"
  );
  const listing = await createTestListing({
    maxAttendees: 100,
    thankYouUrl: "https://example.com",
    ...listingOverrides,
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "John Doe",
    "john@example.com",
  );
  const { cookie, csrfToken } = await getTestSession();
  return { attendee, cookie, csrfToken, listing };
};

type AdminFixtureResult = AdminTestContext & { response: Response };

/** Set up the standard admin fixture, send one request built from it, and
 * hand back the fixture together with the response. */
const onAdminFixture =
  (send: (ctx: AdminTestContext) => Promise<Response>) =>
  async (
    listingOverrides: TestListingOverrides = {},
  ): Promise<AdminFixtureResult> => {
    const ctx = await setupAdminTest(listingOverrides);
    return { ...ctx, response: await send(ctx) };
  };

export const adminAttendeeAction =
  (action: string, scope: "listing" | "attendee" = "attendee") =>
  (
    formData: Record<string, string> = {},
  ): ((
    listingOverrides?: TestListingOverrides,
  ) => Promise<AdminFixtureResult>) =>
    onAdminFixture(async (ctx) => {
      const url =
        scope === "listing"
          ? `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/${action}`
          : `/admin/attendees/${ctx.attendee.id}/${action}`;
      return awaitTestRequest(url, {
        cookie: ctx.cookie,
        data: { csrf_token: ctx.csrfToken, ...formData },
      });
    });

export const adminListingPage = (
  pathFn: (ctx: AdminTestContext) => string,
): ((listingOverrides?: TestListingOverrides) => Promise<AdminFixtureResult>) =>
  onAdminFixture(async (ctx) =>
    awaitTestRequest(pathFn(ctx), { cookie: ctx.cookie }),
  );
