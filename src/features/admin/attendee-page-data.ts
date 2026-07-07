/**
 * Data loaders for the attendee entity page — everything the
 * tabs and the create form need, factored so each tab loads only its own
 * data. The submit handlers live in attendee-form-routes.ts; the page
 * definition lives in attendee-page.ts. This module is the seam between
 * them, so neither imports the other.
 */

/* jscpd:ignore-start */
import { compact, filter, unique } from "#fp";
import { t } from "#i18n";
import {
  type AttendeeFormLine,
  attendeeBalanceNotice,
  isBookedLine,
  type ParsedAttendeeForm,
  resolveSharedDates,
} from "#routes/admin/attendee-form-model.ts";
import { buildAttendeeLogisticsData } from "#routes/admin/attendee-logistics.ts";
import { withDecryptedAttendee } from "#routes/admin/attendees-route-helpers.ts";
import { getAttendeeActivityLog } from "#shared/db/activityLog.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { getAttendeeOrderSummary } from "#shared/db/attendees/balance.ts";
import {
  checkLinesCapacity,
  type ExistingLine,
  getAttendeesByTokens,
  loadExistingLines,
} from "#shared/db/attendees.ts";
import {
  getBookingTokens,
  getContactRecord,
  getRepairFallbackRecord,
  hashEmail,
  hashPhone,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import {
  getGroupPackagePricesByGroupIds,
  getListingsByGroupIds,
  groups,
  packageMemberMaps,
} from "#shared/db/groups.ts";
import { getChildrenForParents } from "#shared/db/listing-parents.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  getAttendeeTextAnswers,
  loadAttendeeQuestionData,
  type QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form.tsx";
import type {
  ContactChannelData,
  ContactRecordsByChannel,
  PreviousBooking,
} from "#templates/admin/attendee-page.tsx";
/* jscpd:ignore-end */

/** An attendee plus its listing_attendees rows — the entity the whole page
 * loads once and every tab shares. */
export type LoadedAttendee = { attendee: Attendee; existing: ExistingLine[] };

/** Load an attendee + all its lines, or null (→ 404) when it doesn't exist. */
export const loadAttendeeForEdit: (
  attendeeId: number,
) => Promise<LoadedAttendee | null> = withDecryptedAttendee(
  async (attendee) => ({
    attendee,
    existing: await loadExistingLines(attendee.id),
  }),
);

/** Index listings by id. */
export const listingsByIdMap = (
  listings: ListingWithCount[],
): Map<number, ListingWithCount> => new Map(listings.map((l) => [l.id, l]));

/** Listings to render rows for: every active listing, plus any inactive listing
 * the attendee already books (so an existing inactive registration still shows
 * its quantity and can be edited). Active first, then inactive-booked. */
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

/** One package path an editor line can book through: the package, the member
 * listings it would book, and each member's per-unit price override (absent =
 * no override — the listing's own price). Loaded once per form render. */
export type PackagePath = {
  groupId: number;
  packageName: string;
  memberListingIds: number[];
  memberPrices: Map<number, number>;
};

/** Every (package, member) path the editor offers blank lines for, in group
 * order. Members are the package's CURRENT listings; a package with no
 * members offers nothing. */
export const loadPackagePaths = async (): Promise<PackagePath[]> => {
  const packages = (await groups.cache.getAll()).filter(
    (group) => group.is_package,
  );
  const packageIds = packages.map((group) => group.id);
  const [membersByGroupId, priceRowsByGroupId] = await Promise.all([
    getListingsByGroupIds(packageIds),
    getGroupPackagePricesByGroupIds(packageIds),
  ]);
  return packages.map((group) => ({
    groupId: group.id,
    // The members loader seeds every requested group id, so that lookup
    // always hits; the price loader returns only groups with membership
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
 * override — the map the parser validates a blank line's chosen path against
 * and prices the manual-add ledger from. */
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

/** Build the editor's lines: one per EXISTING row (in stored order), then a
 * blank standalone line for every rendered listing without a standalone row,
 * then a blank line per unbooked (package, member) path — so every booking
 * path a public buyer could take is one quantity box away, with the blank
 * lines tucked behind the pure-CSS toggles. */
const buildFormLines = (
  renderListings: ListingWithCount[],
  existing: ExistingLine[],
  packagePaths: PackagePath[],
  preselectedQty: Map<number, number>,
): AttendeeFormLine[] => {
  const listingsById = listingsByIdMap(renderListings);
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
 * (quantity from any pre-selection), a blank line per package path, and the
 * shared start date from the deep link. */
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
export const ATTENDEE_LOG_LIMIT = 1000;

/** How many entries the Overview preview shows before "view all". */
export const ATTENDEE_LOG_PREVIEW = 3;

/** Load the full activity log for the Activity tab. */
export const loadAttendeeActivity = (
  attendeeId: number,
): ReturnType<typeof getAttendeeActivityLog> =>
  getAttendeeActivityLog(attendeeId, ATTENDEE_LOG_LIMIT);

/** Load the short Overview preview of the activity log. */
export const loadAttendeeActivityPreview = (
  attendeeId: number,
): ReturnType<typeof getAttendeeActivityLog> =>
  getAttendeeActivityLog(attendeeId, ATTENDEE_LOG_PREVIEW);

/** A booked daily listing booked for longer than its own duration allows —
 * permitted (every daily listing shares one range), so a warning not an error. */
const overDurationWarning = (
  line: AttendeeFormLine,
  dayCount: number,
): string | null => {
  const listing = line.listing!;
  if (listing.listing_type !== "daily" || dayCount <= listing.duration_days) {
    return null;
  }
  return t("attendee_form.warn_over_duration", {
    count: dayCount,
    max: listing.duration_days,
    title: listing.name,
  });
};

/** The capacity-check booking shape for one listing's TOTAL booked quantity
 * on the shared range (daily) or no date (standard). A listing booked through
 * two paths demands the SUM of its lines, so the overbook warning judges the
 * whole demand, not each path alone. */
const listingBookingFor = (
  line: AttendeeFormLine,
  quantity: number,
  parsed: ParsedAttendeeForm,
) => {
  const isDaily = line.listing!.listing_type === "daily";
  return {
    date: isDaily ? parsed.startDate : null,
    durationDays: isDaily ? parsed.dayCount : 1,
    listingId: line.listingId,
    quantity,
  };
};

/** The set of booked listing ids that overbook capacity, judged with one
 * batched self-excluding check (the same one the save uses) over each
 * listing's summed lines. A daily listing with no valid shared date is
 * skipped — the date error already blocks saving. */
const overbookedListingIds = async (
  booked: AttendeeFormLine[],
  parsed: ParsedAttendeeForm,
  excludeAttendeeId: number | undefined,
): Promise<Set<number>> => {
  const checkable = booked.filter(
    (line) =>
      line.listing!.listing_type !== "daily" || isIsoDate(parsed.startDate),
  );
  const firstLineByListing = new Map<number, AttendeeFormLine>();
  const totalByListing = new Map<number, number>();
  for (const line of checkable) {
    if (!firstLineByListing.has(line.listingId)) {
      firstLineByListing.set(line.listingId, line);
    }
    totalByListing.set(
      line.listingId,
      (totalByListing.get(line.listingId) ?? 0) + line.quantity!,
    );
  }
  const perListing = [...firstLineByListing.values()];
  const fits = await checkLinesCapacity(
    perListing.map((line) =>
      listingBookingFor(line, totalByListing.get(line.listingId)!, parsed),
    ),
    excludeAttendeeId,
  );
  const overbooked = new Set<number>();
  for (const [i, line] of perListing.entries()) {
    if (!fits[i]) overbooked.add(line.listingId);
  }
  return overbooked;
};

/**
 * Incomplete-parent warnings, keyed by parent listing id: a booked line that is
 * a parent (has required-child edges) whose required child is NOT also booked on
 * this attendee. The manual add/edit form books plain lines and never folds a
 * child the way the public booking flow enforces, so an operator who books a
 * parent alone — or opens an attendee already in that state — would otherwise
 * have a booking the gate considers incomplete. The message names the children
 * to add so it is obvious and easily fixed (usability #6). Reuses the
 * relationship accessor; no-op (no query) when no booked line is a parent.
 */
const incompleteParentWarnings = async (
  booked: AttendeeFormLine[],
): Promise<Map<number, string>> => {
  const bookedIds = new Set(booked.map((line) => line.listingId));
  const childrenByParent = await getChildrenForParents([...bookedIds]);
  const warnings = new Map<number, string>();
  for (const line of booked) {
    // getChildrenForParents only returns listings that ARE parents (≥1 child).
    const children = childrenByParent.get(line.listingId);
    if (!children || children.some((child) => bookedIds.has(child.id)))
      continue;
    warnings.set(
      line.listingId,
      t("attendee_form.warn_incomplete_parent", {
        children: children.map((child) => child.name).join(", "),
        title: line.listing!.name,
      }),
    );
  }
  return warnings;
};

/** Overbooking message for one listing's summed booked lines. */
const overbookMessage = (line: AttendeeFormLine, quantity: number): string =>
  t("attendee_form.warn_overbooked", {
    quantity,
    title: line.listing!.name,
  });

/**
 * Over-duration + overbooking + incomplete-parent warnings for every booked
 * line, keyed by listing id plus a flat list for the top-of-form summary. All
 * are allowed for admin saves, so they surface as warnings, not errors. The
 * capacity side is one batched query for the whole form, not one per line.
 */
const computeWarnings = async (
  parsed: ParsedAttendeeForm,
  excludeAttendeeId: number | undefined,
): Promise<{ byListing: Map<number, string[]>; top: string[] }> => {
  const booked = parsed.lines.filter(isBookedLine);
  const [overbooked, incompleteParents] = await Promise.all([
    overbookedListingIds(booked, parsed, excludeAttendeeId),
    incompleteParentWarnings(booked),
  ]);
  const byListing = new Map<number, string[]>();
  const top: string[] = [];
  // One warning set per LISTING (its lines share capacity and the date
  // range), attached to its first booked line and shown on each of its rows.
  const seenListings = new Set<number>();
  for (const line of booked) {
    if (seenListings.has(line.listingId)) continue;
    seenListings.add(line.listingId);
    const total = booked
      .filter((other) => other.listingId === line.listingId)
      .reduce((sum, other) => sum + other.quantity!, 0);
    const warns = compact([
      overDurationWarning(line, parsed.dayCount),
      overbooked.has(line.listingId) ? overbookMessage(line, total) : null,
      incompleteParents.get(line.listingId) ?? null,
    ]);
    if (warns.length > 0) {
      byListing.set(line.listingId, warns);
      top.push(...warns);
    }
  }
  return { byListing, top };
};

/** Build the form template data: everything the editable form itself renders
 * (statuses, balance notice, warnings, logistics), and nothing the other tabs
 * own (log, ledger, notes, contact history). */
export const buildTemplateData = async (
  mode: "create" | "edit",
  parsed: ParsedAttendeeForm,
  attendee: Attendee | null,
  opts: {
    attendeeError?: string | null | undefined;
    dateError?: string | null | undefined;
    formError?: string | null | undefined;
    saveError?: string | undefined;
    hasMixedTimings?: boolean | undefined;
    returnUrl?: string | undefined;
    questions?: QuestionWithAnswers[] | undefined;
    selectedAnswerIds?: number[] | undefined;
    selectedTextAnswers?: Map<number, string> | undefined;
  } = {},
): Promise<AttendeeFormTemplateData> => {
  const statuses = await attendeeStatuses.getAll();
  // The order totals come from the saved booking (edit only); create has none.
  const summary = attendee ? await getAttendeeOrderSummary(attendee.id) : null;
  const balanceNotice = attendeeBalanceNotice(
    statuses.find((s) => s.id === parsed.statusId) ?? null,
    // The balance is ledger-projected (no form field) — read it from the saved
    // attendee; create mode has no attendee yet, so it starts at 0.
    attendee?.remaining_balance ?? 0,
    summary?.fullPrice ?? 0,
    summary?.depositPaid ?? 0,
    summary?.listedFullPrice ?? 0,
  );
  const warnings = await computeWarnings(parsed, attendee?.id);
  const logistics = await buildAttendeeLogisticsData(parsed.lines, attendee);
  // Path labels: package names for "via <package>" (a row tagged with a
  // since-deleted package falls back to its id in the template), parent
  // names for "add-on under <parent>".
  const packageNamesById = new Map(
    (await loadPackagePaths()).map((path) => [path.groupId, path.packageName]),
  );
  const parentIds = new Set(
    parsed.lines.map((line) => line.parentListingId).filter((id) => id > 0),
  );
  const parentNamesById = new Map(
    parentIds.size === 0
      ? []
      : (await getAllListings())
          .filter((listing) => parentIds.has(listing.id))
          .map((listing) => [listing.id, listing.name] as const),
  );
  return {
    attendee,
    attendeeError: opts.attendeeError ?? null,
    balanceNotice,
    dateError: opts.dateError ?? null,
    formError: opts.formError ?? null,
    // The shared date range only affects daily listings; the form's rendered
    // lines cover every active listing plus any inactive one this attendee
    // already books, so a daily line here is exactly when the dates matter.
    hasDailyListings: parsed.lines.some(
      (l) => l.listing?.listing_type === "daily",
    ),
    hasMixedTimings: opts.hasMixedTimings ?? false,
    lineWarnings: warnings.byListing,
    logistics,
    mode,
    packageNamesById,
    parentNamesById,
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

/** Load custom questions + currently-selected answers across ALL of the
 * attendee's booked listings. The request's private key is only derived when
 * there are questions whose free-text answers need decrypting, so an attendee
 * with no questions never forces a key unwrap. */
export const loadQuestionsForExisting = async (
  attendeeId: number,
  existing: ExistingLine[],
): Promise<{
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
  selectedTextAnswers: Map<number, string>;
}> => {
  const listingIds = unique(existing.map((e) => e.booking.listing_id));
  const data = await loadAttendeeQuestionData(listingIds, [attendeeId]);
  if (!data) {
    return {
      questions: [],
      selectedAnswerIds: [],
      selectedTextAnswers: new Map(),
    };
  }
  return {
    questions: data.questions,
    selectedAnswerIds: data.attendeeAnswerMap.get(attendeeId) ?? [],
    selectedTextAnswers: await getAttendeeTextAnswers(
      attendeeId,
      await requireRequestPrivateKey(),
    ),
  };
};

/** No contact history on file for either channel. */
export const EMPTY_CONTACT_RECORDS: ContactRecordsByChannel = {
  email: null,
  phone: null,
};

/** Load and decrypt one channel's contact record (null when no value on file).
 * Notes are owner-encrypted, so this needs the session private key. */
const loadChannelRecord = async (
  value: string,
  hashOf: (value: string) => Promise<string>,
  privateKey: CryptoKey,
): Promise<ContactChannelData | null> => {
  if (!value.trim()) return null;
  const hash = await hashOf(value);
  try {
    return {
      hashParam: toContactHashParam(hash),
      record: await getContactRecord(hash, privateKey),
    };
  } catch (error) {
    // A corrupt/undecryptable stats_blob for one contact must not take down
    // the whole attendee page. Surface it for repair and keep the channel
    // with its surviving counts and (crucially) its /admin/history link, so the
    // operator can still open the editor and overwrite the bad row — dropping
    // the channel here would hide the only path to fix it.
    logError({
      code: ErrorCode.DECRYPT_FAILED,
      detail: `contact history ${toContactHashParam(hash)}: ${error}`,
    });
    return {
      hashParam: toContactHashParam(hash),
      record: await getRepairFallbackRecord(hash),
    };
  }
};

/** Read the attendee's per-channel contact history for the read-only panel.
 * The private key is only needed (and only requested) when there is at least
 * one contact value to decrypt, so an attendee with no email/phone never forces
 * a key prompt. */
export const loadContactRecords = async (
  attendee: Attendee,
): Promise<ContactRecordsByChannel> => {
  if (!attendee.email.trim() && !attendee.phone.trim()) {
    return EMPTY_CONTACT_RECORDS;
  }
  const pk = await requireRequestPrivateKey();
  return {
    email: await loadChannelRecord(attendee.email, hashEmail, pk),
    phone: await loadChannelRecord(attendee.phone, hashPhone, pk),
  };
};

/** The contact hashes to gather previous bookings from — one per channel the
 * attendee has a value for. */
const contactHashesFor = async (attendee: Attendee): Promise<string[]> =>
  Promise.all(
    compact([
      attendee.email.trim() ? hashEmail(attendee.email) : null,
      attendee.phone.trim() ? hashPhone(attendee.phone) : null,
    ]),
  );

/** Build one Previous bookings row from a resolved attendee: its date, status,
 * booked items and total order value. */
const previousBookingRow = async (
  booked: { id: number; created: string; status_id: number | null },
  statusNameById: Map<number, string>,
): Promise<PreviousBooking> => {
  const summary = await getAttendeeOrderSummary(booked.id);
  return {
    attendeeId: booked.id,
    created: booked.created,
    items: summary.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
    })),
    // A null status_id (no status) and a since-deleted status both resolve to
    // no name; -1 never matches a real status id, so one lookup covers both.
    statusName: statusNameById.get(booked.status_id ?? -1) ?? null,
    totalValue: summary.fullPrice,
  };
};

/** Cap on the Previous bookings table: each row costs its own order-summary
 * reads, so a repeat contact with a long history can't turn one attendee page
 * into an unbounded number of edge subrequests. Newest first, so the cap keeps
 * the most recent bookings. */
const PREVIOUS_BOOKINGS_LIMIT = 20;

/** Load the other bookings this contact (email and/or phone) has made, resolved
 * from its encrypted ticket-token list — newest first, this attendee's own
 * booking excluded, capped at {@link PREVIOUS_BOOKINGS_LIMIT}. Empty when no
 * contact value is on file, no linked tokens remain, or every linked attendee
 * has since been deleted. */
export const loadPreviousBookings = async (
  attendee: Attendee,
): Promise<PreviousBooking[]> => {
  const hashes = await contactHashesFor(attendee);
  if (hashes.length === 0) return [];
  const privateKey = await requireRequestPrivateKey();
  const tokenLists = await Promise.all(
    hashes.map((hash) => getBookingTokens(hash, privateKey)),
  );
  // One row per distinct booked token across both channels, minus this
  // attendee's own token — the panel lists the contact's OTHER bookings.
  const tokens = unique(tokenLists.flat().map((entry) => entry.token)).filter(
    (token) => token !== attendee.ticket_token,
  );
  if (tokens.length === 0) return [];
  // Sort the resolved attendees newest first (created sorts lexically), then
  // cap BEFORE the per-row summaries so the number of summary reads is bounded.
  const recent = compact(await getAttendeesByTokens(tokens))
    .sort((left, right) => right.created.localeCompare(left.created))
    .slice(0, PREVIOUS_BOOKINGS_LIMIT);
  const statusNameById = new Map(
    (await attendeeStatuses.getAll()).map((status) => [status.id, status.name]),
  );
  const rows = await Promise.all(
    recent.map((booked) => previousBookingRow(booked, statusNameById)),
  );
  // Drop a booking that has since been edited down to no real lines — it no
  // longer represents a booked ticket, so it neither counts nor renders.
  return rows.filter((row) => row.items.length > 0);
};
