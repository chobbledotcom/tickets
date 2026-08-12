/**
 * Shared utilities for admin attendee route handlers
 */

/* jscpd:ignore-start */
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { withEntityLoader } from "#routes/admin/entity-handlers.ts";
import {
  AUTH_FORM,
  type AuthPolicy,
  type AuthSession,
  formGuard,
  requireSessionOr,
  type SessionGuard,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { createEntityHandler, type IdFormHandler } from "#routes/entity.ts";
import { htmlResponse } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { decryptAttendeeOrNull } from "#shared/db/attendees/pii.ts";
import { getAttendeeOrNull } from "#shared/db/attendees/queries.ts";
import { getListingWithAttendeeRaw } from "#shared/db/listings/attendees.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { findByIdThen } from "#shared/find-by-id.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ParamsRoute, ResponseHandler } from "#shared/response-steps.ts";
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
  getAttendeeOrNull(attendeeId, await requireRequestPrivateKey());

/** Curried loader: decrypt the attendee (null → 404), then complete the
 * load with whatever else the caller needs alongside it. */
export const withDecryptedAttendee =
  <T>(complete: (attendee: Attendee) => Promise<T | null>) =>
  (attendeeId: number): Promise<T | null> =>
    findByIdThen(getDecryptedAttendee)(attendeeId, complete);

/**
 * Load an attendee (by id alone) plus its HOME listing — the attendee-scoped
 * counterpart of {@link loadAttendeeForListing} for the action routes under
 * /admin/attendees/:id/* (delete, refund, payment review, notification). The home
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

/** Shared loader for attendee-scoped GET and POST action handlers. */
const attendeeActionHandler = createEntityHandler<
  AttendeeIdRouteParams,
  AttendeeWithListing
>(({ attendeeId }) => loadAttendeeWithHomeListing(attendeeId));

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

type AttendeeActionRoute = ParamsRoute<AttendeeIdRouteParams>;

/** Render an attendee confirmation. A guard answers HTTP 400; callers may also
 * supply a stricter session gate. */
export const attendeeActionPage = (
  render: AttendeeActionRenderer,
  guard?: (data: AttendeeWithListing) => Promise<string | null>,
  requireSession: SessionGuard<AuthSession> = requireSessionOr,
): AttendeeActionRoute =>
  attendeeActionHandler(requireSession)(async (data, session, request) => {
    const returnUrl = getReturnUrl(request);
    const blocked = guard ? await guard(data) : null;
    if (blocked !== null) {
      return htmlResponse(render(data, session, returnUrl, blocked), 400);
    }
    const flash = applyFlash(request);
    return htmlResponse(render(data, session, returnUrl, flash.error));
  });

/** POST handler for an attendee-scoped action that first verifies the typed
 * attendee name, bouncing back to the action's own confirm page on mismatch.
 * Its form policy can narrow the role allowed to submit. */
export const verifiedAttendeeAction = (
  action: string,
  actionLabel: string | undefined,
  handler: ResponseHandler<[data: AttendeeWithListing, form: FormParams]>,
  auth: AuthPolicy<"form"> = AUTH_FORM,
): AttendeeActionRoute =>
  attendeeActionHandler(formGuard(auth))((data, _session, form) => {
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

/** Route params for a POST scoped to one attendee by its id alone. */
type AttendeeIdRouteParams = { attendeeId: number };

/** A POST route scoped to one attendee (no listing load): authenticate under
 * the admin form gate, then run `handle` with the attendee id, the session, and
 * the parsed form. Shared by the note and logistics POSTs. */
export const attendeeFormPost = (
  handle: IdFormHandler,
): (request: Request, params: AttendeeIdRouteParams) => Promise<Response> =>
  createAuthedHandler<AttendeeIdRouteParams>({
    handle: ({ form, params, session }) =>
      handle(params.attendeeId, session, form),
  });

/** Read return_url from request query params */
export const getReturnUrl = (request: Request): string =>
  getSearchParam(request, "return_url");

/** Attendee form handler that receives typed IDs */
type AttendeeFormAction = ResponseHandler<
  [
    data: AttendeeWithListing,
    session: AuthSession,
    form: FormParams,
    listingId: number,
    attendeeId: number,
  ]
>;

/** Create an attendee form handler with typed IDs */
export const attendeeFormAction = (
  handler: AttendeeFormAction,
): (request: Request, params: AttendeeRouteParams) => Promise<Response> =>
  createAuthedHandler<AttendeeRouteParams, AttendeeWithListing>({
    handle: ({ context, form, params, session }) =>
      handler(context, session, form, params.listingId, params.attendeeId),
    loadContext: ({ listingId, attendeeId }) =>
      loadAttendeeForListing(listingId, attendeeId),
  });
