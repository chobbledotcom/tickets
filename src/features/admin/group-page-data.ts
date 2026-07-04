/**
 * Data loaders for the group entity page's tabs — Overview, Attendees, and
 * Edit. Each gathers exactly what its own tab renders (per-tab loading), so the
 * decrypted-attendee fetch runs only for the two tabs that show roster data,
 * never for a bare Edit render. The gathering mirrors the pre-migration detail
 * and edit handlers (groups.ts) so the tabs render the same data those separate
 * pages used to.
 */

import {
  getVisibleGroupMembers,
  groupBookable,
} from "#routes/public/discovery.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { decryptAttendees } from "#shared/db/attendees.ts";
import {
  getGroupPackagePrices,
  getListingsByGroupId,
  getListingsNotInGroup,
  groupsTable,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
import { getAttendeesByListingIds } from "#shared/db/listings.ts";
import { loadAttendeeQuestionData } from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { sortListings } from "#shared/sort-listings.ts";
import {
  type Group,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  GroupAttendeesPanel,
  GroupEditPanel,
  GroupOverviewPanel,
  type PackageMemberValues,
} from "#templates/admin/groups.tsx";

/** The group entity page's loaded row is just the stored group; every tab's
 * remaining data is fetched by its own loader below, so a bare page frame never
 * decrypts a roster it isn't about to show. */
export const loadGroupForPage = (id: number): Promise<Group | null> =>
  groupsTable.findById(id);

/** Whether a group's roster has any paid attendee data to decrypt. A package
 * member can carry a `package_price` override while its own `unit_price` is 0,
 * so it's paid in practice; treat any positive override as paid (alongside the
 * usual {@link isPaidListing} checks) so the roster decrypts payment fields. */
export const groupHasPaidListing = async (
  group: Group,
  listings: ListingWithCount[],
): Promise<boolean> => {
  if (listings.some(isPaidListing)) return true;
  if (!group.is_package) return false;
  // Only a positive override charges money; a null (no override → base price,
  // already covered above) or an explicit free (0) adds no revenue. Per-day
  // overrides can make an otherwise-free customisable member paid the same way.
  const rows = await getGroupPackagePrices(group.id);
  if (rows.some((row) => (row.package_price ?? 0) > 0)) return true;
  const dayRows = await getGroupDayPrices(group.id);
  return [...dayRows.values()].some((byDay) =>
    [...byDay.values()].some((price) => price > 0),
  );
};

/** The group's sorted member listings, its decrypted attendees, the roster's
 * question data, the paid-listing flag that gated the decrypt, and the active
 * holidays used for sorting — shared by the Overview and Attendees tabs, which
 * both read the roster. */
const loadGroupRoster = async (group: Group) => {
  const [listings, holidays] = await Promise.all([
    getListingsByGroupId(group.id),
    getActiveHolidays(),
  ]);
  const sortedListings = sortListings(listings, holidays);
  const listingIds = sortedListings.map((listing) => listing.id);
  // Package-aware: an override-priced package charges via package_price even
  // when its member listings are free, so this decides whether the roster
  // decrypts payment fields AND whether the detail table shows the revenue row.
  const hasPaidListing = await groupHasPaidListing(group, sortedListings);
  const privateKey = await requireRequestPrivateKey();
  // getAttendeesByListingIds resolves to [] for an empty id list, so no guard is
  // needed — an empty group simply yields an empty roster.
  const rawAttendees = await getAttendeesByListingIds(listingIds);
  const attendees = await decryptAttendees(
    rawAttendees,
    privateKey,
    hasPaidListing,
  );
  const questionData = await loadAttendeeQuestionData(
    listingIds,
    attendees.map((attendee) => attendee.id),
    privateKey,
  );
  return {
    attendees,
    hasPaidListing,
    holidays,
    listings: sortedListings,
    questionData,
  };
};

type GroupRoster = Awaited<ReturnType<typeof loadGroupRoster>>;

/** The props both roster-reading tabs share: the display domain, the group, its
 * sorted listings, the decrypted attendees, and the optional question data.
 * Each tab spreads these and adds its own extras. */
const rosterPanelProps = (group: Group, roster: GroupRoster) => ({
  allowedDomain: getEffectiveDomain(),
  attendees: roster.attendees,
  group,
  listings: roster.listings,
  ...(roster.questionData !== undefined
    ? { questionData: roster.questionData }
    : {}),
});

/** Load the roster once, then hand it (with its group) to a panel builder — the
 * single place the Overview and Attendees tabs share their roster fetch. */
const rosterTab =
  (
    build: (
      group: Group,
      roster: GroupRoster,
    ) => JSX.Element | Promise<JSX.Element>,
  ) =>
  async (group: Group): Promise<JSX.Element> =>
    build(group, await loadGroupRoster(group));

/** Build the Overview tab: the group detail table, the member-listings table,
 * and the add-listings membership form. */
export const loadGroupOverviewPanel = rosterTab(async (group, roster) => {
  // The add-listings form offers any listing not already in THIS group —
  // membership is many-to-many, so a listing in another group can still join.
  const ungroupedListings = sortListings(
    await getListingsNotInGroup(group.id),
    roster.holidays,
  );
  // Mirror exactly when the public /ticket/<group> page renders vs 404s so the
  // admin never offers a dead share/QR/embed link: it 404s when the
  // buyer-visible member list is empty and, for a package, when the bundle
  // isn't bookable. A regular group with merely sold-out members still renders.
  const visibleMembers = await getVisibleGroupMembers(group);
  const shareable =
    visibleMembers.length > 0 &&
    (!group.is_package || (await groupBookable(group, visibleMembers)));
  return GroupOverviewPanel({
    ...rosterPanelProps(group, roster),
    hasPaidListing: roster.hasPaidListing,
    shareable,
    ungroupedListings,
  });
});

/** Build the Attendees tab: one row per booking line across the group's
 * listings. */
export const loadGroupAttendeesPanel = rosterTab((group, roster) =>
  GroupAttendeesPanel({
    ...rosterPanelProps(group, roster),
    phonePrefix: settings.phonePrefix,
  }),
);

/** Build the Edit tab: the group form with the per-listing package-price table
 * pre-filled from the group's current overrides. A null price renders blank (no
 * override); an explicit 0 renders as 0 (free in the package). */
export const loadGroupEditPanel = async (
  group: Group,
): Promise<JSX.Element> => {
  const [listings, rows, dayPrices] = await Promise.all([
    getListingsByGroupId(group.id),
    getGroupPackagePrices(group.id),
    getGroupDayPrices(group.id),
  ]);
  const members: PackageMemberValues = new Map(
    rows.map((row) => [
      row.listing_id,
      {
        dayPrices: dayPrices.get(row.listing_id) ?? new Map(),
        price: row.package_price,
        quantity: row.quantity,
      },
    ]),
  );
  return GroupEditPanel({ group, listings, members });
};
