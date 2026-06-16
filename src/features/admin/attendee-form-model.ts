/**
 * Shared form model for the unified add/edit attendee page.
 *
 * Both `/admin/attendees/new` (create) and `/admin/attendees/:id` (edit)
 * render the same field shape, parse the same line-item editor, and run the
 * same validation rules. The only difference is that edit mode hydrates the
 * form from existing attendee + listing_attendees rows.
 *
 * The form is a plain HTTP form. Repeatable line items are indexed by
 * position (line_event_id_N, line_quantity_N, line_date_N, line_key_N) and
 * the server re-renders on add-line / remove-line actions so the operator
 * never needs JavaScript to use the page.
 */

import { filter, map, pipe } from "#fp";
import { t } from "#i18n";
import { formatCurrency, toMinorUnits } from "#shared/currency.ts";
import {
  addDays,
  getAvailableDates,
  isBookingRangeValid,
} from "#shared/dates.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type {
  DesiredListingLine,
  ListingAttendeeRow,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import { bookingSlotKey } from "#shared/db/attendees/booking-slot.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MAX_FORM_LINES } from "#shared/limits.ts";
import {
  dayPriceFor,
  type Holiday,
  type ListingWithCount,
  normalizeDurationDays,
} from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  validateAddress,
  validateEmail,
  validatePhone,
  validateSpecialInstructions,
} from "#templates/fields.ts";

// ---------------------------------------------------------------------------
// Field-name constants — single source of truth for template + parser
// ---------------------------------------------------------------------------

export const LINE_EVENT_ID_PREFIX = "line_event_id_";
export const LINE_QUANTITY_PREFIX = "line_quantity_";
export const LINE_DATE_PREFIX = "line_date_";
export const LINE_DAY_COUNT_PREFIX = "line_day_count_";
export const LINE_KEY_PREFIX = "line_key_";
export const LINE_COUNT_FIELD = "line_count";
export const STATUS_FIELD = "status_id";
export const REMAINING_BALANCE_FIELD = "remaining_balance";

export const ACTION_FIELD = "action";
export const SAVE_ACTION = "save";
export const ADD_LINE_ACTION = "add_line";
export const REMOVE_LINE_ACTION_PREFIX = "remove_line_";

/** DOM id of the add/edit form, also used as the post-save scroll anchor
 * (`#attendee-form`) so the operator lands on the form after a save. */
export const ATTENDEE_FORM_ID = "attendee-form";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A single line in the editor — one listing registration. */
export type AttendeeFormLine = {
  /** Stable key from the existing listing_attendees row (`${listingId}|${startAt}`).
   * Empty string for newly-added lines. */
  key: string;
  /** Parsed listing id; 0 means the line is blank (no listing chosen). */
  listingId: number;
  /** Parsed quantity; null when the field was blank/non-numeric. */
  quantity: number | null;
  /** Raw date string (YYYY-MM-DD) — only meaningful for daily listings. */
  date: string;
  /** Chosen day count for customisable daily listings; null when not submitted
   * (then the existing booking's span, or 1, is used). */
  dayCount: number | null;
  /** Resolved listing reference (null when listingId is unknown or blank). */
  listing: ListingWithCount | null;
  /** Existing booking row, when editing an existing line. */
  existingBooking: ListingAttendeeRow | null;
  /** Line-level validation error (set by validateParsedForm). */
  error: string | null;
};

/** The full parsed form — attendee contact fields plus all line items. */
export type ParsedAttendeeForm = {
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  /** Selected attendee status id, or null for "no status". */
  statusId: number | null;
  /** Outstanding balance in minor units (order-level, plaintext). */
  remainingBalance: number;
  lines: AttendeeFormLine[];
  action: FormAction;
  returnUrl: string;
};

/** What the operator asked the server to do with the submission. */
export type FormAction =
  | { kind: "save" }
  | { kind: "add_line" }
  | { kind: "remove_line"; index: number };

/** Attendee-level validation error. */
export type AttendeeFieldError = {
  field: "name" | "email" | "phone" | "address" | "special_instructions";
  message: string;
};

/** Result of validating a parsed form. */
export type ValidationResult =
  | { valid: true; values: ParsedAttendeeForm }
  | {
      valid: false;
      attendeeError: AttendeeFieldError | null;
      lineErrors: Map<number, string>;
      values: ParsedAttendeeForm;
    };

