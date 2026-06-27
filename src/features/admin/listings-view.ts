/**
 * Listing detail page (attendee list with optional date / check-in filters).
 *
 * Also owns the attendee helpers shared with the CSV export route — the
 * date-filtered attendee handler and the question-answer loader — since the
 * export mirrors the on-screen attendee table.
 */

/* jscpd:ignore-start */
import { compact, filter, map, pipe, sort, unique } from "#fp";
import {
  getDateFilter,
  listingAttendeesLoader,
} from "#routes/admin/actions.ts";
import type { AuthSession } from "#routes/auth.ts";
import { anyChildListing } from "#routes/public/ticket-payment.ts";
import { htmlResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatDateLabel } from "#shared/dates.ts";
import { getGroupRemainingByGroupId } from "#shared/db/attendees/capacity.ts";
import { groupsTable } from "#shared/db/groups.ts";
import { getChildrenForParents } from "#shared/db/listing-parents.ts";
import {
  getListingAggregateRecalculation,
  listingRevenueBreakdown,
} from "#shared/db/listings.ts";
import { deleteAllStaleReservations } from "#shared/db/processed-payments.ts";
import {
  type AttendeeQuestionData,
  getAttendeeAnswersBatch,
  getQuestionsForListing,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { loadNotesForAttendees } from "#shared/db/system-notes.ts";
import { getFlash } from "#shared/flash-context.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import {
  type AttendeeFilter,
  adminListingPage,
  type GroupContext,
} from "#templates/admin/listings.tsx";

/* jscpd:ignore-end */

/** Extract check-in message params from request URL */
const getCheckinMessage = (
  request: Request,
): { name: string; status: string } | null => {
  const url = new URL(request.url);
  const name = url.searchParams.get("checkin_name");
  const status = url.searchParams.get("checkin_status");
  if (name && (status === "in" || status === "out")) {
    return { name, status };
  }
  return null;
};

/** Filter attendees by date for daily listings */
const filterByDate = (
  attendees: Attendee[],
  date: string | null,
): Attendee[] =>
  date ? filter((a: Attendee) => a.date === date)(attendees) : attendees;

/** Collect unique dates from attendees, sorted ascending */
const getUniqueDates: (
  attendees: Attendee[],
) => { value: string; label: string }[] = pipe(
  map((a: Attendee) => a.date),
  (dates) => compact(dates),
  (dates) => unique(dates),
  sort((a, b) => a.localeCompare(b)),
  map((d) => ({ label: formatDateLabel(d), value: d })),
);

/** Get date filter and filtered attendees for daily listings */
const applyDateFilter = (
  listing: ListingWithCount,
  attendees: Attendee[],
  request: Request,
) => {
  const dateFilter =
    listing.listing_type === "daily" ? getDateFilter(request) : null;
  const availableDates =
    listing.listing_type === "daily" ? getUniqueDates(attendees) : [];
  return {
    availableDates,
    dateFilter,
    filteredByDate: filterByDate(attendees, dateFilter),
  };
};

/** Context handed to a date-filtered attendee handler. */
type FilteredAttendees = {
  listing: ListingWithCount;
  session: AuthSession;
  /** Every attendee across all dates (before the date filter is applied). */
  attendees: Attendee[];
  dateFilter: string | null;
  availableDates: { value: string; label: string }[];
  filteredByDate: Attendee[];
};

/**
 * Adapt the {@link listingAttendeesLoader} callback (listing, attendees,
 * session) into a handler that receives the listing pre-filtered by the
 * request's date filter. Shared by the detail page and the CSV export so they
 * apply the same filtering. The full attendee list is still passed through for
 * actions (e.g. emailing) that target every date, not just the filtered view.
 */
export const filteredAttendeesHandler =
  (
    request: Request,
    inner: (ctx: FilteredAttendees) => Response | Promise<Response>,
  ) =>
  (listing: ListingWithCount, attendees: Attendee[], session: AuthSession) =>
    inner({
      attendees,
      listing,
      session,
      ...applyDateFilter(listing, attendees, request),
    });

/**
 * Load the questions for a listing together with each attendee's answers
 * (including decrypted free text), shaped for the attendee table / CSV export.
 * Returns undefined when the listing has no questions, so callers can skip the
 * answers UI without an extra check.
 */
