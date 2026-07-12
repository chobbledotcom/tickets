/**
 * Data loaders for the listing entity page's read-only tabs — Overview,
 * Attendees (roster), and Activity. Each gathers exactly what its own tab
 * renders: per-tab loading means the expensive decrypted-attendee fetch only
 * runs for the two tabs that show the roster, never for Edit / Questions / QR.
 *
 * The panels themselves (ListingOverviewPanel / ListingRosterPanel) live in the
 * listings template; these loaders assemble their props from the DB. The
 * gathering mirrors the pre-migration detail handler (listings-view.ts) so the
 * tabs render the same data the single detail page used to.
 */

import { unique } from "#fp";
import type { PageCtx } from "#routes/admin/entity-pages.ts";
import { listingMoneyTotals } from "#shared/accounting/listing-money-totals.ts";
import { emptyRange } from "#shared/accounting/range.ts";
import { resolveRecipientEmails } from "#shared/bulk-email.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatDateLabel } from "#shared/dates.ts";
import {
  type ActivityLogEntry,
  getListingActivityLog,
  getListingWithActivityLog,
} from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getAttendeeNamesByIds } from "#shared/db/attendees/queries.ts";
import { getHiddenPackageMemberIds } from "#shared/db/groups.ts";
import { getListingOverviewStats } from "#shared/db/listing-overview-stats.ts";
import {
  anyNonStandaloneChild,
  getChildrenForParents,
} from "#shared/db/listing-parents.ts";
import { getListingAggregateRecalculation } from "#shared/db/listings/aggregates.ts";
import { getAttendeesByListingIds } from "#shared/db/listings/attendees.ts";
import { getAttendeeIdsWithPaymentReference } from "#shared/db/payment-references.ts";
import { deleteAllStaleReservations } from "#shared/db/processed-payments.ts";
import { getListingChoiceAnswerMap } from "#shared/db/questions/attendee-answers/reads.ts";
import { getQuestionsForListing } from "#shared/db/questions/queries.ts";
import { settings } from "#shared/db/settings.ts";
import {
  loadNotesForAttendees,
  loadNotesForListing,
  type SystemNote,
} from "#shared/db/system-notes.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  type Attendee,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  ListingOverviewPanel,
  overviewStatsFromDbStats,
} from "#templates/admin/listings/overview.tsx";
import { ListingRosterPanel } from "#templates/admin/listings/roster.tsx";
import type { AttendeeFilter } from "#templates/admin/listings/types.ts";
import type { TableQuestionData } from "#templates/attendee-table.tsx";
import {
  filterByDate,
  loadGroupContext,
  loadListingQuestionData,
} from "./listings-view.ts";
import { loadListingOr } from "./load-listing.ts";

/**
 * The listing entity page's loaded row: the listing plus the derived flags any
 * tab may gate on. A child listing or a hidden package's member has no
 * standalone public page, so its share / QR / booking-link affordances are
 * suppressed (invariant I3). `hasEmailableAttendees` gates the owner-only Email
 * action so it never links to the compose page's 404 (empty-recipient) path; it
 * is resolved lazily by the Actions tab's `prepare` hook (via
 * {@link listingHasEmailableAttendees}) rather than in the page-wide load, so
 * the recipient decrypt never runs for a tab that has no Email action.
 */
export type LoadedListing = {
  listing: ListingWithCount;
  isChild: boolean;
  isHiddenPackageMember: boolean;
  hasEmailableAttendees: boolean;
};

/** Load the listing and its cheap gating flags, or null when it is gone.
 *  `hasEmailableAttendees` defaults to false here — the decrypt behind it is
 *  deferred to the Actions tab, the only surface that reads it. */
export const loadListingForPage = (id: number): Promise<LoadedListing | null> =>
  loadListingOr(id, async (listing) => {
    const [isChild, hiddenMemberIds] = await Promise.all([
      // A `bookable_alone` child keeps its standalone share / QR affordances, so
      // gate on non-standalone children only (matches the public booking guard).
      anyNonStandaloneChild([id]),
      getHiddenPackageMemberIds([id]),
    ]);
    return {
      hasEmailableAttendees: false,
      isChild,
      isHiddenPackageMember: hiddenMemberIds.size > 0,
      listing,
    };
  });

