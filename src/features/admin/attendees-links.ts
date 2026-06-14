/**
 * Admin attendee listing-link management routes (add, unlink, update)
 */

import { unlinkAttendeeFromListing } from "#shared/db/attendees.ts";
import { queryOne } from "#shared/db/client.ts";
import { getListingWithCount } from "#shared/db/listings.ts";

export {
  handleAddListingLink,
  handleUpdateListingLink,
  parseQuantity,
} from "#routes/admin/attendees-link-form.ts";

import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";

/** Handle POST /admin/attendees/:attendeeId/unlink/:listingId — remove listing link */
export const handleUnlinkListing: TypedRouteHandler<
  "POST /admin/attendees/:attendeeId/unlink/:listingId"
> = (request, params) =>
  withAuth(request, AUTH_FORM, () =>
    handleUnlinkListingAction(params.attendeeId, params.listingId),
  );

const handleUnlinkListingAction = async (
  attendeeId: number,
  listingId: number,
): Promise<Response> => {
  const linkCount = await queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM listing_attendees WHERE attendee_id = ?",
    [attendeeId],
  );
  if (linkCount && linkCount.count <= 1) {
    return errorRedirect(
      `/admin/attendees/${attendeeId}`,
      "Cannot remove the last listing — delete the attendee instead",
    );
  }

  await unlinkAttendeeFromListing(attendeeId, listingId);
  const listing = await getListingWithCount(listingId);
  return redirect(
    `/admin/attendees/${attendeeId}`,
    `Attendee unlinked from '${listing!.name}'`,
    true,
  );
};
