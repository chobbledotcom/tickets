/**
 * Shared utilities for admin attendee route handlers
 */

/* jscpd:ignore-start */
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { withEntityLoader } from "#routes/admin/entity-handlers.ts";
import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { getSearchParam } from "#routes/url.ts";
import { decryptAttendeeOrNull } from "#shared/db/attendees.ts";
import { getListingWithAttendeeRaw } from "#shared/db/listings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
/* jscpd:ignore-end */

/** Attendee with listing data */
export type AttendeeWithListing = {
  attendee: Attendee;
  listing: ListingWithCount;
};

/** No payment provider configured error (shared with attendee-refunds) */
export const NO_PROVIDER_ERROR = "No payment provider configured.";

/**
 * Load attendee ensuring it belongs to the specified listing.
 * Uses batched query to fetch listing + attendee in a single DB round-trip.
 * Decrypts attendee PII using the admin private key.
 */
export const loadAttendeeForListing = async (
  listingId: number,
  attendeeId: number,
): Promise<AttendeeWithListing | null> => {
  const pk = await requireRequestPrivateKey();
  const result = await getListingWithAttendeeRaw(listingId, attendeeId);
  if (!result) return null;

  const attendee = await decryptAttendeeOrNull(result.attendeeRaw, pk);
  if (!attendee || attendee.listing_id !== listingId) return null;

  return { attendee, listing: result.listing };
};

/** Load attendee with auth, returning 404 if not found */
export const withAttendee = withEntityLoader(loadAttendeeForListing);

/** Route params for listing-scoped routes */
export type ListingRouteParams = { id: number };

/** Route params for attendee-scoped routes */
type AttendeeRouteParams = { listingId: number; attendeeId: number };

/** Auth + load attendee GET handler (shared by delete, refund, and resend-notification GET routes) */
export const attendeeGetRoute =
  (
    handler: (
      data: AttendeeWithListing,
      session: AuthSession,
      request: Request,
    ) => Response | Promise<Response>,
  ) =>
  (
    request: Request,
    { listingId, attendeeId }: AttendeeRouteParams,
  ): Promise<Response> =>
    requireSessionOr(request, (session) =>
      withAttendee(
        listingId,
        attendeeId,
      )((data) => handler(data, session, request)),
    );

/** Auth + load attendee from form handler */
const withAttendeeForm = (
  request: Request,
  listingId: number,
  attendeeId: number,
  handler: (
    data: AttendeeWithListing,
    session: AuthSession,
    form: FormParams,
  ) => Response | Promise<Response>,
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withAttendee(listingId, attendeeId)((data) => handler(data, session, form)),
  );

/** Read return_url from request query params */
export const getReturnUrl = (request: Request): string =>
  getSearchParam(request, "return_url");

/** Attendee form handler that receives typed IDs */
type AttendeeFormAction = (
  data: AttendeeWithListing,
  session: AuthSession,
  form: FormParams,
  listingId: number,
  attendeeId: number,
) => Response | Promise<Response>;

/** Create an attendee form handler with typed IDs */
export const attendeeFormAction =
  (handler: AttendeeFormAction) =>
  (
    request: Request,
    { listingId, attendeeId }: AttendeeRouteParams,
  ): Promise<Response> =>
    withAttendeeForm(request, listingId, attendeeId, (data, session, form) =>
      handler(data, session, form, listingId, attendeeId),
    );

/** Attendee form handler that first verifies the attendee name */
export const verifiedAttendeeForm = (
  action: string,
  actionLabel: string | undefined,
  handler: (
    data: AttendeeWithListing,
    form: FormParams,
    listingId: number,
    attendeeId: number,
  ) => Response | Promise<Response>,
) =>
  attendeeFormAction((data, _session, form, listingId, attendeeId) => {
    const error = verifyOrRedirect(
      form,
      data.attendee.name,
      `/admin/listing/${listingId}/attendee/${attendeeId}/${action}`,
      "Attendee name",
      actionLabel,
    );
    if (error) return error;
    return handler(data, form, listingId, attendeeId);
  });