/** Whether the listing has at least one attendee with an email on file — the
 *  same recipient resolution the bulk-email compose route uses, so the Email
 *  action's visibility matches whether that page would 404 on zero recipients.
 *  Runs only from the Actions tab's `prepare` hook, and only for owners. */
export const listingHasEmailableAttendees = async (
  listingId: number,
): Promise<boolean> => {
  const pk = await requireRequestPrivateKey();
  const recipients = await resolveRecipientEmails(
    { kind: "listing", listingId },
    pk,
  );
  return recipients.length > 0;
};

/** The roster's on-screen date + check-in filter, read from a tab's query. */
export type RosterFilter = {
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
};

/** Read the roster tab's `?filter=` / `?date=` selection from the query. Only
 *  daily listings honour the date, and only a well-formed ISO date is accepted
 *  (a malformed `?date=` is ignored, matching the pre-migration getDateFilter —
 *  otherwise a bogus value would filter out every attendee). */
export const rosterFilterFromQuery = (
  listing: ListingWithCount,
  query: URLSearchParams,
): RosterFilter => {
  const requested = query.get("filter");
  const activeFilter: AttendeeFilter =
    requested === "in" || requested === "out" ? requested : "all";
  const rawDate = query.get("date");
  const dateFilter =
    listing.listing_type === "daily" && rawDate && isIsoDate(rawDate)
      ? rawDate
      : null;
  return { activeFilter, dateFilter };
};

/** Load and decrypt a listing's attendees. Uses the attendees-only query (which
 *  yields an empty list for a listing with none) rather than the nullable
 *  listing+attendees fetch: the entity page has already confirmed the listing
 *  exists, so there is no missing-listing case to guard here. */
const loadDecryptedListingAttendees = async (
  listingId: number,
  privateKey: CryptoKey,
): Promise<Attendee[]> => {
  const attendeesRaw = await getAttendeesByListingIds([listingId]);
  return decryptAttendees(attendeesRaw, privateKey);
};

/** The distinct booking dates present on a daily listing, ascending, as the
 *  roster's date-picker options; empty for a non-daily listing. */
const availableDatesFor = (
  listing: ListingWithCount,
  attendees: Attendee[],
): { value: string; label: string }[] => {
  if (listing.listing_type !== "daily") return [];
  const dates = [
    ...new Set(attendees.map((a) => a.date).filter((d): d is string => !!d)),
  ].sort((a, b) => a.localeCompare(b));
  return dates.map((value) => ({ label: formatDateLabel(value), value }));
};

/** The Overview's answer summary needs only the questions and each attendee's
 *  chosen answer ids (counted per option) — never the free-text answers. So it
 *  reads the choice ids scoped to the listing in SQL, decrypting nothing.
 *  Returns undefined when the listing has no questions. */
const loadOverviewQuestionData = async (
  listingId: number,
): Promise<TableQuestionData | undefined> => {
  const [questions, attendeeAnswerMap] = await Promise.all([
    getQuestionsForListing(listingId),
    getListingChoiceAnswerMap(listingId),
  ]);
  return questions.length > 0 ? { attendeeAnswerMap, questions } : undefined;
};

/** Display names for the (few) attendees that authored a note, decrypting just
 *  their names — no key unwrap when the listing has no notes. */
const noteAuthorNames = async (
  notes: SystemNote[],
): Promise<Map<number, string>> =>
  notes.length === 0
    ? new Map()
    : getAttendeeNamesByIds(
        unique(notes.map((note) => note.attendee_id)),
        await requireRequestPrivateKey(),
      );

/** Build the Overview tab: the read-only details table, the income breakdown,
 *  and the attendee-notes summary. Reads only collated aggregates — the listing's
 *  individual attendee rows are never loaded or decrypted here (see
 *  {@link getListingOverviewStats}). */
