/**
 * Data loaders for the attendee entity page — everything the
 * tabs and the create form need, factored so each tab loads only its own
 * data. The submit handlers live in attendee-form-routes.ts. The page
 * definition lives in attendee-page.ts. This module is the seam between
 * them, so neither imports the other.
 */

import { getAttendeeActivityLog } from "#db/activity-log.ts";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import {
  type ExistingLine,
  loadExistingLines,
} from "#db/attendees/atomic-update.ts";
import { getAttendeeOrderSummary } from "#db/attendees/balance.ts";
import {
  getGroupPackagePricesByGroupIds,
  groups,
  packageMemberMaps,
  readGroupMembersWith,
} from "#db/groups.ts";
import { imageUrlsFor } from "#db/images.ts";
import { getAllListings } from "#db/listings/records.ts";
import {
  getRefundPaymentReferencesForAttendee,
  type RefundPaymentReferenceSet,
} from "#db/payment-references.ts";
import type { BookedAnswer, QuestionWithAnswers } from "#db/question-types.ts";
/* jscpd:ignore-start */
import { filter, identity, mapById } from "#fp";
import {
  type AttendeeFormLine,
  attendeeBalanceNotice,
  type ParsedAttendeeForm,
  resolveSharedDates,
} from "#routes/admin/attendee-form-model.ts";
import { buildAttendeeLogisticsData } from "#routes/admin/attendee-logistics.ts";
import { withDecryptedAttendee } from "#routes/admin/attendees-route-helpers.ts";
import { computeWarnings } from "#routes/admin/booking-warnings.ts";
import { refundWorkRemains } from "#routes/admin/refunds/candidates.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form/types.ts";
import type { Attendee, ListingWithCount } from "#types";
/* jscpd:ignore-end */

/** An attendee plus its listing_attendees rows — the entity the whole page
 * loads once and every tab shares. */
export type LoadedAttendee = {
  attendee: Attendee;
  canRefund: boolean;
  existing: ExistingLine[];
  paymentReferences: RefundPaymentReferenceSet;
};

/** Load one bounded, typed payment set for both display and refund admission. */
const attendeePaymentReferences = async (
  attendee: Attendee,
): Promise<RefundPaymentReferenceSet> =>
  getRefundPaymentReferencesForAttendee(
    { currentPaymentId: attendee.payment_id, id: attendee.id },
    await requireRequestPrivateKey(),
  );

/** Whether the attendee still holds a real (quantity > 0) booking on this exact
 * listing. Read from the lines the page has already loaded: asking the database
 * again answers the same question the same way. A no-quantity line does
 * not count, so a line marked no-quantity stops offering the refund. */
const holdsRealLineOn = (
  existing: readonly ExistingLine[],
  listingId: number,
): boolean =>
  existing.some(
    ({ booking }) => booking.listing_id === listingId && booking.quantity > 0,
  );

/** Whether the page can offer a refund: automatic payment money that still has
 * work left, against a booking the attendee really holds. */
const refundIsOffered = (
  attendee: Attendee,
  paymentReferences: RefundPaymentReferenceSet,
  existing: readonly ExistingLine[],
): boolean =>
  paymentReferences.kind === "complete" &&
  paymentReferences.references.length > 0 &&
  refundWorkRemains(attendee, paymentReferences.references) &&
  holdsRealLineOn(existing, attendee.listing_id);

/** Load an attendee + all its lines, or null (→ 404) when it does not exist. */
export const loadAttendeeForEdit: (
  attendeeId: number,
) => Promise<LoadedAttendee | null> = withDecryptedAttendee(
  async (attendee) => {
    const [paymentReferences, existing] = await Promise.all([
      attendeePaymentReferences(attendee),
      loadExistingLines(attendee.id),
    ]);
    return {
      attendee,
      canRefund: refundIsOffered(attendee, paymentReferences, existing),
      existing,
      paymentReferences,
    };
  },
);

/** Listings to render rows for: every active listing, plus any inactive listing
 * the attendee already books. The existing inactive registration then still
 * shows its quantity and can be edited. Active first, then inactive-booked. */
export const getRenderListings = async (
  existing: ExistingLine[],
): Promise<ListingWithCount[]> => {
  const all = await getAllListings();
  const active = filter((l: ListingWithCount) => l.active)(all);
  const bookedIds = new Set(existing.map((e) => e.booking.listing_id));
  const inactiveBooked = filter(
    (l: ListingWithCount) => !l.active && bookedIds.has(l.id),
  )(all);
  return [...active, ...inactiveBooked];
};

