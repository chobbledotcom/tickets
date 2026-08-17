/**
 * Data loaders for the attendee entity page — everything the
 * tabs and the create form need, factored so each tab loads only its own
 * data. The submit handlers live in attendee-form-routes.ts; the page
 * definition lives in attendee-page.ts. This module is the seam between
 * them, so neither imports the other.
 */

/* jscpd:ignore-start */
import { compact, filter, identity, mapById, unique } from "#fp";
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
import { refundWorkRemains } from "#routes/admin/refunds/candidates.ts";
import { getAttendeeActivityLog } from "#shared/db/activity-log.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import {
  type ExistingLine,
  loadExistingLines,
} from "#shared/db/attendees/atomic-update.ts";
import { getAttendeeOrderSummary } from "#shared/db/attendees/balance.ts";
import { checkLinesCapacity } from "#shared/db/attendees/capacity/checks.ts";
import { hasActiveBookingLine } from "#shared/db/attendees/queries.ts";
import {
  getContactRecordOrRepair,
  hashEmail,
  hashPhone,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import {
  getGroupPackagePricesByGroupIds,
  groups,
  packageMemberMaps,
  readGroupMembersWith,
} from "#shared/db/groups.ts";
import {
  hydrateListingLinks,
  listingChildren,
} from "#shared/db/listing-parents.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import {
  getRefundPaymentReferencesForAttendee,
  type RefundPaymentReferenceSet,
} from "#shared/db/payment-references.ts";
import type {
  QuestionWithAnswers,
  SelectedQuestionAnswers,
} from "#shared/db/question-types.ts";
import {
  getAttendeeTextAnswers,
  loadAttendeeQuestionData,
} from "#shared/db/questions/attendee-answers/reads.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form/types.ts";
import type {
  ContactChannelData,
  ContactRecordsByChannel,
} from "#templates/admin/attendee-page.tsx";
/* jscpd:ignore-end */

/** An attendee plus its listing_attendees rows — the entity the whole page
 * loads once and every tab shares. */
export type LoadedAttendee = {
  attendee: Attendee;
  canRefund: boolean;
  existing: ExistingLine[];
  paymentReferences: RefundPaymentReferenceSet;
};

type AttendeePaymentFacts = Pick<
  LoadedAttendee,
  "canRefund" | "paymentReferences"
>;

/** Load one bounded, typed payment set for both display and refund admission. */
const attendeePaymentFacts = async (
  attendee: Attendee,
): Promise<AttendeePaymentFacts> => {
  const paymentReferences = await getRefundPaymentReferencesForAttendee(
    { currentPaymentId: attendee.payment_id, id: attendee.id },
    await requireRequestPrivateKey(),
  );
  const hasAutomaticPayment =
    paymentReferences.kind === "complete" &&
    paymentReferences.references.length > 0;
  return {
    canRefund:
      hasAutomaticPayment &&
      refundWorkRemains(attendee, paymentReferences.references) &&
      (await hasActiveBookingLine(attendee.id, attendee.listing_id)),
    paymentReferences,
  };
};

/** Load an attendee + all its lines, or null (→ 404) when it doesn't exist. */
export const loadAttendeeForEdit: (
  attendeeId: number,
) => Promise<LoadedAttendee | null> = withDecryptedAttendee(
  async (attendee) => {
    const [payment, existing] = await Promise.all([
      attendeePaymentFacts(attendee),
      loadExistingLines(attendee.id),
    ]);
    return { attendee, existing, ...payment };
  },
);

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
  const { members: membersByGroupId, more: priceRowsByGroupId } =
    await readGroupMembersWith(
      packages,
      getGroupPackagePricesByGroupIds,
      false,
    );
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
const ATTENDEE_LOG_LIMIT = 1000;

/** How many entries the Overview preview shows before "view all". */
const ATTENDEE_LOG_PREVIEW = 3;

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
  const { listingsByKey: childrenByParent } = await hydrateListingLinks(
    listingChildren,
    [...bookedIds],
  );
  const warnings = new Map<number, string>();
  for (const line of booked) {
    // Hydration only returns listings that ARE parents (at least one child).
    const children = childrenByParent.get(line.listingId);
    if (!children || children.some((child) => bookedIds.has(child.id))) {
      continue;
    }
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

interface BuildTemplateDataOpts {
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
  // The order totals come from the saved booking (edit only); create has none.
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

/** Assemble the form view model from already-loaded data. */
const assembleTemplateData = (
  input: TemplateDataInput,
  parts: TemplateParts,
): AttendeeFormTemplateData => {
  const { attendee, mode, opts, parsed } = input;
  const { logistics, orderSummary, pathNames, statuses, warnings } = parts;
  return {
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
 * (statuses, balance notice, warnings, logistics), and nothing the other tabs
 * own (log, ledger, notes, contact history). */
export const buildTemplateData = async (
  mode: "create" | "edit",
  parsed: ParsedAttendeeForm,
  attendee: Attendee | null,
  opts: BuildTemplateDataOpts = {},
): Promise<AttendeeFormTemplateData> =>
  assembleTemplateData(
    { attendee, mode, opts, parsed },
    await loadTemplateParts(parsed, attendee),
  );

/** Load custom questions + currently-selected answers across ALL of the
 * attendee's booked listings. The request's private key is only derived when
 * there are questions whose free-text answers need decrypting, so an attendee
 * with no questions never forces a key unwrap. */
/** The empty question/answer set: no questions and nothing picked. A fresh
 * object each call, so callers can safely hold their own copy. */
export const emptySelectedQuestionAnswers = (): SelectedQuestionAnswers => ({
  questions: [],
  selectedAnswerIds: [],
  selectedTextAnswers: new Map(),
});

export const loadQuestionsForExisting = async (
  attendeeId: number,
  existing: ExistingLine[],
): Promise<SelectedQuestionAnswers> => {
  const listingIds = unique(existing.map((e) => e.booking.listing_id));
  const data = await loadAttendeeQuestionData(listingIds, [attendeeId]);
  if (!data) {
    return emptySelectedQuestionAnswers();
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
 * Notes are owner-encrypted, so this needs the session private key. A corrupt/
 * undecryptable stats_blob for one contact must not take down the whole
 * attendee page: `getContactRecordOrRepair` surfaces it for repair and keeps
 * the channel with its surviving counts and (crucially) its /admin/history
 * link, so the operator can still open the editor and overwrite the bad row —
 * dropping the channel here would hide the only path to fix it. */
const loadChannelRecordOrRepair = getContactRecordOrRepair("contact history");
const loadChannelRecord = async (
  value: string,
  hashOf: (value: string) => Promise<string>,
  privateKey: CryptoKey,
): Promise<ContactChannelData | null> => {
  if (!value.trim()) return null;
  const hash = await hashOf(value);
  return {
    hashParam: toContactHashParam(hash),
    record: await loadChannelRecordOrRepair(hash, privateKey),
  };
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
