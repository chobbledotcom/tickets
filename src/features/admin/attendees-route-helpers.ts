/**
 * Shared utilities for admin attendee route handlers
 */

/* jscpd:ignore-start */
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import {
  createEntityRouteHandlers,
  withEntityLoader,
} from "#routes/admin/entity-handlers.ts";
import { AUTH_FORM, type AuthSession, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import { decryptAttendeeOrNull } from "#shared/db/attendees/pii.ts";
import { getAttendee } from "#shared/db/attendees/queries.ts";
import {
  getListingWithAttendeeRaw,
  getListingWithCount,
} from "#shared/db/listings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
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

/** Load and decrypt one attendee by id with the request's session key. */
const getDecryptedAttendee = async (
  attendeeId: number,
): Promise<Attendee | null> =>
  getAttendee(attendeeId, await requireRequestPrivateKey());

/** Curried loader: decrypt the attendee (null → 404), then complete the
 * load with whatever else the caller needs alongside it. */
export const withDecryptedAttendee =
  <T>(complete: (attendee: Attendee) => Promise<T | null>) =>
  async (attendeeId: number): Promise<T | null> => {
    const attendee = await getDecryptedAttendee(attendeeId);
    return attendee === null ? null : complete(attendee);
  };

/**
 * Load an attendee (by id alone) plus its HOME listing — the attendee-scoped
 * counterpart of {@link loadAttendeeForListing} for the action routes under
 * /admin/attendees/:id/* (delete, refund, resend-notification). The home
 * listing is the attendee's first booking, exactly what the Actions tab keys
 * its links on; an orphan attendee (no bookings) 404s, as it always has.
 */
export const loadAttendeeWithHomeListing: (
  attendeeId: number,
) => Promise<AttendeeWithListing | null> = withDecryptedAttendee(
  async (attendee) => {
    const listing = await getListingWithCount(attendee.listing_id);
    return listing ? { attendee, listing } : null;
  },
);

/** Route params for listing-scoped routes */
export type ListingRouteParams = { id: number };

/** Route params for listing-scoped attendee routes */
type AttendeeRouteParams = { listingId: number; attendeeId: number };

/** GET/POST handler pair for the attendee-scoped action routes. */
const attendeeActionHandlers = createEntityRouteHandlers(
  loadAttendeeWithHomeListing,
  ({ attendeeId }: { attendeeId: number }) => attendeeId,
);

/** The canonical URL of an attendee-scoped action (confirm page + POST). */
export const attendeeActionUrl = (attendeeId: number, action: string): string =>
  `/admin/attendees/${attendeeId}/${action}`;

/** The action URL with the caller's return_url threaded on, so bouncing back
 *  to the confirm page keeps its "return here when done" link (and hidden
 *  field) for a corrected retry. Empty return_url yields the plain action URL. */
export const attendeeActionUrlWithReturn = (
  attendeeId: number,
  action: string,
  returnUrl: string,
): string =>
  `${attendeeActionUrl(attendeeId, action)}${
    returnUrl ? `?return_url=${encodeURIComponent(returnUrl)}` : ""
  }`;

/** An attendee-action confirm page renderer's shape. */
type AttendeeActionRenderer = (
  data: AttendeeWithListing,
  session: AdminSession,
  returnUrl?: string,
  error?: string,
) => string;

/** GET handler for an attendee-action confirm page: auth, load the attendee +
 * home listing, render with the flashed error and threaded return_url. An
 * optional guard can block the action up front — its message renders in the
 * page at HTTP 400 (the refund page's no-payment/already-refunded states). */
export const attendeeActionPage = (
  render: AttendeeActionRenderer,
  guard?: (data: AttendeeWithListing) => Promise<string | null>,
) =>
  attendeeActionHandlers.get(async (request, session, data) => {
    const returnUrl = getReturnUrl(request);
    const blocked = guard ? await guard(data) : null;
    if (blocked !== null) {
      return htmlResponse(render(data, session, returnUrl, blocked), 400);
    }
    const flash = applyFlash(request);
    return htmlResponse(render(data, session, returnUrl, flash.error));
  });

/** POST handler for an attendee-scoped action that first verifies the typed
 * attendee name, bouncing back to the action's own confirm page on mismatch. */
export const verifiedAttendeeAction = (
  action: string,
  actionLabel: string | undefined,
  handler: (
    data: AttendeeWithListing,
    form: FormParams,
  ) => Response | Promise<Response>,
) =>
  attendeeActionHandlers.post((_session, form, data) => {
    const error = verifyOrRedirect(
      form,
      data.attendee.name,
      attendeeActionUrlWithReturn(
        data.attendee.id,
        action,
        form.getString("return_url"),
      ),
      "Attendee name",
      actionLabel,
    );
    if (error) return error;
    return handler(data, form);
  });

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