/** One package path an editor line can book through. The path names the
 * package, the member listings it books, and each member's per-unit price
 * override (absent = the listing's own price). Loaded once per form render. */
export type PackagePath = {
  groupId: number;
  packageName: string;
  memberListingIds: number[];
  memberPrices: Map<number, number>;
};

/** Every (package, member) path the editor offers blank lines for, in group
 * order. Members are the package's CURRENT listings. A package with no
 * members offers nothing. */
export const loadPackagePaths = async (): Promise<PackagePath[]> => {
  const packages = (await groups.cache.getAll()).filter(
    (group) => group.is_package,
  );
  const { members: membersByGroupId, more: priceRowsByGroupId } =
    await readGroupMembersWith(
      packages,
      getGroupPackagePricesByGroupIds,
      false,
    );
  return packages.map((group) => ({
    groupId: group.id,
    // The members loader seeds every requested group id, so that lookup
    // always hits. The price loader returns only groups with membership
    // rows, so a memberless package prices from an empty row set.
    memberListingIds: membersByGroupId
      .get(group.id)!
      .map((listing) => listing.id),
    memberPrices: packageMemberMaps(priceRowsByGroupId.get(group.id) ?? [])
      .prices,
    packageName: group.name,
  }));
};

/** The packages each listing can book through, with each path's price
 * override. The parser validates a blank line's chosen path against this map
 * and prices the manual-add ledger from it. */
export const packagesByListingIdFrom = (
  paths: PackagePath[],
): Map<number, Map<number, number | null>> => {
  const byListing = new Map<number, Map<number, number | null>>();
  for (const path of paths) {
    for (const listingId of path.memberListingIds) {
      const groups =
        byListing.get(listingId) ?? new Map<number, number | null>();
      groups.set(path.groupId, path.memberPrices.get(listingId) ?? null);
      byListing.set(listingId, groups);
    }
  }
  return byListing;
};

/** An editor line for one EXISTING booking row, on that row's own path. */
const lineForExistingRow = (
  existing: ExistingLine,
  listingsById: Map<number, ListingWithCount>,
  packagePrice: number | null,
): AttendeeFormLine => ({
  error: null,
  existingBooking: existing.booking,
  key: existing.key,
  // A stored row's listing always renders: booked inactive listings are in the
  // render set, and deleting a listing deletes its rows.
  listing: listingsById.get(existing.booking.listing_id)!,
  listingId: existing.booking.listing_id,
  // A stored quantity-0 line renders with the "no quantity" box ticked.
  noQuantity: existing.booking.quantity === 0,
  packageGroupId: existing.booking.package_group_id,
  packagePrice,
  parentListingId: existing.booking.parent_listing_id,
  quantity: existing.booking.quantity,
});

/** A blank editor line: give it a quantity to book `listing` through
 * `packageGroupId` (0 = the listing's own standalone row). */
const blankLine = (
  listing: ListingWithCount,
  packageGroupId: number,
  packagePrice: number | null,
  quantity: number,
): AttendeeFormLine => ({
  error: null,
  existingBooking: null,
  key: "",
  listing,
  listingId: listing.id,
  noQuantity: false,
  packageGroupId,
  packagePrice,
  parentListingId: 0,
  quantity,
});

/** Build the editor's lines: one per EXISTING row (in stored order). Then a
 * blank standalone line for every rendered listing without a standalone row.
 * Then a blank line per unbooked (package, member) path. Every booking path a
 * public buyer can take is then one quantity box away, with the blank lines
 * tucked behind the pure-CSS toggles. */
