import { pairKey } from "#booking/ticket-moves.ts";
import { decryptAttendeeFields } from "#db/attendees/pii.ts";
import { getAttendeeOrNull, getFirstBooking } from "#db/attendees/queries.ts";
import { getPairBookings } from "#db/attendees/ticket-lines.ts";
import { getListingWithAttendeeRaw } from "#db/listings/attendees.ts";
import {
  getListingWithCount,
  requireListingWithCount,
} from "#db/listings/records.ts";
import {
  getPaymentReviewState,
  type PaymentReviewState,
} from "#db/payment-review.ts";
import { requiredMapValue } from "#fp";
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

export type AttendeeWithListing = {
  attendee: Attendee;
  listing: ListingWithCount;
};

/** Decrypt each raw row and resolve its listing, as notification entries. */
export const attendeeListingEntries = async (
  rows: Attendee[],
  pk: CryptoKey,
): Promise<AttendeeWithListing[]> =>
  Promise.all(
    rows.map(async (row) => ({
      attendee: await decryptAttendeeFields(row, pk),
      listing: await requireListingWithCount(row.listing_id),
    })),
  );

/** Loads one person's booking on one listing, or null when they hold none. */
type ListingAttendeeLoader = (
  listingId: number,
  attendeeId: number,
) => Promise<AttendeeWithListing | null>;

/** Load the attendee's booking line for one listing. An attendee with no
 * booking on the listing reads as null — the route then answers 404. */
export const loadAttendeeForListing: ListingAttendeeLoader = async (
  listingId,
  attendeeId,
) => {
  const result = await getListingWithAttendeeRaw(listingId, attendeeId);
  if (result === null || result.attendeeRows.length === 0) return null;
  // The row exists, so its decrypt always answers — the null-tolerant helper
  // is for the batch reads that can hold no row.
  const attendee = await decryptAttendeeFields(
    result.attendeeRows[0]!,
    await requireRequestPrivateKey(),
  );
  return { attendee, listing: result.listing };
};

/** Load the person's whole booking on one listing. Several lines can share
 * the pair: two parents, two dates. A check-in moves the whole booking, so
 * the page and the POST read the counts the write moves. */
export const loadAttendeeBooking: ListingAttendeeLoader = async (
  listingId,
  attendeeId,
) => {
  const loaded = await loadAttendeeForListing(listingId, attendeeId);
  if (loaded === null) return null;
  const bookings = await getPairBookings([{ attendeeId, listingId }]);
  const booking = requiredMapValue(
    bookings,
    pairKey(attendeeId, listingId),
    `Attendee ${attendeeId} has no booking read on listing ${listingId}`,
  );
  return { ...loaded, attendee: { ...loaded.attendee, ...booking } };
};

export const withAttendee = withEntityLoader(loadAttendeeForListing);

export const withAttendeeBooking = withEntityLoader(loadAttendeeBooking);

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
  /** The selected booking row's package group: a resend rehydrates this
   * package alone, or every standalone line when it holds none. */
  selectedPackageGroupId: number;
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
      : {
          activeBooking: booking.active,
          attendee,
          listing,
          selectedPackageGroupId: booking.packageGroupId,
        };
  },
);

export type ListingRouteParams = { id: number };

type AttendeeRouteParams = { listingId: number; attendeeId: number };

/** The canonical URL of an attendee-scoped action (confirm page + POST). */
export const attendeeActionUrl = <Action extends string>(
  attendeeId: number,
  action: Action,
): string => `/admin/attendees/${attendeeId}/${action}`;

/** The action URL with the caller's return_url threaded on. Bouncing back to
 *  the confirm page then keeps its "return here when done" link and hidden
 *  field for a corrected retry. Empty return_url yields the plain action URL. */
export const attendeeActionUrlWithReturn = (
  attendeeId: number,
  action: string,
  returnUrl: string,
): string =>
  `${attendeeActionUrl(attendeeId, action)}${
    returnUrl ? `?return_url=${encodeURIComponent(returnUrl)}` : ""
  }`;

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
  url: (attendeeId: number) => string;
  readonly action: Action;
};

/** Give every attendee action the same loader, visibility, GET, and POST
 * interface. Its scope decides all four together, so a link cannot promise a
 * booking that the route then fails to load. Pin a scope to its loader once,
 * so a booking-scoped action can never be defined against the attendee-only
 * loader (or the reverse). */
const scopedAction =
  <Data extends AttendeeActionData>(
    scope: "attendee" | "booking",
    load: (attendeeId: number) => Promise<Data | null>,
  ) =>
  <Action extends string>(
    action: Action,
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

const attendeeAction = scopedAction("attendee", loadAttendeeActionData);
const bookingAction = scopedAction("booking", loadAttendeeWithBooking);

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

/** The complete action schema. Adding an action means choosing its scope
 * once. Its route loader and page visibility then share that decision. */
export const attendeeActions = defineAttendeeActions({
  delete: attendeeAction("delete"),
  "payment-review": scopedAction(
    "attendee",
    loadPaymentReviewActionData,
  )("payment-review"),
  "refresh-payment": attendeeAction("refresh-payment"),
  refund: bookingAction("refund"),
  "resend-notification": bookingAction("resend-notification"),
  "send-text": bookingAction("send-text"),
});

export const paymentRecoveryAction = (
  action: PaymentRecoveryAction,
): (typeof attendeeActions)[PaymentRecoveryAction] => attendeeActions[action];

type AttendeeIdRouteParams = { attendeeId: number };

/** A POST route scoped to one attendee, with no listing load. Shared by the
 * note and logistics POSTs. */
export const attendeeFormPost = (
  handle: IdFormHandler,
): ((request: Request, params: AttendeeIdRouteParams) => Promise<Response>) =>
  createAuthedHandler<AttendeeIdRouteParams>({
    handle: ({ form, params, session }) =>
      handle(params.attendeeId, session, form),
  });

export const getReturnUrl = (request: Request): string =>
  getSearchParam(request, "return_url");

type AttendeeFormAction = ResponseHandler<
  [
    data: AttendeeWithListing,
    session: AuthSession,
    form: FormParams,
    listingId: number,
    attendeeId: number,
  ]
>;

/** Create an attendee form handler with typed IDs. The `load` argument picks
 * the context: the line loader for row-scoped actions. The booking loader
 * serves the check-in actions that move the whole (person, listing) booking. */
const attendeeFormActionLoading =
  (
    load: (
      listingId: number,
      attendeeId: number,
    ) => Promise<AttendeeWithListing | null>,
  ) =>
  (
    handler: AttendeeFormAction,
  ): ((request: Request, params: AttendeeRouteParams) => Promise<Response>) =>
    createAuthedHandler<AttendeeRouteParams, AttendeeWithListing>({
      handle: ({ context, form, params, session }) =>
        handler(context, session, form, params.listingId, params.attendeeId),
      loadContext: ({ listingId, attendeeId }) => load(listingId, attendeeId),
    });

export const attendeeFormAction = attendeeFormActionLoading(
  loadAttendeeForListing,
);

/** Create a check-in form handler: its context is the person's whole booking
 * on the listing, ticket counts summed across every row the pair holds. */
export const attendeeBookingFormAction =
  attendeeFormActionLoading(loadAttendeeBooking);
