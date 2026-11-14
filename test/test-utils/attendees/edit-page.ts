import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { adminGet } from "#test-utils/session.ts";

/** Fetch the attendee edit page and assert its registrations table names the
 *  listing. Returns the HTML for any further assertions. */
export const expectEditPageRegistrations = async (
  attendeeId: number,
  listingName: string,
): Promise<string> => {
  const response = await adminGet(`/admin/attendees/${attendeeId}/edit`);
  return await expectHtmlResponse(
    response,
    200,
    listingName,
    "Listing Registrations",
  );
};