const buildFormLines = (
  renderListings: ListingWithCount[],
  existing: ExistingLine[],
  packagePaths: PackagePath[],
  preselectedQty: Map<number, number>,
): AttendeeFormLine[] => {
  const listingsById = mapById(identity<ListingWithCount>)(renderListings);
  const pricesByListingId = packagesByListingIdFrom(packagePaths);
  const priceOfPath = (listingId: number, groupId: number): number | null =>
    groupId > 0
      ? (pricesByListingId.get(listingId)?.get(groupId) ?? null)
      : null;
  const rowLines = existing.map((row) =>
    lineForExistingRow(
      row,
      listingsById,
      priceOfPath(row.booking.listing_id, row.booking.package_group_id),
    ),
  );
  const slotTaken = new Set(
    existing.map(
      (row) => `${row.booking.listing_id}|${row.booking.package_group_id}`,
    ),
  );
  const standaloneBlanks = renderListings
    .filter((listing) => !slotTaken.has(`${listing.id}|0`))
    .map((listing) =>
      blankLine(listing, 0, null, preselectedQty.get(listing.id) ?? 0),
    );
  const packageBlanks = packagePaths.flatMap((path) =>
    path.memberListingIds
      .filter((listingId) => !slotTaken.has(`${listingId}|${path.groupId}`))
      .flatMap((listingId) => {
        const listing = listingsById.get(listingId);
        return listing
          ? [
              blankLine(
                listing,
                path.groupId,
                priceOfPath(listingId, path.groupId),
                0,
              ),
            ]
          : [];
      }),
  );
  return [...rowLines, ...standaloneBlanks, ...packageBlanks];
};

/** Build a create-mode form: a blank standalone line per active listing
 * (quantity from any pre-selection), a blank line per package path. The
 * shared start date comes from the deep link. */
export const buildCreateForm = (
  renderListings: ListingWithCount[],
  packagePaths: PackagePath[],
  preselectedQty: Map<number, number>,
  startDate: string,
): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  lines: buildFormLines(renderListings, [], packagePaths, preselectedQty),
  name: "",
  phone: "",
  returnUrl: "",
  special_instructions: "",
  startDate,
  statusId: null,
});

/** Build the edit-mode form from a loaded attendee + its bookings, seeding the
 * shared range from the existing daily bookings. */
export const buildEditFormFromAttendee = (
  attendee: Attendee,
  existing: ExistingLine[],
  renderListings: ListingWithCount[],
  packagePaths: PackagePath[],
): { parsed: ParsedAttendeeForm; hasMixedTimings: boolean } => {
  const shared = resolveSharedDates(existing.map((e) => e.booking));
  return {
    hasMixedTimings: shared.hasMixedTimings,
    parsed: {
      address: attendee.address || "",
      dayCount: shared.dayCount,
      email: attendee.email || "",
      lines: buildFormLines(renderListings, existing, packagePaths, new Map()),
      name: attendee.name,
      phone: attendee.phone || "",
      returnUrl: "",
      special_instructions: attendee.special_instructions || "",
      startDate: shared.startDate,
      statusId: attendee.status_id,
    },
  };
};

/** How many activity-log entries the full Activity tab shows. */
const ATTENDEE_LOG_LIMIT = 1000;

/** How many entries the Overview preview shows before "view all". */
const ATTENDEE_LOG_PREVIEW = 3;

/** An activity log reader: one attendee's log, capped at the limit. */
type AttendeeActivityLoader = (
  attendeeId: number,
) => ReturnType<typeof getAttendeeActivityLog>;

/** Read the attendee's activity log capped at the given entry count. */
const attendeeActivityCappedAt =
  (limit: number): AttendeeActivityLoader =>
  (attendeeId) =>
    getAttendeeActivityLog(attendeeId, limit);

/** Load the full activity log for the Activity tab. */
export const loadAttendeeActivity: AttendeeActivityLoader =
  attendeeActivityCappedAt(ATTENDEE_LOG_LIMIT);

/** Load the short Overview preview of the activity log. */
export const loadAttendeeActivityPreview: AttendeeActivityLoader =
  attendeeActivityCappedAt(ATTENDEE_LOG_PREVIEW);

interface BuildTemplateDataOpts {
  atBooking?: BookedAnswer[] | undefined;
  attendeeError?: string | null | undefined;
  dateError?: string | null | undefined;
  formError?: string | null | undefined;
  hasMixedTimings?: boolean | undefined;
  questions?: QuestionWithAnswers[] | undefined;
  returnUrl?: string | undefined;
  saveError?: string | undefined;
  selectedAnswerIds?: number[] | undefined;
  selectedTextAnswers?: Map<number, string> | undefined;
}

/** Load the package and parent names used to explain each booking path. */
const loadPathNames = async (
  lines: AttendeeFormLine[],
): Promise<
  Pick<AttendeeFormTemplateData, "packageNamesById" | "parentNamesById">
