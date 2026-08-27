import { getListingWithCount, listingsTable } from "#db/listings/records.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import {
  resolveTestGroupIds,
  type TestListingOverrides,
  testListingInput,
} from "#test-utils/factories.ts";
import type { Listing, ListingWithCount } from "#types";
import {
  buildCreateListingForm,
  buildUpdateListingForm,
} from "./listing-forms.ts";
import {
  doAuthenticatedFormRequest,
  doAuthenticatedMultipartFormRequest,
} from "./request.ts";

const allDays: string[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * A listing with one booking, then its stored running totals pushed off that
 * truth. The starting point for any test about drift: the booking makes the
 * recounted totals 1 and 1, and `stored` is what the listing wrongly claims.
 */
export const createListingWithDriftedTotals = async (
  stored: { booked_quantity: number; tickets_count: number } = {
    booked_quantity: 9,
    tickets_count: 5,
  },
): Promise<Listing> => {
  const listing = await createTestListing({ maxAttendees: 100 });
  // Imported here rather than at the top, because the attendee helpers import
  // this module.
  const { createTestAttendee } = await import("./attendees.ts");
  await createTestAttendee(
    listing.id,
    listing.slug,
    "Counted Person",
    "counted@example.com",
  );
  const { listingAggregates } = await import("#db/listings/aggregates.ts");
  await listingAggregates.update(listing.id, stored);
  return listing;
};

/** A minute-precision ISO timestamp one minute in the past — always already
 * closed. The reference `closesAt` value for "registration closed" tests. */
export const pastCloseTime = (): string =>
  new Date(Date.now() - 60000).toISOString().slice(0, 16);

/** A minute-precision ISO timestamp an hour in the future — always still
 * open, so a test can fetch a CSRF token before closing the listing out from
 * under it. */
export const futureCloseTime = (): string =>
  new Date(Date.now() + 3600000).toISOString().slice(0, 16);

/** Write a test listing's group membership directly (the form helper is
 * single-value, so membership is set via setListingGroups rather than the
 * group_ids checkboxes). No-op for an empty list. */
const applyTestListingGroups = async (
  listingId: number,
  groupIds: number[],
): Promise<void> => {
  if (groupIds.length === 0) return;
  const { setListingGroups } = await import("#db/groups.ts");
  await setListingGroups(listingId, groupIds);
};

export const createTestListing = async (
  overrides: TestListingOverrides = {},
): Promise<ListingWithCount> => {
  const input = testListingInput(overrides);
  const listing = await doAuthenticatedMultipartFormRequest(
    "/admin/listing",
    buildCreateListingForm(input),
    async () => {
      const { getAllListings } = await import("#db/listings/records.ts");
      const listings = await getAllListings();
      return listings[0] as ListingWithCount;
    },
    "create listing",
  );
  await applyTestListingGroups(listing.id, resolveTestGroupIds(overrides));
  return listing;
};

/**
 * Duplicate a listing the way the admin duplicate form does: POST a valid create
 * body to `/admin/listing` carrying the hidden `duplicated_from` field, then
 * return the newly created copy. Mirrors the real flow (the create handler reads
 * `duplicated_from` to copy the source parent's child edges).
 */
export const duplicateTestListing = async (
  sourceId: number,
  overrides: TestListingOverrides = {},
): Promise<ListingWithCount> => {
  const input = testListingInput(overrides);
  const listing = await doAuthenticatedMultipartFormRequest(
    "/admin/listing",
    { ...buildCreateListingForm(input), duplicated_from: String(sourceId) },
    async () => {
      const { getAllListings } = await import("#db/listings/records.ts");
      const listings = await getAllListings();
      return listings[0] as ListingWithCount;
    },
    "duplicate listing",
  );
  await applyTestListingGroups(listing.id, resolveTestGroupIds(overrides));
  return listing;
};

export const updateTestListing = async (
  listingId: number,
  updates: Partial<Omit<ListingInput, "groupIds">> & {
    groupId?: number;
    groupIds?: number[];
  },
): Promise<Listing> => {
  const existing = await getListingWithCount(listingId);
  if (!existing) {
    throw new Error(`Listing not found: ${listingId}`);
  }
  const { listingGroups, setListingGroups } = await import("#db/groups.ts");
  // The real edit form carries membership as pre-checked group_ids checkboxes;
  // the form helper omits them. Resolve the intended set (requested change, else
  // current membership) and submit its first id so the handler preserves
  // membership during the request (e.g. its group-cap overflow check sees the
  // group). Re-apply the full set afterwards for multi-group cases.
  const previousGroups = await listingGroups.getIds(listingId);
  const groupIds =
    updates.groupId !== undefined || updates.groupIds !== undefined
      ? resolveTestGroupIds(updates)
      : previousGroups;
  const form = buildUpdateListingForm(updates, existing);
  const formWithGroups =
    groupIds.length > 0 ? { ...form, group_ids: String(groupIds[0]) } : form;
  const result = await doAuthenticatedMultipartFormRequest(
    `/admin/listing/${listingId}/edit`,
    formWithGroups,
    async () => (await getListingWithCount(listingId)) as ListingWithCount,
    "update listing",
  );
  await setListingGroups(listingId, groupIds);
  return result;
};

const changeListingStatus =
  (action: "deactivate" | "reactivate") =>
  async (listingId: number): Promise<void> => {
    const listing = await getListingWithCount(listingId);
    if (!listing) {
      throw new Error(`Listing not found: ${listingId}`);
    }
    return doAuthenticatedFormRequest(
      `/admin/listing/${listingId}/${action}`,
      { confirm_identifier: listing.name },
      async () => {},
      `${action} listing`,
    );
  };

export const deactivateTestListing = changeListingStatus("deactivate");
export const reactivateTestListing = changeListingStatus("reactivate");

export const createDailyTestListing = (overrides: TestListingOverrides = {}) =>
  createTestListing({
    bookableDays: allDays,
    listingType: "daily",
    maxAttendees: 10,
    maximumDaysAfter: 60,
    minimumDaysBefore: 0,
    ...overrides,
  });

/** The bookable start dates for a listing, with holidays already loaded and the
 *  listing row already fetched with its counts — the fix to the repeated
 *  three-import + two-call dance that surfaced across the parents-,
 *  parents-e2e, and listing-qr-admin suites. Returns sorted YYYY-MM-DD
 *  strings (see {@link getBookableStartDates}). */
export const bookableStartDates = async (
  listingId: number,
): Promise<string[]> => {
  const { getBookableStartDates } = await import("#shared/dates.ts");
  const { getActiveHolidays } = await import("#db/holidays.ts");
  return getBookableStartDates(
    (await getListingWithCount(listingId))!,
    await getActiveHolidays(),
  );
};

/** The name of every listing now in the database. What a backup or restore test
 * checks to see which listings survived. */
export const storedListingNames = async (): Promise<string[]> =>
  (await listingsTable.read.pick(["id", "name"]).many()).map(
    ({ name }) => name,
  );
