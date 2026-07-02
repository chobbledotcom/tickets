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

import type { PageCtx } from "#routes/admin/entity-pages.ts";
import { anyChildListing } from "#routes/public/ticket-payment.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatDateLabel } from "#shared/dates.ts";
import {
  type ActivityLogEntry,
  getListingActivityLog,
} from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees.ts";
import { getHiddenPackageMemberIds } from "#shared/db/groups.ts";
import { getChildrenForParents } from "#shared/db/listing-parents.ts";
import {
  getListingAggregateRecalculation,
  getListingWithAttendeesRaw,
  getListingWithCount,
  listingRevenueBreakdown,
} from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { loadNotesForAttendees } from "#shared/db/system-notes.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import {
  type AttendeeFilter,
  ListingEditPanel,
  ListingOverviewPanel,
  ListingRosterPanel,
} from "#templates/admin/listings.tsx";
import { getListingAndGroups } from "./listings-edit.ts";
import { loadListingParentsSection } from "./listings-parents.ts";
import { loadGroupContext, loadListingQuestionData } from "./listings-view.ts";

/**
 * The listing entity page's loaded row: the listing plus the two derived flags
 * every tab may gate on. A child listing or a hidden package's member has no
 * standalone public page, so its share / QR / booking-link affordances are
 * suppressed (invariant I3). Loading them once in {@link loadListingForPage}
 * keeps every `ActionDef.visible` predicate synchronous.
 */
export type LoadedListing = {
  listing: ListingWithCount;
  isChild: boolean;
  isHiddenPackageMember: boolean;
};

/** Load the listing and its share-suppression flags, or null when it is gone. */
export const loadListingForPage = async (
  id: number,
): Promise<LoadedListing | null> => {
  const listing = await getListingWithCount(id);
  if (!listing) return null;
  const [isChild, hiddenMemberIds] = await Promise.all([
    anyChildListing([id]),
    getHiddenPackageMemberIds([id]),
  ]);
  return { isChild, isHiddenPackageMember: hiddenMemberIds.size > 0, listing };
};

/** The roster's on-screen date + check-in filter, read from a tab's query. */
export type RosterFilter = { activeFilter: AttendeeFilter; dateFilter: string | null };

/** Read the roster tab's `?filter=` / `?date=` selection from the query. Only
 *  daily listings honour the date; a non-daily listing has no date column so
 *  its date filter is always null (matching the pre-migration behaviour). */
export const rosterFilterFromQuery = (
  listing: ListingWithCount,
  query: URLSearchParams,
): RosterFilter => {
  const requested = query.get("filter");
  const activeFilter: AttendeeFilter =
    requested === "in" || requested === "out" ? requested : "all";
  const dateFilter =
    listing.listing_type === "daily" ? query.get("date") : null;
  return { activeFilter, dateFilter };
};

/** Load and decrypt a listing's attendees. The entity page has already
 *  confirmed the listing exists, so a missing raw row yields an empty list
 *  rather than a 404 (the page frame is already committed). */
const loadDecryptedListingAttendees = async (
  listingId: number,
): Promise<Attendee[]> => {
  const pk = await requireRequestPrivateKey();
  const result = await getListingWithAttendeesRaw(listingId);
  return result ? decryptAttendees(result.attendeesRaw, pk) : [];
};

/** Attendees filtered to a single date (daily listings), else the full set. */
const filterByDate = (attendees: Attendee[], date: string | null): Attendee[] =>
  date ? attendees.filter((a) => a.date === date) : attendees;

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

/** Build the Overview tab: the read-only details table, the income breakdown,
 *  and the attendee-notes summary. */
export const loadListingOverviewPanel = async ({
  listing,
  isChild,
  isHiddenPackageMember,
}: LoadedListing): Promise<JSX.Element> => {
  const attendees = await loadDecryptedListingAttendees(listing.id);
  const [recalc, revenueBreakdown, groupContext, systemNotes] =
    await Promise.all([
      getListingAggregateRecalculation(listing),
      listingRevenueBreakdown(listing.id),
      // The Overview tab shows whole-listing totals (no date picker), so the
      // group cap is the all-dates figure.
      loadGroupContext(listing, null),
      loadNotesForAttendees(
        attendees.map((a) => a.id),
        requireRequestPrivateKey,
      ),
    ]);
  return ListingOverviewPanel({
    aggregateRecalculation: recalc,
    allowedDomain: getEffectiveDomain(),
    attendees,
    groupContext,
    isChild,
    isHiddenPackageMember,
    listing,
    revenueBreakdown,
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
  const attendees = await loadDecryptedListingAttendees(listing.id);
  const filteredByDate = filterByDate(attendees, dateFilter);
  const [questionData, childrenByParent] = await Promise.all([
    loadListingQuestionData(
      listing.id,
      filteredByDate.map((a) => a.id),
    ),
    getChildrenForParents([listing.id]),
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
    listing,
    phonePrefix: settings.phonePrefix,
    questionData,
  });
};

/** Load the listing's activity log (Activity tab + Overview preview). */
export const loadListingActivity = ({
  listing,
}: LoadedListing): Promise<ActivityLogEntry[]> =>
  getListingActivityLog(listing.id);

/**
 * Build the Edit tab: the multipart edit form and its side panels. Reloads via
 * getListingAndGroups so the form reads the listing's *stored* values (not the
 * defaults-resolved view the page frame loaded), matching the pre-migration
 * edit page. `error` is set only on a rejected-save in-place re-render.
 */
export const loadListingEditPanel = async (
  { listing }: LoadedListing,
  ctx: PageCtx,
  error?: string,
  selectedGroupIds?: number[],
): Promise<JSX.Element | null> => {
  const ctxData = await getListingAndGroups(listing.id);
  if (!ctxData) return null;
  const parents = await loadListingParentsSection(ctxData.listing);
  return ListingEditPanel({
    aggregateRecalculation: ctxData.aggregateRecalculation,
    error,
    groups: ctxData.groups,
    listing: ctxData.listing,
    parents,
    // On a rejected save re-render the checkboxes the operator submitted, not
    // the stored set, so their group changes aren't silently dropped.
    selectedGroupIds: selectedGroupIds ?? ctxData.selectedGroupIds,
    session: ctx.session,
  });
};