> => {
  // Path labels: package names for "via <package>" (a row tagged with a
  // since-deleted package falls back to its id in the template), parent
  // names for "add-on under <parent>".
  const parentIds = new Set(
    lines.map((line) => line.parentListingId).filter((id) => id > 0),
  );
  const [packagePaths, parentListings] = await Promise.all([
    loadPackagePaths(),
    parentIds.size === 0 ? Promise.resolve([]) : getAllListings(),
  ]);
  const packageNamesById = new Map(
    packagePaths.map((path) => [path.groupId, path.packageName]),
  );
  const parentNamesById = new Map(
    parentListings
      .filter((listing) => parentIds.has(listing.id))
      .map((listing) => [listing.id, listing.name] as const),
  );
  return { packageNamesById, parentNamesById };
};

/** Load the independent form data in parallel. */
const loadTemplateParts = async (
  parsed: ParsedAttendeeForm,
  attendee: Attendee | null,
) => {
  // The order totals come from the saved booking (edit only). Create has none.
  const summary = attendee
    ? getAttendeeOrderSummary(attendee.id)
    : Promise.resolve(null);
  const [statuses, orderSummary, warnings, logistics, pathNames] =
    await Promise.all([
      attendeeStatuses.getAll(),
      summary,
      computeWarnings(parsed, attendee?.id),
      buildAttendeeLogisticsData(parsed.lines, attendee),
      loadPathNames(parsed.lines),
    ]);
  return { logistics, orderSummary, pathNames, statuses, warnings };
};

type TemplateParts = Awaited<ReturnType<typeof loadTemplateParts>>;

interface TemplateDataInput {
  attendee: Attendee | null;
  mode: "create" | "edit";
  opts: BuildTemplateDataOpts;
  parsed: ParsedAttendeeForm;
}

/** Assemble the form view model from already-loaded data. The caller builds
 * the question texts' image-url table on top. */
const assembleTemplateData = (
  input: TemplateDataInput,
  parts: TemplateParts,
): Omit<AttendeeFormTemplateData, "imageUrls"> => {
  const { attendee, mode, opts, parsed } = input;
  const { logistics, orderSummary, pathNames, statuses, warnings } = parts;
  return {
    atBooking: opts.atBooking ?? [],
    attendee,
    attendeeError: opts.attendeeError ?? null,
    balanceNotice: attendeeBalanceNotice(
      statuses.find((status) => status.id === parsed.statusId) ?? null,
      // The balance is ledger-projected (no form field). Create mode starts at 0.
      attendee?.remaining_balance ?? 0,
      orderSummary?.fullPrice ?? 0,
      orderSummary?.depositPaid ?? 0,
    ),
    dateError: opts.dateError ?? null,
    formError: opts.formError ?? null,
    // The shared date range only affects daily listings. The form's rendered
    // lines cover every active listing plus any inactive one this attendee
    // already books. A daily line here is exactly when the dates matter.
    hasDailyListings: parsed.lines.some(
      (l) => l.listing?.listing_type === "daily",
    ),
    hasMixedTimings: opts.hasMixedTimings ?? false,
    lineWarnings: warnings.byListing,
    logistics,
    mode,
    packageNamesById: pathNames.packageNamesById,
    parentNamesById: pathNames.parentNamesById,
    parsed,
    questions: opts.questions ?? [],
    returnUrl: opts.returnUrl,
    saveError: opts.saveError,
    selectedAnswerIds: opts.selectedAnswerIds ?? [],
    selectedTextAnswers: opts.selectedTextAnswers ?? new Map(),
    statuses,
    topWarnings: warnings.top,
  };
};

/** Build the form template data: everything the editable form itself renders
 * (statuses, balance notice, warnings, logistics). It includes nothing the
 * other tabs own (log, ledger, notes, contact history). */
export const buildTemplateData = async (
  mode: "create" | "edit",
  parsed: ParsedAttendeeForm,
  attendee: Attendee | null,
  opts: BuildTemplateDataOpts = {},
): Promise<AttendeeFormTemplateData> => {
  const data = assembleTemplateData(
    { attendee, mode, opts, parsed },
    await loadTemplateParts(parsed, attendee),
  );
  return {
    ...data,
    // The question texts render as markdown, so their img#N references need
    // the id→uid-URL table. Bounded by the ids the texts reference.
    imageUrls: await imageUrlsFor(data.questions.map((q) => q.text)),
  };
};
