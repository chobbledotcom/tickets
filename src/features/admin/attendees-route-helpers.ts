/**
 * Shared utilities for admin attendee route handlers
 */

import { decryptAttendeeOrNull } from "#db/attendees/pii.ts";
import { getAttendeeOrNull, getFirstBooking } from "#db/attendees/queries.ts";
import { getListingWithAttendeeRaw } from "#db/listings/attendees.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import {
  getPaymentReviewState,
  type PaymentReviewState,
} from "#db/payment-review.ts";
import type { PaymentRecoveryAction } from "#payment/admit-move.ts";
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
import { findByIdThen } from "#shared/find-by-id.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ParamsRoute, ResponseHandler } from "#shared/response-steps.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { AdminSession, Attendee, ListingWithCount } from "#types";
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
    listingId: (await getFirstBooking(attendee.id))?.listingId ?? null,
    paymentReview: await getPaymentReviewState(attendee.id),
  }),
);

export type AttendeeWithBooking = AttendeeWithListing & {
  /** The selected booking row itself proves whether a live line remains. */
  activeBooking: boolean;
};

/** Load the first stored booking and its listing for a booking action. */
const loadAttendeeWithBooking: (
  attendeeId: number,
) => Promise<AttendeeWithBooking | null> = withDecryptedAttendee(
  async (attendee) => {
    const booking = await getFirstBooking(attendee.id);
    if (booking === null) return null;
    const listing = await getListingWithCount(booking.listingId);
    return listing === null
      ? null
      : { activeBooking: booking.active, attendee, listing };
  },
);

/** Route params for listing-scoped routes */
export type ListingRouteParams = { id: number };

/** Route params for listing-scoped attendee routes */
type AttendeeRouteParams = { listingId: number; attendeeId: number };

/** The canonical URL of an attendee-scoped action (confirm page + POST). */
export const attendeeActionUrl = <Action extends string>(
  attendeeId: number,
  action: Action,
): string => `/admin/attendees/${attendeeId}/${action}`;

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

type AttendeeActionPage<Data> = {
  /** A refusal renders its explanation but never leaves an enabled form. */
  readonly reason: string | null;
  readonly render: AttendeeActionRenderer<Data>;
};

type AttendeeActionPagePreparation<Data> = (
  data: Data,
) => AttendeeActionPage<Data> | Promise<AttendeeActionPage<Data>>;

/** A page with no data-dependent admission work. */
export const attendeeActionPage =
  <Data>(
    render: AttendeeActionRenderer<Data>,
  ): AttendeeActionPagePreparation<Data> =>
  () => ({ reason: null, render });

type AttendeeActionRoute = ParamsRoute<AttendeeIdRouteParams>;

type AttendeeActionDefinition<
  Data extends AttendeeActionData,
  Action extends string,
> = {
  /** A rendered action has a reachable target exactly when its scope exists. */
  isAvailable: (hasBooking: boolean) => boolean;
  load: (attendeeId: number) => Promise<Data | null>;
  page: (
    prepare: AttendeeActionPagePreparation<Data>,
    requireSession?: SessionGuard<AuthSession>,
  ) => AttendeeActionRoute;
  verified: (
    actionLabel: string | undefined,
    handler: ResponseHandler<[data: Data, form: FormParams]>,
    auth?: AuthPolicy<"form">,
  ) => AttendeeActionRoute;
  /** The real route owned by this action. */
  url: (attendeeId: number) => string;
  /** The action segment this definition owns. */
  readonly action: Action;
};

/** Give every attendee action the same loader, visibility, GET, and POST
 * interface. Its scope decides all four together, so a link cannot promise a
 * booking that the route then fails to load. */
const defineAttendeeAction = <
  Data extends AttendeeActionData,
  Action extends string,
>(
  action: Action,
  scope: "attendee" | "booking",
  load: (attendeeId: number) => Promise<Data | null>,
): AttendeeActionDefinition<Data, Action> => {
  const actionHandler = createEntityHandler<AttendeeIdRouteParams, Data>(
    ({ attendeeId }) => load(attendeeId),
  );
  return {
    action,
    isAvailable: (hasBooking) => scope === "attendee" || hasBooking,
    load,
    page: (
      prepare,
      requireSession: SessionGuard<AuthSession> = requireSessionOr,
    ) =>
      actionHandler(requireSession)(async (data, session, request) => {
        const returnUrl = getReturnUrl(request);
        const page = await prepare(data);
        if (page.reason !== null) {
          return htmlResponse(
            await page.render(data, session, returnUrl, page.reason),
            400,
          );
        }
        const flash = applyFlash(request);
        return htmlResponse(
          await page.render(data, session, returnUrl, flash.error),
        );
      }),
    url: (attendeeId) => attendeeActionUrl(attendeeId, action),
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

const attendeeAction = <Action extends string>(action: Action) =>
  defineAttendeeAction<AttendeeActionData, Action>(
    action,
    "attendee",
    loadAttendeeActionData,
  );
const bookingAction = <Action extends string>(action: Action) =>
  defineAttendeeAction<AttendeeWithBooking, Action>(
    action,
    "booking",
    loadAttendeeWithBooking,
  );

/** Keep each action's map key and real route segment identical. */
const defineAttendeeActions = <
  const Actions extends Record<string, { readonly action: string }>,
>(
  actions: Actions & {
    [Action in keyof Actions]: {
      readonly action: Extract<Action, string>;
    };
  },
): Actions => actions;

/** The complete action schema. Adding an action means choosing its scope once;
 * its route loader and page visibility then share that decision. */
export const attendeeActions = defineAttendeeActions({
  delete: attendeeAction("delete"),
  "payment-review": defineAttendeeAction<
    PaymentReviewActionData,
    "payment-review"
  >("payment-review", "attendee", loadPaymentReviewActionData),
  "refresh-payment": attendeeAction("refresh-payment"),
  refund: bookingAction("refund"),
  "resend-notification": bookingAction("resend-notification"),
  "send-text": bookingAction("send-text"),
});

/** Select a lifecycle action from the complete attendee-action schema. */
export const paymentRecoveryAction = (
  action: PaymentRecoveryAction,
): (typeof attendeeActions)[PaymentRecoveryAction] => attendeeActions[action];

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
