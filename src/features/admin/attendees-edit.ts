/**
 * Admin attendee edit routes (edit page, refresh payment)
 */

/* jscpd:ignore-start */
import { compact, filter, map, uniqueBy } from "#fp";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import { createEntityRouteHandlers } from "#routes/admin/entity-handlers.ts";
import type { AuthSession } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import type { AttendeeRouteParams } from "#routes/entity.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { getAvailableDates } from "#shared/dates.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  ATTENDEE_LEFT_JOIN_SELECT,
  decryptAttendeeOrNull,
  type ListingAttendeeRow,
  markRefunded,
  updateAttendeePII,
} from "#shared/db/attendees.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getAllListings, getListingWithCount } from "#shared/db/listings.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsForListing,
  type QuestionWithAnswers,
  saveAttendeeAnswers,
} from "#shared/db/questions.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { adminEditAttendeePage } from "#templates/admin/attendees.tsx";
import { getReturnUrl, NO_PROVIDER_ERROR } from "./attendees-route-helpers.ts";

/* jscpd:ignore-end */

/** Get all listings (active + the current listing), uniquified */
const getListingsForSelector = async (
  currentListingId: number,
): Promise<ListingWithCount[]> => {
  const allListings = await getAllListings();
  const currentListing = allListings.find((e) => e.id === currentListingId);
  const activeListings = filter((e: ListingWithCount) => e.active)(allListings);
  return uniqueBy((e: ListingWithCount) => e.id)(
    compact([currentListing, ...activeListings]),
  );
};

/** A resolved listing link for display in the edit page */
type ListingLinkData = {
  listing: ListingWithCount;
  booking: ListingAttendeeRow;
  date: string | null;
};

const loadAttendeeForEdit = async (
  session: AuthSession,
  attendeeId: number,
): Promise<{
  attendee: Attendee;
  listing: ListingWithCount;
  listingLinks: ListingLinkData[];
  allListings: ListingWithCount[];
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
  /** Available dates per daily listing (for date picker) */
  availableDatesByListing: Record<number, string[]>;
} | null> => {
  const pk = await requirePrivateKey(session);
  const attendeeRaw = await queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [attendeeId],
  );
  if (!attendeeRaw) return null;
  const attendee = (await decryptAttendeeOrNull(attendeeRaw, pk))!;

  // Load all listing bookings for this attendee
  const bookingRows = await queryAll<ListingAttendeeRow>(
    `SELECT listing_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads
     FROM listing_attendees WHERE attendee_id = ?
     ORDER BY start_at, listing_id`,
    [attendeeId],
  );

  // Resolve listings for each booking in parallel (listing always exists — referential integrity)
  const listingLinks = await Promise.all(
    map(
      async (booking: ListingAttendeeRow): Promise<ListingLinkData> => ({
        booking,
        date: booking.start_at?.slice(0, 10) ?? null,
        listing: (await getListingWithCount(booking.listing_id))!,
      }),
    )(bookingRows),
  );

  // Attendees always have at least one listing link (enforced by createAttendeeAtomic)
  const firstListing = listingLinks[0]!.listing;
  const allListings = await getListingsForSelector(firstListing.id);
  const questions = await getQuestionsForListing(firstListing.id);
  const answersMap = await getAttendeeAnswersBatch([attendeeId]);
  const holidays = await getActiveHolidays();
  const selectedAnswerIds = answersMap.get(attendeeId) ?? [];

  // Build available dates for each daily listing
  const availableDatesByListing: Record<number, string[]> = {};
  for (const evt of allListings) {
    if (evt.listing_type === "daily") {
      availableDatesByListing[evt.id] = getAvailableDates(evt, holidays);
    }
  }

  return {
    allListings,
    attendee,
    availableDatesByListing,
    listing: firstListing,
    listingLinks,
    questions,
    selectedAnswerIds,
  };
};

type EditAttendeeData = NonNullable<
  Awaited<ReturnType<typeof loadAttendeeForEdit>>
>;

/** Curried: load edit attendee data then render with flash */
const editAttendeePage =
  (request: Request, session: AuthSession) =>
  (data: EditAttendeeData): Response => {
    const flash = applyFlash(request);
    return htmlResponse(
      adminEditAttendeePage(
        data,
        session,
        getReturnUrl(request),
        flash.success,
        flash.error,
      ),
    );
  };

const handlers = createEntityRouteHandlers(
  loadAttendeeForEdit,
  ({ attendeeId }: AttendeeRouteParams) => attendeeId,
);

/** Handle GET /admin/attendees/:attendeeId */
export const handleEditAttendeeGet = handlers.get((request, session, data) =>
  editAttendeePage(request, session)(data),
);

/** Handle POST /admin/attendees/:attendeeId */
async function editAttendeeHandler(
  _session: AuthSession,
  form: FormParams,
  data: EditAttendeeData,
  attendeeId: number,
): Promise<Response> {
  applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
  const editError = (msg: string) =>
    errorRedirect(`/admin/attendees/${attendeeId}`, msg);
  const name = form.getString("name");
  const email = form.getString("email");
  const phone = form.getString("phone");
  const address = form.getString("address");
  const special_instructions = form.getString("special_instructions");

  if (!name.trim()) return editError("Name is required");

  // Parse question answers
  const answerIds: number[] = [];
  for (const q of data.questions) {
    const raw = form.get(`question_${q.id}`);
    if (raw) {
      const answerId = Number.parseInt(raw, 10);
      if (q.answers.some((a) => a.id === answerId)) {
        answerIds.push(answerId);
      }
    }
  }

  // Update PII (shared across listings)
  await updateAttendeePII(attendeeId, {
    address,
    email,
    name,
    payment_id: data.attendee.payment_id,
    phone,
    special_instructions,
    ticket_token: data.attendee.ticket_token,
  });

  // Update answers (atomic delete + insert)
  if (data.questions.length > 0) {
    await saveAttendeeAnswers([attendeeId], answerIds);
  }

  await logActivity(`Attendee '${name}' updated`, data.listing.id);

  return redirect(
    `/admin/listing/${data.listing.id}#attendees`,
    `Updated ${name}`,
    true,
    { form },
  );
}
export const handleEditAttendeePost = handlers.post((session, form, data) =>
  editAttendeeHandler(session, form, data, data.attendee.id),
);

/** Handle POST /admin/attendees/:attendeeId/refresh-payment */
async function refreshPaymentHandler(
  _session: AuthSession,
  _form: FormParams,
  data: EditAttendeeData,
  attendeeId: number,
): Promise<Response> {
  if (!data.attendee.payment_id) {
    return redirect(
      `/admin/attendees/${attendeeId}`,
      "No payment to refresh",
      false,
    );
  }

  const provider = await getActivePaymentProvider();
  if (!provider) {
    return errorRedirect(`/admin/attendees/${attendeeId}`, NO_PROVIDER_ERROR);
  }

  const isRefunded = await provider.isPaymentRefunded(data.attendee.payment_id);
  if (isRefunded && !data.attendee.refunded) {
    await markRefunded(attendeeId, data.listing.id);
    await logActivity(
      `Payment marked as refunded for attendee '${data.attendee.name}'`,
      data.listing.id,
    );
    return redirect(
      `/admin/attendees/${attendeeId}`,
      "Payment status updated: refunded",
      true,
    );
  }

  return redirect(
    `/admin/attendees/${attendeeId}`,
    "Payment status is up to date",
    true,
  );
}
export const handleRefreshPayment = handlers.post((session, form, data) =>
  refreshPaymentHandler(session, form, data, data.attendee.id),
);