/** Resolved daily-line timings used to drive defaults + mixed alert. */
export type DailyDefaults = {
  /** True when existing daily lines disagree on start date or duration. */
  hasMixedTimings: boolean;
  /** Shared start date to pre-fill new daily lines with (when uniform). */
  inheritedDate: string | null;
  /** Shared duration (days) observed across existing daily lines. */
  inheritedDurationDays: number | null;
};

// ---------------------------------------------------------------------------
// Keys + helpers
// ---------------------------------------------------------------------------

/** True when the line has no listing selected and no existing identity. */
export const isBlankLine = (line: AttendeeFormLine): boolean =>
  line.listingId <= 0 && !line.key;

/** True when the line should become a booking: non-blank and resolved to a
 * real listing. The shared predicate for both mutation adapters. */
const isFillableLine = (line: AttendeeFormLine): boolean =>
  !isBlankLine(line) && line.listing !== null;

/**
 * Drop the trailing blank line the template always renders so save
 * validation doesn't fail on an operator who left the placeholder row empty.
 * Keep intentionally-blank middle rows so the line indices line up with what
 * the operator saw — only the trailing blank is trimmed.
 */
export const trimTrailingBlankLines = (
  lines: AttendeeFormLine[],
): AttendeeFormLine[] => {
  const result = [...lines];
  while (result.length > 1 && isBlankLine(result[result.length - 1]!)) {
    result.pop();
  }
  return result;
};

// ---------------------------------------------------------------------------
// Action parsing
// ---------------------------------------------------------------------------

const parseAction = (form: FormParams): FormAction => {
  const raw = form.getString(ACTION_FIELD);
  if (raw === ADD_LINE_ACTION) return { kind: "add_line" };
  if (raw.startsWith(REMOVE_LINE_ACTION_PREFIX)) {
    const idx = Number.parseInt(
      raw.slice(REMOVE_LINE_ACTION_PREFIX.length),
      10,
    );
    if (Number.isInteger(idx) && idx >= 0)
      return { index: idx, kind: "remove_line" };
  }
  // Default and any unrecognized value (including "save") → save.
  return { kind: "save" };
};

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

/**
 * Read the attendee contact fields and every line item from the form.
 *
 * Lines are read positionally: for each N in [0, line_count), read the
 * matching `line_*_N` fields. `listingsById` resolves listing references; an
 * unknown listing id is recorded as an unresolved line (validation will flag
 * it). `existingByKey` (edit mode) attaches the original booking row to
 * lines that already existed.
 */
/** Parse a listing-id field into the numeric id and resolved listing (if any). */
const resolveListing = (
  raw: string,
  listingsById: Map<number, ListingWithCount>,
): { id: number; listing: ListingWithCount | null } => {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) return { id: 0, listing: null };
  return { id, listing: listingsById.get(id) ?? null };
};

/** Parse a single line of the editor from the indexed form fields. */
const parseAttendeeLine = (
  form: FormParams,
  i: number,
  listingsById: Map<number, ListingWithCount>,
  existingByKey: Map<string, ListingAttendeeRow>,
): AttendeeFormLine => {
  const { id, listing } = resolveListing(
    form.getString(`${LINE_EVENT_ID_PREFIX}${i}`),
    listingsById,
  );
  const key = form.getString(`${LINE_KEY_PREFIX}${i}`);
  return {
    date: form.getString(`${LINE_DATE_PREFIX}${i}`),
    dayCount: form.getOptionalInt(`${LINE_DAY_COUNT_PREFIX}${i}`),
    error: null,
    existingBooking: key ? (existingByKey.get(key) ?? null) : null,
    key,
    listing,
    listingId: id,
    quantity: form.getOptionalInt(`${LINE_QUANTITY_PREFIX}${i}`),
  };
};

export const parseAttendeeForm = (
  form: FormParams,
  listingsById: Map<number, ListingWithCount>,
  existingByKey: Map<string, ListingAttendeeRow> = new Map(),
): ParsedAttendeeForm => {
  const lineCountRaw = form.getOptionalInt(LINE_COUNT_FIELD);
  const lineCount =
    lineCountRaw !== null && lineCountRaw > 0
      ? Math.min(lineCountRaw, MAX_FORM_LINES)
      : 1;

  const indices = Array.from({ length: lineCount }, (_, i) => i);
  const lines = map((i: number) =>
    parseAttendeeLine(form, i, listingsById, existingByKey),
  )(indices);

  const statusIdRaw = form.getOptionalInt(STATUS_FIELD);
  return {
    action: parseAction(form),
    address: form.getString("address"),
    email: form.getString("email"),
    lines,
    name: form.getString("name"),
    phone: form.getString("phone"),
    remainingBalance: parseMoneyMinor(form.getString(REMAINING_BALANCE_FIELD)),
    returnUrl: form.getString("return_url"),
    special_instructions: form.getString("special_instructions"),
    statusId: statusIdRaw !== null && statusIdRaw > 0 ? statusIdRaw : null,
  };
};