export const loadListingOverviewPanel = async (
  { listing, isChild, isHiddenPackageMember }: LoadedListing,
  canViewLedger = false,
): Promise<JSX.Element> => {
  // Housekeeping the old detail view ran on every load: clear reservations
  // whose payment window lapsed, concurrently with the page's own reads.
  const [stats, recalc, moneyTotals, groupContext, systemNotes, questionData] =
    await Promise.all([
      getListingOverviewStats(listing),
      getListingAggregateRecalculation(listing),
      listingMoneyTotals(emptyRange, [listing.id]),
      // The Overview tab shows whole-listing totals (no date picker), so the
      // group cap is the all-dates figure.
      loadGroupContext(listing, null),
      loadNotesForListing(listing.id, requireRequestPrivateKey),
      loadOverviewQuestionData(listing.id),
      deleteAllStaleReservations(),
    ]);
  const noteNames = await noteAuthorNames(systemNotes);
  return ListingOverviewPanel({
    aggregateRecalculation: recalc,
    allowedDomain: getEffectiveDomain(),
    groupContext,
    isChild,
    isHiddenPackageMember,
    ...(canViewLedger ? { ledgerHref: listingLedgerHref(listing.id) } : {}),
    listing,
    noteNames,
    ...(questionData !== undefined ? { questionData } : {}),
    moneyTotals,
    stats: overviewStatsFromDbStats(
      stats,
      listing.attendee_count,
      moneyTotals.grossSales,
      isPaidListing(listing),
    ),
    systemNotes,
  });
};

/** Build the Attendees (roster) tab: the filtered attendee table plus the
 *  failed-payments split-out and the quick add-attendee form. */
export const loadListingRosterPanel = async (
  { listing }: LoadedListing,
  ctx: PageCtx,
): Promise<JSX.Element> => {
  const { activeFilter, dateFilter } = rosterFilterFromQuery(
    listing,
    ctx.query,
  );
  const privateKey = await requireRequestPrivateKey();
  const attendees = await loadDecryptedListingAttendees(listing.id, privateKey);
  const filteredByDate = filterByDate(attendees, dateFilter);
  const [
    questionData,
    childrenByParent,
    groupContext,
    systemNotes,
    paymentReferenceAttendeeIds,
  ] = await Promise.all([
    loadListingQuestionData(
      listing.id,
      filteredByDate.map((a) => a.id),
    ),
    getChildrenForParents([listing.id]),
    // The date-scoped group cap for the per-date capacity summary; a no-op
    // (null date) when no daily date is selected.
    loadGroupContext(listing, dateFilter),
    // The contact/history notes summary that used to sit above the roster on
    // the combined page — for the on-screen (date-filtered) attendees.
    loadNotesForAttendees(
      filteredByDate.map((a) => a.id),
      requireRequestPrivateKey,
    ),
    getAttendeeIdsWithPaymentReference(filteredByDate),
  ]);
  return ListingRosterPanel({
    activeFilter,
    allowedDomain: getEffectiveDomain(),
    attendees: filteredByDate,
    availableDates: availableDatesFor(listing, attendees),
    childNames: (childrenByParent.get(listing.id) ?? []).map(
      (child) => child.name,
    ),
    dateFilter,
    groupContext,
    listing,
    paymentReferenceAttendeeIds,
    phonePrefix: settings.phonePrefix,
    questionData,
    systemNotes,
  });
};

/** How many recent entries the Overview tab's activity preview shows before
 *  "View all activity" links into the full Activity tab. */
const ACTIVITY_PREVIEW_LIMIT = 5;

/** The Overview tab's short activity preview. */
export const loadListingActivityPreview = ({
  listing,
}: LoadedListing): Promise<ActivityLogEntry[]> =>
  getListingActivityLog(listing.id, ACTIVITY_PREVIEW_LIMIT);

/** The full activity log for the Activity tab. Uses the batched listing+log
 *  fetch; the framework has already resolved (and 404'd) the listing before this
 *  tab loads, so the row is present — assert it rather than carry a null branch
 *  this tab can never reach. */
export const loadListingActivity = async ({
  listing,
}: LoadedListing): Promise<ActivityLogEntry[]> =>
  (await getListingWithActivityLog(listing.id))!.entries;
