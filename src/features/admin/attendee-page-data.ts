/**
 * Data loaders for the attendee entity page (edit-pages.md) — everything the
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
import { getAllAttendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { getAttendeeOrderSummary } from "#shared/db/attendees/balance.ts";
import {
  checkLinesCapacity,
  type ExistingLine,
  loadExistingLines,
} from "#shared/db/attendees.ts";
import {
  getContactRecord,
  getRepairFallbackRecord,
  hashEmail,
  hashPhone,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
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

/** First (earliest) existing booking per listing. A legacy attendee with two
 * bookings of the same listing binds the row to the earliest; the rest fall out
 * of the desired set on save, normalising onto the one shared range. */
const firstExistingByListingId = (
  existing: ExistingLine[],
): Map<number, ExistingLine> => {
  const map = new Map<number, ExistingLine>();
  for (const e of existing) {
    if (!map.has(e.booking.listing_id)) map.set(e.booking.listing_id, e);
  }
  return map;
};

/** Build one editor line per rendered listing: the existing booking's quantity
 * and key when present, otherwise the pre-selected quantity (0 = not booked). */
const buildFormLines = (
  renderListings: ListingWithCount[],
  existingByListingId: Map<number, ExistingLine>,
  preselectedQty: Map<number, number>,
): AttendeeFormLine[] =>
  renderListings.map((listing) => {
    const existing = existingByListingId.get(listing.id);
    const quantity = existing
      ? existing.booking.quantity
      : (preselectedQty.get(listing.id) ?? 0);
    return {
      error: null,
      existingBooking: existing?.booking ?? null,
      key: existing?.key ?? "",
      listing,
      listingId: listing.id,
      // A stored quantity-0 line renders with the "no quantity" box ticked.
      noQuantity: Boolean(existing) && quantity === 0,
      quantity,
    };
  });

/** Build a create-mode form: a line per active listing (quantity from any
 * pre-selection) and the shared start date from the deep link. */
export const buildCreateForm = (
  renderListings: ListingWithCount[],
  preselectedQty: Map<number, number>,
  startDate: string,
): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  lines: buildFormLines(renderListings, new Map(), preselectedQty),
  name: "",
  phone: "",
  remainingBalance: 0,
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
): { parsed: ParsedAttendeeForm; hasMixedTimings: boolean } => {
  const shared = resolveSharedDates(existing.map((e) => e.booking));
  return {
    hasMixedTimings: shared.hasMixedTimings,
    parsed: {
      address: attendee.address || "",
      dayCount: shared.dayCount,
      email: attendee.email || "",
      lines: buildFormLines(
        renderListings,
        firstExistingByListingId(existing),
        new Map(),
      ),
      name: attendee.name,
      phone: attendee.phone || "",
      remainingBalance: attendee.remaining_balance,
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

/** The capacity-check booking shape for a booked line on the shared range
 * (daily) or no date (standard). */
const lineBookingFor = (line: AttendeeFormLine, parsed: ParsedAttendeeForm) => {
  const isDaily = line.listing!.listing_type === "daily";
  return {
    date: isDaily ? parsed.startDate : null,
    durationDays: isDaily ? parsed.dayCount : 1,
    listingId: line.listingId,
    quantity: line.quantity!,
  };
};

/** The set of booked listing ids that overbook capacity, judged with one
 * batched self-excluding check (the same one the save uses). A daily line with
 * no valid shared date is skipped — the date error already blocks saving. */
const overbookedListingIds = async (
  booked: AttendeeFormLine[],
  parsed: ParsedAttendeeForm,
  excludeAttendeeId: number | undefined,
): Promise<Set<number>> => {
  const checkable = booked.filter(
    (line) =>
      line.listing!.listing_type !== "daily" || isIsoDate(parsed.startDate),
  );
  const fits = await checkLinesCapacity(
    checkable.map((line) => lineBookingFor(line, parsed)),
    excludeAttendeeId,
  );
  const overbooked = new Set<number>();
  checkable.forEach((line, i) => {
    if (!fits[i]) overbooked.add(line.listingId);
  });
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

/** Overbooking message for a booked line. */
const overbookMessage = (line: AttendeeFormLine): string =>
  t("attendee_form.warn_overbooked", {
    quantity: line.quantity,
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
  for (const line of booked) {
    const warns = compact([
      overDurationWarning(line, parsed.dayCount),
      overbooked.has(line.listingId) ? overbookMessage(line) : null,
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
  const statuses = await getAllAttendeeStatuses();
  // The order totals come from the saved booking (edit only); create has none.
  const summary = attendee ? await getAttendeeOrderSummary(attendee.id) : null;
  const balanceNotice = attendeeBalanceNotice(
    statuses.find((s) => s.id === parsed.statusId) ?? null,
    parsed.remainingBalance,
    summary?.fullPrice ?? 0,
    summary?.depositPaid ?? 0,
    summary?.listedFullPrice ?? 0,
  );
  const warnings = await computeWarnings(parsed, attendee?.id);
  const logistics = await buildAttendeeLogisticsData(parsed.lines, attendee);
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