/** Parse a money field (major units) to clamped minor units; blank/invalid → 0. */
const parseMoneyMinor = (raw: string): number => {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? toMinorUnits(parsed) : 0;
};

/**
 * Resolve the status an attendee resolves to: their submitted choice, or the
 * public default (the status new bookings start in) when none was given. The
 * form offers no "no status" choice, so a missing/blank value — only reachable
 * from a hand-crafted POST — is coerced back to the default rather than
 * clearing it. Shared by the template (to pre-select) and the save path (to
 * persist) so both agree. A public default always exists once any status does.
 */
export const resolveStatusId = (
  statusId: number | null,
  statuses: AttendeeStatus[],
): number => statusId ?? statuses.find((s) => s.is_public_default)!.id;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the attendee block + each line independently.
 *
 * Per-line errors are attached both to the returned `lineErrors` map and
 * onto the line objects in `values.lines` so the template can read them
 * directly. A single failing line still preserves the rest of the form.
 */
export const validateParsedForm = (
  parsed: ParsedAttendeeForm,
  holidays: Holiday[],
): ValidationResult => {
  const attendeeError = validateAttendeeBlock(parsed);
  const seenLineKeys = new Set<string>();
  const lineErrors = new Map<number, string>();

  for (let i = 0; i < parsed.lines.length; i++) {
    const line = parsed.lines[i]!;
    const error = validateLine(line, holidays, seenLineKeys);
    if (error) {
      line.error = error;
      lineErrors.set(i, error);
    } else {
      line.error = null;
    }
  }

  if (attendeeError || lineErrors.size > 0) {
    return { attendeeError, lineErrors, valid: false, values: parsed };
  }
  return { valid: true, values: parsed };
};

const validateAttendeeBlock = (
  parsed: ParsedAttendeeForm,
): AttendeeFieldError | null => {
  if (!parsed.name.trim()) {
    return { field: "name", message: t("error.name_required") };
  }
  // Email and phone are optional on this form, but a provided value must be
  // well-formed. The browser enforces this via type=email / pattern, so only a
  // no-JS or hand-crafted POST reaches the server with a malformed value —
  // validating here keeps bad contact data out of the encrypted PII blob.
  // Reuse the same validators the public ticket form uses so both paths agree.
  if (parsed.email) {
    const emailError = validateEmail(parsed.email);
    if (emailError) return { field: "email", message: emailError };
  }
  if (parsed.phone) {
    const phoneError = validatePhone(parsed.phone);
    if (phoneError) return { field: "phone", message: phoneError };
  }
  // Length caps backstop the HTML maxlength and keep these fields within the
  // size the payment-metadata path elsewhere relies on.
  const addressError = validateAddress(parsed.address);
  if (addressError) return { field: "address", message: addressError };
  const instructionsError = validateSpecialInstructions(
    parsed.special_instructions,
  );
  if (instructionsError) {
    return { field: "special_instructions", message: instructionsError };
  }
  return null;
};

/**
 * Validate a single line.
 *
 * Returns the first error encountered (in priority order) or null if the
 * line passes. Blank lines (no listing selected, no existing key) are allowed
 * — `trimTrailingBlankLines` cleans them up before validation, and any that
 * survive are treated as no-ops so the operator can submit a partially
 * filled form without losing data.
 */
/** Validate the date/day-count of a daily line. For customisable listings the
 * date list is computed for a single day (every individually-bookable start)
 * and the chosen span is checked separately; otherwise the listing's fixed
 * duration is used. */
const validateDailyLine = (
  line: AttendeeFormLine,
  listing: ListingWithCount,
  holidays: Holiday[],
): string | null => {
  if (listing.customisable_days) {
    const days = lineDayCount(line);
    if (dayPriceFor(listing, days) === null) {
      return `This listing doesn't offer a ${days}-day booking`;
    }
    if (!isBookingRangeValid(listing, line.date, days, holidays)) {
      return "Those dates aren't all available — choose fewer days or another start date";
    }
    return null;
  }
  const allowed = new Set(getAvailableDates(listing, holidays));
  return allowed.has(line.date)
    ? null
    : "Date is not bookable for this listing";
};