export const loadListingQuestionData = async (
  listingId: number,
  attendeeIds: number[],
): Promise<AttendeeQuestionData | undefined> => {
  const [questions, answers] = await Promise.all([
    getQuestionsForListing(listingId),
    getAttendeeAnswersBatch(attendeeIds, {
      privateKey: await requireRequestPrivateKey(),
      texts: true,
    }),
  ]);
  return questions.length > 0
    ? {
        attendeeAnswerMap: answers.answerIds,
        questions,
        textAnswerMap: answers.textAnswers,
      }
    : undefined;
};

/** Fetch group + current usage when the listing sits in a capped group, so the
 * detail page can render a row for the shared cap. Returns undefined for
 * ungrouped or uncapped groups. */
const loadGroupContext = async (
  listing: ListingWithCount,
  dateFilter: string | null,
): Promise<GroupContext | undefined> => {
  if (listing.group_id === 0) return undefined;
  const group = await groupsTable.findById(listing.group_id);
  if (!group || group.max_attendees <= 0) return undefined;
  const remainingMap = await getGroupRemainingByGroupId([group.id], dateFilter);
  // group.max_attendees > 0 guarantees the helper returns an entry for it.
  const remaining = remainingMap.get(group.id) as number;
  return { attendeeCount: group.max_attendees - remaining, group };
};

/** Render listing page with attendee list and optional filter */
const renderListingPage = async (
  request: Request,
  { id }: { id: number },
  activeFilter: AttendeeFilter = "all",
) => {
  // Run stale reservation cleanup concurrently with listing data loading.
  // These are independent: cleanup targets processed_payments with NULL attendee_id,
  // which doesn't affect the attendees query. Saves 1 HTTP round-trip.
  const [, response] = await Promise.all([
    deleteAllStaleReservations(),
    listingAttendeesLoader(
      request,
      id,
    )(
      filteredAttendeesHandler(
        request,
        async ({
          listing,
          session,
          attendees,
          dateFilter,
          availableDates,
          filteredByDate,
        }) => {
          const attendeeIds = filteredByDate.map((a) => a.id);
          const [
            flash,
            phonePrefix,
            questionData,
            groupContext,
            recalc,
            isChild,
            childrenByParent,
            revenueBreakdown,
            systemNotes,
          ] = await Promise.all([
            Promise.resolve(getFlash()),
            Promise.resolve(settings.phonePrefix),
            loadListingQuestionData(listing.id, attendeeIds),
            loadGroupContext(listing, dateFilter),
            getListingAggregateRecalculation(listing),
            // A child has no standalone share/QR affordance (invariant I3);
            // `anyChildListing` no-ops (no query) when the feature is off.
            anyChildListing([listing.id]),
            // A parent's required children — names the quick add-attendee warning
            // lists. Empty map (no key) when this listing isn't a parent.
            getChildrenForParents([listing.id]),
            listingRevenueBreakdown(listing.id),
            loadNotesForAttendees(attendeeIds, requireRequestPrivateKey),
          ]);
          return htmlResponse(
            adminListingPage({
              activeFilter,
              aggregateRecalculation: recalc,
              allowedDomain: getEffectiveDomain(),
              attendees: filteredByDate,
              availableDates,
              checkinMessage: getCheckinMessage(request),
              childNames: (childrenByParent.get(listing.id) ?? []).map(
                (child) => child.name,
              ),
              dateFilter,
              errorMessage: flash.error,
              groupContext,
              // Emailing a listing targets every attendee across all dates, so
              // gate the action on the full set, not the date-filtered view.
              hasEmailableAttendees: attendees.some((a) => a.email !== ""),
              isChild,
              listing,
              phonePrefix,
              questionData,
              revenueBreakdown,
              session,
              successMessage: flash.success,
              systemNotes,
            }),
          );
        },
      ),
    ),
  ]);
  return response;
};

/** Create a handler that renders the listing page with a specific attendee filter */
const listingPageHandler =
  (
    activeFilter?: AttendeeFilter,
  ): TypedRouteHandler<"GET /admin/listing/:id"> =>
  (request, params) =>
    renderListingPage(request, params, activeFilter);

/** Handle GET /admin/listing/:id */
export const handleAdminListingGet = listingPageHandler();

/** Handle GET /admin/listing/:id/in (checked-in filter) */
export const handleAdminListingGetIn = listingPageHandler("in");

/** Handle GET /admin/listing/:id/out (not-checked-in filter) */
export const handleAdminListingGetOut = listingPageHandler("out");
