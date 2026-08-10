/**
 * Listing detail page (attendee list with optional date / check-in filters).
 *
 * Also owns the attendee helpers shared with the CSV export route — the
 * date-filtered attendee handler and the question-answer loader — since the
 * export mirrors the on-screen attendee table.
 */

import {
  compact,
  filter,
  map,
  pipe,
  requiredMapValue,
  sort,
  unique,
} from "#fp";
import { getDateFilter } from "#routes/admin/actions.ts";
import type { AuthSession } from "#routes/auth.ts";
import { coveredDays, formatDateLabel } from "#shared/dates.ts";
import { getGroupRemainingByGroupId } from "#shared/db/attendees/capacity/groups.ts";
import { getGroupsByIds, listingGroups } from "#shared/db/groups.ts";
import {
  type AttendeeQuestionData,
  getAttendeeAnswersBatch,
} from "#shared/db/questions/attendee-answers/reads.ts";
import { getQuestionsForListing } from "#shared/db/questions/queries.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import type {
  DateOption,
  GroupContext,
} from "#templates/admin/listings/types.ts";

/** Keep the attendees a chosen day belongs to. A booking counts for every day
 * it covers, so day 2 of a three-day stay lists that stay. */
export const filterByDate = (
  attendees: Attendee[],
  date: string | null,
): Attendee[] =>
  date
    ? filter((a: Attendee) => coveredDays(a.date, a.end_date).includes(date))(
        attendees,
      )
    : attendees;

const getUniqueDates: (attendees: Attendee[]) => DateOption[] = pipe(
  (attendees: Attendee[]) =>
    attendees.flatMap((a: Attendee) => coveredDays(a.date, a.end_date)),
  (dates: string[]) => compact(dates),
  (dates) => unique(dates),
  sort((a, b) => a.localeCompare(b)),
  map((d: string) => ({ label: formatDateLabel(d), value: d })),
);

/** The roster's date-picker options; empty for a listing not booked by the day. */
export const dateOptionsFor = (
  listing: ListingWithCount,
  attendees: Attendee[],
): DateOption[] =>
  listing.listing_type === "daily" ? getUniqueDates(attendees) : [];

/** Get date filter and filtered attendees for daily listings */
const applyDateFilter = (
  listing: ListingWithCount,
  attendees: Attendee[],
  request: Request,
) => {
  const dateFilter =
    listing.listing_type === "daily" ? getDateFilter(request) : null;
  return {
    availableDates: dateOptionsFor(listing, attendees),
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
  (request: Request, inner: ResponseHandler<[ctx: FilteredAttendees]>) =>
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
 * ungrouped or uncapped groups. A listing can belong to several capped groups;
 * the one with the FEWEST remaining spots is the binding constraint (a booking
 * is blocked by the tightest group — see capacity.ts), so surface that one. */
export const loadGroupContext = async (
  listing: ListingWithCount,
  dateFilter: string | null,
): Promise<GroupContext | undefined> => {
  const groupIds = await listingGroups.getIds(listing.id);
  const groupsById = await getGroupsByIds(groupIds);
  const capped = groupIds.flatMap((groupId) => {
    const group = groupsById.get(groupId);
    return group && group.max_attendees > 0 ? [group] : [];
  });
  if (capped.length === 0) return;
  const remainingMap = await getGroupRemainingByGroupId(
    capped.map((group) => group.id),
    dateFilter,
  );
  let tightest: { ctx: GroupContext; remaining: number } | undefined;
  for (const group of capped) {
    // max_attendees > 0 guarantees the helper returns an entry for the group.
    const remaining = requiredMapValue(
      remainingMap,
      group.id,
      "Missing group remaining",
    );
    if (tightest === undefined || remaining < tightest.remaining) {
      tightest = {
        ctx: { attendeeCount: group.max_attendees - remaining, group },
        remaining,
      };
    }
  }
  return tightest?.ctx;
};