const validateLine = (
  line: AttendeeFormLine,
  holidays: Holiday[],
  seenLineKeys: Set<string>,
): string | null => {
  if (isBlankLine(line)) return null;

  if (!line.listing) {
    return "Listing no longer exists or is inactive";
  }
  if (!line.listing.active) {
    return `Listing '${line.listing.name}' is inactive`;
  }

  const qty = line.quantity;
  if (qty === null || !Number.isInteger(qty) || qty < 1) {
    return "Quantity must be at least 1";
  }
  if (qty > line.listing.max_quantity) {
    return `Quantity must be at most ${line.listing.max_quantity}`;
  }

  const isDaily = line.listing.listing_type === "daily";
  if (isDaily) {
    if (!line.date) return "Date is required for daily listings";
    if (!isIsoDate(line.date)) {
      return "Date must be a valid YYYY-MM-DD value";
    }
    const lineError = validateDailyLine(line, line.listing, holidays);
    if (lineError) return lineError;
  }

  // Duplicate-line check: same listing + same date would collide on the
  // (listing_id, attendee_id, start_at) unique index. Reuse the same slot
  // identity the DB layer dedupes on (bookingSlotKey) so both agree.
  const dedupeKey = bookingSlotKey(line.listingId, isDaily ? line.date : null);
  if (seenLineKeys.has(dedupeKey)) {
    return "Duplicate listing line — same listing and date already added";
  }
  seenLineKeys.add(dedupeKey);
  return null;
};

// ---------------------------------------------------------------------------
// Daily defaults + mixed-timing detection
// ---------------------------------------------------------------------------

/** Compute the duration (in days) implied by a listing_attendees row range. */
export const bookingDurationDays = (
  booking: ListingAttendeeRow,
): number | null => {
  if (!booking.start_at || !booking.end_at) return null;
  const startMs = new Date(booking.start_at).getTime();
  const endMs = new Date(booking.end_at).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const days = Math.round((endMs - startMs) / 86_400_000);
  return days >= 1 ? days : null;
};

/**
 * Inspect the attendee's existing daily lines to drive defaults for newly
 * added lines and the mixed-timing alert.
 *
 * - When all existing daily lines share the same start date AND duration,
 *   new daily lines inherit that start date. `inheritedDurationDays` is
 *   surfaced for display ("matches existing N-day booking").
 * - When existing daily lines disagree, `hasMixedTimings` becomes true so
 *   the template can render the non-blocking alert.
 * - When there are no existing daily lines, `inheritedDate` is null and the
 *   template falls back to tomorrow + the listing's duration.
 */
export const resolveDailyDefaults = (
  lines: AttendeeFormLine[],
): DailyDefaults => {
  const dailyBookings = pipe(
    filter(
      (line: AttendeeFormLine) =>
        Boolean(line.existingBooking) &&
        line.listing?.listing_type === "daily" &&
        line.existingBooking!.start_at !== null,
    ),
    map((line: AttendeeFormLine) => ({
      duration: bookingDurationDays(line.existingBooking!) ?? 1,
      startDate: line.existingBooking!.start_at!.slice(0, 10),
    })),
  )(lines);

  if (dailyBookings.length === 0) {
    return {
      hasMixedTimings: false,
      inheritedDate: null,
      inheritedDurationDays: null,
    };
  }

  const first = dailyBookings[0]!;
  const allSame = dailyBookings.every(
    (b) => b.startDate === first.startDate && b.duration === first.duration,
  );
  if (allSame) {
    return {
      hasMixedTimings: false,
      inheritedDate: first.startDate,
      inheritedDurationDays: first.duration,
    };
  }
  return {
    hasMixedTimings: true,
    inheritedDate: null,
    inheritedDurationDays: null,
  };
};

/** Tomorrow's date in YYYY-MM-DD form (UTC day). Used for the create-mode
 * daily-line default when nothing is inherited. */
export const defaultNewDailyDate = (todayIso: string): string =>
  addDays(todayIso.slice(0, 10), 1);

// ---------------------------------------------------------------------------
// Mutation adapters — convert parsed form into the DB-layer input shapes
// ---------------------------------------------------------------------------

/**
 * Convert a parsed, validated form into the multi-listing AttendeeInput used
 * by `createAttendeeAtomic`. Non-daily lines pass `date: null`.
 */
