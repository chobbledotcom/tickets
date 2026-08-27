/**
 * Data loaders for the listing entity page. Most serve the read-only tabs —
 * Overview, Attendees (roster), and Activity. Each one gathers exactly what
 * its own tab renders, so the expensive decrypted-attendee fetch runs for the
 * two tabs that show the roster and for no other.
 *
 * `getListingAndGroups` is the exception, because the edit form and the edit
 * tab's panels both need it. It sits here rather than inside either of them.
 *
 * The panels themselves (ListingOverviewPanel / ListingRosterPanel) live in
 * the listings template. These loaders assemble their props from the DB.
 */

import { listingMoneyTotals } from "#accounting/listing-money-totals.ts";
import { emptyRange } from "#accounting/range.ts";
import {
  type ActivityLogEntry,
  getListingActivityLog,
  getListingWithActivityLogOrNull,
} from "#db/activity-log.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeeNamesByIds } from "#db/attendees/queries.ts";
import {
  getHiddenPackageMemberIds,
  groups,
  listingGroups,
} from "#db/groups.ts";
import { getListingOverviewStats } from "#db/listing-overview-stats.ts";
import {
  anyNonStandaloneChild,
  hydrateListingLinks,
  listingChildren,
} from "#db/listing-parents.ts";
import {
  getListingAggregateRecalculation,
  type ListingAggregateRecalculation,
} from "#db/listings/aggregates.ts";
import { getAttendeesByListingIds } from "#db/listings/attendees.ts";
import { getStoredListingWithCount } from "#db/listings/records.ts";
import {
  loadNotesForAttendees,
  loadNotesForListing,
} from "#db/notes/queries.ts";
import type { SystemNote } from "#db/notes/types.ts";
import { getAttendeeIdsWithPaymentReference } from "#db/payment-references.ts";
import { deleteAllStaleReservations } from "#db/processed-payments.ts";
import { getListingChoiceAnswerMap } from "#db/questions/attendee-answers/reads.ts";
import { getQuestionsForListing } from "#db/questions/queries.ts";
import { settings } from "#db/settings.ts";
import { unique } from "#fp";
import type { PageCtx } from "#routes/admin/entity-pages.ts";
import { readAttendeeListState } from "#shared/attendee-list-controls.ts";
import { resolveRecipientEmails } from "#shared/bulk-email.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  ListingOverviewPanel,
  overviewStatsFromDbStats,
} from "#templates/admin/listings/overview.tsx";
import { ListingRosterPanel } from "#templates/admin/listings/roster.tsx";
import type { TableQuestionData } from "#templates/attendee-table/types.ts";
import {
  type Attendee,
  type Group,
  isOwnerRole,
  isPaidListing,
  type ListingWithCount,
} from "#types";
import {
  dateOptionsFor,
  filterByDate,
  loadGroupContext,
  loadListingQuestionData,
  rosterListSetup,
} from "./listings-view.ts";
import { loadListingOr } from "./load-listing.ts";

/** Listing + its groups + aggregate recalculation, loaded for the edit pages. */
export const getListingAndGroups = async (
  listingId: number,
): Promise<{
  aggregateRecalculation: ListingAggregateRecalculation;
  groups: Group[];
  listing: ListingWithCount;
  selectedGroupIds: number[];
} | null> => {
  const [listing, allGroups, selectedGroupIds] = await Promise.all([
    // The edit form reads the listing's *stored* values, not the resolved
    // view. An edit to an inheriting listing must not bake the current
    // defaults into its row.
    getStoredListingWithCount(listingId),
    groups.cache.getAll(),
    listingGroups.getIds(listingId),
  ]);
  return listing
    ? {
        aggregateRecalculation: await getListingAggregateRecalculation(listing),
        groups: allGroups,
        listing,
        selectedGroupIds,
      }
    : null;
};

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
        unique(notes.map((note) => note.entity_id)),
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
    isOwner: canViewLedger,
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
  const privateKey = await requireRequestPrivateKey();
  const attendees = await loadDecryptedListingAttendees(listing.id, privateKey);
  const setup = rosterListSetup(listing, dateOptionsFor(listing, attendees));
  const state = readAttendeeListState(setup, ctx.query);
  const filteredByDate = filterByDate(attendees, state.date);
  const [
    questionData,
    childrenLinks,
    groupContext,
    systemNotes,
    paymentReferenceAttendeeIds,
  ] = await Promise.all([
    loadListingQuestionData(
      listing.id,
      filteredByDate.map((a) => a.id),
    ),
    hydrateListingLinks(listingChildren, [listing.id]),
    // The date-scoped group cap for the per-date capacity summary; a no-op
    // (null date) when no daily date is selected.
    loadGroupContext(listing, state.date),
    // The contact/history notes summary that used to sit above the roster on
    // the combined page — for the on-screen (date-filtered) attendees.
    loadNotesForAttendees(
      filteredByDate.map((a) => a.id),
      requireRequestPrivateKey,
    ),
    getAttendeeIdsWithPaymentReference(filteredByDate),
  ]);
  return ListingRosterPanel({
    allowedDomain: getEffectiveDomain(),
    attendees: filteredByDate,
    childNames: (childrenLinks.listingsByKey.get(listing.id) ?? []).map(
      (child) => child.name,
    ),
    groupContext,
    isOwner: isOwnerRole(ctx.session.adminLevel),
    list: { setup, state },
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
  // LoadedListing is created only after the same listing row has been found.
  (await getListingWithActivityLogOrNull(listing.id))!.entries;
