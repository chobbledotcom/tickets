import { attendeePage } from "#routes/admin/attendee-page.ts";
import type { AuthSession } from "#routes/auth.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withTestSession } from "#test-utils/session.ts";

const sessionAt = (adminLevel: AuthSession["adminLevel"]): AuthSession => ({
  adminLevel,
  token: "t",
  userId: 1,
  wrappedDataKey: null,
});

export const OWNER = sessionAt("owner");
export const MANAGER = sessionAt("manager");

/** One booked attendee to render the page against. */
export const bookAttendee = async (): Promise<number> => {
  const listing = await createTestListing({});
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Ada Lovelace",
    "ada@example.com",
  );
  return attendee.id;
};

export const renderTab = async (
  id: number,
  slug: string,
  session: AuthSession = OWNER,
): Promise<Response> =>
  await withTestSession(() => attendeePage.renderPage(session, id, slug));

export const tabHtml = async (
  id: number,
  slug: string,
  session: AuthSession = OWNER,
): Promise<string> => await (await renderTab(id, slug, session)).text();