/** Whole-day span of an existing booking from its stored [start_at, end_at). */
const existingSpanDays = (row: ListingAttendeeRow | null): number | null => {
  if (!row?.start_at || !row?.end_at) return null;
  const ms = new Date(row.end_at).getTime() - new Date(row.start_at).getTime();
  const days = Math.round(ms / 86_400_000);
  return days > 0 ? days : null;
};

/** Effective day count for a customisable line: the chosen value, else the
 * existing booking's span (so an unrelated edit preserves it), else 1. */
export const lineDayCount = (line: AttendeeFormLine): number =>
  normalizeDurationDays(
    line.dayCount ?? existingSpanDays(line.existingBooking) ?? 1,
  );

/** Booking duration (days) for a daily line — the chosen span for customisable
 * listings, the listing's fixed duration otherwise. */
const lineDurationDays = (line: AttendeeFormLine): number =>
  line.listing!.customisable_days
    ? lineDayCount(line)
    : line.listing!.duration_days;

export const toCreateInput = (
  parsed: ParsedAttendeeForm,
): {
  address: string;
  bookings: ListingBooking[];
  email: string;
  name: string;
  phone: string;
  remainingBalance: number;
  special_instructions: string;
  statusId: number | null;
} => {
  const bookings: ListingBooking[] = pipe(
    filter(isFillableLine),
    map(
      (line: AttendeeFormLine): ListingBooking => ({
        date: line.listing!.listing_type === "daily" ? line.date : null,
        durationDays:
          line.listing!.listing_type === "daily"
            ? lineDurationDays(line)
            : undefined,
        listingId: line.listingId,
        quantity: line.quantity!,
      }),
    ),
  )(parsed.lines);

  return {
    address: parsed.address,
    bookings,
    email: parsed.email,
    name: parsed.name,
    phone: parsed.phone,
    remainingBalance: parsed.remainingBalance,
    special_instructions: parsed.special_instructions,
    statusId: parsed.statusId,
  };
};

/**
 * Compute the desired final-state line set for the atomic update path.
 * Daily listings resolve `date`/`durationDays`; non-daily listings null them.
 * Duplicate (listingId, date) lines are not de-duplicated here — validation
 * already rejects them with a visible error, and the DB layer rejects any
 * that slip past a direct caller; silently dropping a line would hide intent.
 */
export const toDesiredLines = (
  parsed: ParsedAttendeeForm,
): DesiredListingLine[] =>
  pipe(
    filter(isFillableLine),
    map((line: AttendeeFormLine): DesiredListingLine => {
      const isDaily = line.listing!.listing_type === "daily";
      return {
        date: isDaily ? line.date : null,
        durationDays: isDaily ? lineDurationDays(line) : 1,
        exists: Boolean(line.key) && Boolean(line.existingBooking),
        key: line.key,
        listingId: line.listingId,
        quantity: line.quantity!,
      };
    }),
  )(parsed.lines);

/** A status/balance mismatch surfaced on the attendee form. */
export type BalanceNotice = { tone: "warning" | "info"; message: string };

/**
 * Flag a mismatch between an attendee's status and their balance, or null when
 * the two agree. Three situations warrant a notice:
 *   - a paid status that still owes money (a contradiction → warning);
 *   - a reservation with no recorded balance while part of the order is still
 *     unpaid (the balance looks lost → warning);
 *   - a reservation that's fully paid yet still sitting in a reservation status
 *     (a softer nudge to move it on → info).
 *
 * A reservation that still owes a balance is the normal mid-reservation state,
 * and a balance on any other status is treated as deliberate — both stay quiet.
 */
export const attendeeBalanceNotice = (
  status: { is_paid_default: boolean; is_reservation: boolean } | null,
  remainingBalance: number,
  fullPrice: number,
  amountPaid: number,
): BalanceNotice | null => {
  if (!status) return null;
  if (status.is_paid_default) {
    return remainingBalance > 0
      ? {
          message: `This attendee is in a paid status but still owes ${formatCurrency(remainingBalance)}.`,
          tone: "warning",
        }
      : null;
  }
  if (status.is_reservation && remainingBalance <= 0) {
    const owed = fullPrice - amountPaid;
    if (owed > 0) {
      return {
        message: `This reservation has no balance recorded, but ${formatCurrency(owed)} of the order is still unpaid.`,
        tone: "warning",
      };
    }
    if (fullPrice > 0) {
      return {
        message:
          "This reservation is fully paid — consider moving it to a paid status.",
        tone: "info",
      };
    }
  }
  return null;
};
