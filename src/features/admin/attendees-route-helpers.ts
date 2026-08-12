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
import {
  getAttendeeOrNull,
  getFirstBookingListingId,
} from "#shared/db/attendees/queries.ts";
import { getListingWithAttendeeRaw } from "#shared/db/listings/attendees.ts";
import {
  getPaymentReviewState,
  type PaymentReviewState,
} from "#shared/db/payment-review.ts";
import { requireListingWithCount } from "#shared/db/listings/records.ts";
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

/** One attendee-scoped action needs no booking to remain reachable. */
type AttendeeActionData = { attendee: Attendee };

type PaymentReviewActionData = AttendeeActionData & {
  listingId: number | null;
  paymentReview: PaymentReviewState;
};

const loadAttendeeActionData: (
  attendeeId: number,
) => Promise<AttendeeActionData | null> = withDecryptedAttendee((attendee) =>
  Promise.resolve({ attendee }),
);

const loadPaymentReviewActionData: (
  attendeeId: number,
) => Promise<PaymentReviewActionData | null> = withDecryptedAttendee(
  async (attendee) => ({
    attendee,
    listingId: await getFirstBookingListingId(attendee.id),
    paymentReview: await getPaymentReviewState(attendee.id),
  }),
);

/** Load the first stored booking and its live listing for a booking action. */
const loadAttendeeWithBooking: (
  attendeeId: number,
) => Promise<AttendeeWithListing | null> = withDecryptedAttendee(
  async (attendee) => {
    const listingId = await getFirstBookingListingId(attendee.id);
    if (listingId === null) return null;
    return { attendee, listing: await requireListingWithCount(listingId) };
  },
);

/** Route params for listing-scoped routes */
export type ListingRouteParams = { id: number };

/** Route params for listing-scoped attendee routes */
type AttendeeRouteParams = { listingId: number; attendeeId: number };

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
type AttendeeActionRenderer<Data> = (
  data: Data,
  session: AdminSession,
  returnUrl?: string,
  error?: string,
) => string | Promise<string>;

type AttendeeActionRoute = ParamsRoute<AttendeeIdRouteParams>;

type AttendeeActionDefinition<Data extends AttendeeActionData> = {
  /** A rendered action has a reachable target exactly when its scope exists. */
  isAvailable: (hasBooking: boolean) => boolean;
  load: (attendeeId: number) => Promise<Data | null>;
  page: (
    render: AttendeeActionRenderer<Data>,
    guard?: (data: Data) => Promise<string | null>,
    requireSession?: SessionGuard<AuthSession>,
  ) => AttendeeActionRoute;
  verified: (
    actionLabel: string | undefined,
    handler: ResponseHandler<[data: Data, form: FormParams]>,
    auth?: AuthPolicy<"form">,
  ) => AttendeeActionRoute;
};

/** Give every attendee action the same loader, visibility, GET, and POST
 * interface. Its scope decides all four together, so a link cannot promise a
 * booking that the route then fails to load. */
const defineAttendeeAction = <Data extends AttendeeActionData>(
  action: string,
  scope: "attendee" | "booking",
  load: (attendeeId: number) => Promise<Data | null>,
): AttendeeActionDefinition<Data> => {
  const actionHandler = createEntityHandler<AttendeeIdRouteParams, Data>(
    ({ attendeeId }) => load(attendeeId),
  );
  return {
    isAvailable: (hasBooking) => scope === "attendee" || hasBooking,
    load,
    page: (
      render,
      guard,
      requireSession: SessionGuard<AuthSession> = requireSessionOr,
    ) =>
      actionHandler(requireSession)(async (data, session, request) => {
        const returnUrl = getReturnUrl(request);
        const blocked = guard ? await guard(data) : null;
        if (blocked !== null) {
          return htmlResponse(
            await render(data, session, returnUrl, blocked),
            400,
          );
        }
        const flash = applyFlash(request);
        return htmlResponse(
          await render(data, session, returnUrl, flash.error),
        );
      }),
    verified: (actionLabel, handler, auth: AuthPolicy<"form"> = AUTH_FORM) =>
      actionHandler(formGuard(auth))((data, _session, form) => {
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

const attendeeAction = (action: string) =>
  defineAttendeeAction<AttendeeActionData>(
    action,
    "attendee",
    loadAttendeeActionData,
  );
const bookingAction = (action: string) =>
  defineAttendeeAction<AttendeeWithListing>(
    action,
    "booking",
    loadAttendeeWithBooking,
  );

/** The complete action schema. Adding an action means choosing its scope once;
 * its route loader and page visibility then share that decision. */
export const attendeeActions = {
  delete: attendeeAction("delete"),
  "payment-review": defineAttendeeAction(
    "payment-review",
    "attendee",
    loadPaymentReviewActionData,
  ),
  "refresh-payment": attendeeAction("refresh-payment"),
  refund: bookingAction("refund"),
  "resend-notification": bookingAction("resend-notification"),
  "send-text": bookingAction("send-text"),
} as const;

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
