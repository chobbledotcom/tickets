/**
 * Shared utilities for admin attendee route handlers
 */

/* jscpd:ignore-start */
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import {
  createEntityRouteHandlers,
  withEntityLoader,
} from "#routes/admin/entity-handlers.ts";
import type { AuthSession } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import type { IdFormHandler } from "#routes/entity.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { decryptAttendeeOrNull } from "#shared/db/attendees/pii.ts";
import { getAttendee } from "#shared/db/attendees/queries.ts";
import { getListingWithAttendeeRaw } from "#shared/db/listings/attendees.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { findByIdThen } from "#shared/find-by-id.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
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

/** A retained attendee record whose home listing may have been deleted. */
export type AttendeeRecord = {
  attendee: Attendee;
  listing: ListingWithCount | null;
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
  (attendeeId: number): Promise<T | null> =>
    findByIdThen(getDecryptedAttendee)(attendeeId, complete);

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

/** Load a record that still has a booking row, even when that row's listing is
 * gone. A true orphan has the left-join sentinel listing id 0 and stays outside
 * this action path. */
const loadAttendeeRecord: (
  attendeeId: number,
) => Promise<AttendeeRecord | null> = withDecryptedAttendee(async (attendee) =>
  attendee.listing_id > 0
    ? {
        attendee,
        listing: await getListingWithCount(attendee.listing_id),
      }
    : null,
);

/** Route params for listing-scoped routes */
export type ListingRouteParams = { id: number };

/** Route params for listing-scoped attendee routes */
type AttendeeRouteParams = { listingId: number; attendeeId: number };

type AttendeeActionRoute = (
  request: Request,
  params: { attendeeId: number },
) => Promise<Response>;

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
type AttendeeActionRenderer<T> = (
  data: T,
  session: AdminSession,
  returnUrl?: string,
  error?: string,
) => string;

/** Build the confirm and verified POST handlers over one attendee loader. */
const defineAttendeeActionRoutes = <T extends { attendee: Attendee }>(
  load: (attendeeId: number) => Promise<T | null>,
) => {
  const handlers = createEntityRouteHandlers(
    load,
    ({ attendeeId }: { attendeeId: number }) => attendeeId,
  );
  return {
    page: (
      render: AttendeeActionRenderer<T>,
      guard?: (data: T) => Promise<string | null>,
      available?: (data: T) => Promise<boolean>,
    ): AttendeeActionRoute =>
      handlers.get(async (request, session, data) => {
        if (available && !(await available(data))) return notFoundResponse();
        const returnUrl = getReturnUrl(request);
        const blocked = guard ? await guard(data) : null;
        if (blocked !== null) {
          return htmlResponse(render(data, session, returnUrl, blocked), 400);
        }
        const flash = applyFlash(request);
        return htmlResponse(render(data, session, returnUrl, flash.error));
      }),
    verified: (
      action: string,
      actionLabel: string | undefined,
      handler: (data: T, form: FormParams) => Response | Promise<Response>,
    ): AttendeeActionRoute =>
      handlers.post((_session, form, data) => {
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
      }),
  };
};

const listingAttendeeActions = defineAttendeeActionRoutes(
  loadAttendeeWithHomeListing,
);
const attendeeRecordActions = defineAttendeeActionRoutes(loadAttendeeRecord);

/** GET handler for an attendee-action confirm page: auth, load the attendee +
 * home listing, render with the flashed error and threaded return_url. An
 * optional guard can block the action up front — its message renders in the
 * page at HTTP 400 (the refund page's no-payment/already-refunded states). */
export const attendeeActionPage = (
  render: AttendeeActionRenderer<AttendeeWithListing>,
  guard?: (data: AttendeeWithListing) => Promise<string | null>,
): AttendeeActionRoute => listingAttendeeActions.page(render, guard);

/** Confirm page for deleting a retained attendee record. Unlike listing-based
 * actions, this works when the home listing is gone. */
export const attendeeRecordActionPage = (
  render: AttendeeActionRenderer<AttendeeRecord>,
  available: (data: AttendeeRecord) => Promise<boolean>,
): AttendeeActionRoute =>
  attendeeRecordActions.page(render, undefined, available);

/** POST handler for an attendee-scoped action that first verifies the typed
 * attendee name, bouncing back to the action's own confirm page on mismatch. */
export const verifiedAttendeeAction = (
  action: string,
  actionLabel: string | undefined,
  handler: (
    data: AttendeeWithListing,
    form: FormParams,
  ) => Response | Promise<Response>,
): AttendeeActionRoute =>
  listingAttendeeActions.verified(action, actionLabel, handler);

/** Verified POST for record deletion, with no live-listing requirement. */
export const verifiedAttendeeRecordAction = (
  action: string,
  actionLabel: string | undefined,
  handler: (
    data: AttendeeRecord,
    form: FormParams,
  ) => Response | Promise<Response>,
): AttendeeActionRoute =>
  attendeeRecordActions.verified(action, actionLabel, handler);

/** Route params for a POST scoped to one attendee by its id alone. */
type AttendeeIdRouteParams = { attendeeId: number };

/** A POST route scoped to one attendee (no listing load): authenticate under
 * the admin form gate, then run `handle` with the attendee id, the session, and
 * the parsed form. Shared by the note and logistics POSTs. */
export const attendeeFormPost = (
  handle: IdFormHandler,
): ((request: Request, params: AttendeeIdRouteParams) => Promise<Response>) =>
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
): ((request: Request, params: AttendeeRouteParams) => Promise<Response>) =>
  createAuthedHandler<AttendeeRouteParams, AttendeeWithListing>({
    handle: ({ context, form, params, session }) =>
      handler(context, session, form, params.listingId, params.attendeeId),
    loadContext: ({ listingId, attendeeId }) =>
      loadAttendeeForListing(listingId, attendeeId),
  });
