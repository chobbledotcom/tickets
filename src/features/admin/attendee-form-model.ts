/**
 * Shared form model for the unified add/edit attendee page.
 *
 * Both `/admin/attendees/new` (create) and `/admin/attendees/:id` (edit) render
 * the same fields and run the same validation. An attendee has ONE shared date
 * range — a `start_date` plus a day count — that applies to every daily listing
 * they book; standard (fixed-date) listings ignore it. The listing editor is a
 * fixed table with one row per bookable listing (plus any inactive listing the
 * attendee already booked), each carrying a quantity box: quantity ≥ 1 books the
 * listing, 0 leaves it out. There are no add/remove-line buttons, so the form
 * needs no server round-trips to edit the line set.
 */

import { mapNotNullish } from "#fp";
import { t } from "#i18n";
import { formatCurrency, toMinorUnits } from "#shared/currency.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type {
  DesiredListingLine,
  ListingAttendeeRow,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import type { FormParams } from "#shared/form-data.ts";
import { START_DATE_FIELD } from "#shared/order-select.ts";
import { type ListingWithCount, normalizeDurationDays } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  parseNonNegativeInt,
  parsePositiveIntId,
} from "#shared/validation/number.ts";
import {
  validateAddress,
  validateEmail,
  validatePhone,
  validateSpecialInstructions,
} from "#templates/fields.ts";

// ---------------------------------------------------------------------------
// Field-name constants — single source of truth for template + parser
// ---------------------------------------------------------------------------

/** Shared day count (range length) for every daily listing. */
export const DAY_COUNT_FIELD = "day_count";
/** Per-listing quantity field: `qty_<listingId>`. */
export const QTY_PREFIX = "qty_";
/** Per-listing hidden field carrying the existing booking's line key, so an
 * edit can move/keep the right `listing_attendees` row: `line_key_<listingId>`. */
export const LINE_KEY_PREFIX = "line_key_";
/** Checkbox that reveals the not-booked listing rows when at least one line is
 * already booked (pure-CSS, never parsed; omitted on a bare create form, which
 * shows every listing). */
export const SHOW_ALL_FIELD = "show_all";
export const STATUS_FIELD = "status_id";
export const REMAINING_BALANCE_FIELD = "remaining_balance";

/** DOM id of the add/edit form, also the post-save scroll anchor. */
export const ATTENDEE_FORM_ID = "attendee-form";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** One row of the listing editor — a bookable listing and its quantity. */
export type AttendeeFormLine = {
  /** Listing id this row books. */
  listingId: number;
  /** Booked quantity; null/0 means the listing is not booked. */
  quantity: number | null;
  /** Resolved listing reference (null when the id is unknown). */
  listing: ListingWithCount | null;
  /** Existing booking row, when the attendee already books this listing. */
  existingBooking: ListingAttendeeRow | null;
  /** Stable key of the existing row (`${listingId}|${startAt}`); empty when new. */
  key: string;
  /** Line-level validation error (set by validateParsedForm). */
  error: string | null;
};

/**
 * A read-only summary of one listing the attendee currently books, shown in the
 * bookings table at the top of the edit page. Derived from a stored
 * `listing_attendees` row joined to its listing, so it reflects exactly what is
 * saved: quantity, dates (daily listings), and check-in / refund status.
 */
export type AttendeeBooking = {
  listingId: number;
  listingName: string;
  listingActive: boolean;
  quantity: number;
  startAt: string | null;
  endAt: string | null;
  checkedIn: boolean;
  refunded: boolean;
  /** The parent listing this booking was chosen under as an add-on (a folded
   * child), or 0 when it is an ordinary standalone booking. */
  parentListingId: number;
};

/** The full parsed form — attendee fields, the shared range, and line items. */
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
  /** Shared start date (YYYY-MM-DD) for every daily listing; "" when unset. */
  startDate: string;
  /** Shared range length in days (≥ 1) for every daily listing. */
  dayCount: number;
  lines: AttendeeFormLine[];
  returnUrl: string;
};

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
      dateError: string | null;
      lineErrors: Map<number, string>;
      values: ParsedAttendeeForm;
    };

/** The shared date range implied by an attendee's existing daily bookings. */
type SharedDates = {
  /** Shared start date (YYYY-MM-DD), or "" when there are no daily bookings. */
  startDate: string;
  /** Shared day count (≥ 1). */
  dayCount: number;
  /** True when the existing daily bookings disagree on start date or duration —
   * saving will normalise them all onto the one chosen range. */
  hasMixedTimings: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the line should become a booking. */
export const isBookedLine = (line: AttendeeFormLine): boolean =>
  line.quantity !== null && line.quantity >= 1 && line.listing !== null;

/** Whole-day span of a stored booking row, or null when it has no range. */
export const bookingDurationDays = (
  booking: ListingAttendeeRow,
): number | null => {
  if (!booking.start_at || !booking.end_at) return null;
  const ms =
    new Date(booking.end_at).getTime() - new Date(booking.start_at).getTime();
  const days = Math.round(ms / 86_400_000);
  return days >= 1 ? days : null;
};

/**
 * Project the form's listing lines into read-only booking summaries: one per
 * line that carries a saved booking (the attendee's current registrations),
 * dropping not-yet-booked rows. A booked line always resolves its listing; the
 * `listing` guard only keeps a hand-crafted POST — one pairing a saved booking
 * key with an unknown listing id — from throwing by dropping that bogus line.
 */
export const attendeeBookingsFromLines = (
  lines: AttendeeFormLine[],
): AttendeeBooking[] =>
  mapNotNullish((line: AttendeeFormLine): AttendeeBooking | null => {
    const { existingBooking: booking, listing } = line;
    if (!booking || !listing) return null;
    return {
      checkedIn: Boolean(booking.checked_in),
      endAt: booking.end_at,
      listingActive: listing.active,
      listingId: line.listingId,
      listingName: listing.name,
      parentListingId: booking.parent_listing_id,
      quantity: booking.quantity,
      refunded: Boolean(booking.refunded),
      startAt: booking.start_at,
    };
  })(lines);

/** Clamp a submitted day count to the valid range; blank defaults to 1. */
const clampDayCount = (raw: number | null): number =>
  normalizeDurationDays(raw ?? 1);

/** Parse a money field (major units) to clamped minor units; blank/invalid → 0. */
const parseMoneyMinor = (raw: string): number => {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? toMinorUnits(parsed) : 0;
};

/**
 * The status an attendee resolves to: their submitted choice, or the public
 * default (the status new bookings start in) when none was given. The form
 * offers no "no status" choice, so a missing value — only reachable from a
 * hand-crafted POST — is coerced back to the default rather than clearing it.
 */
export const resolveStatusId = (
  statusId: number | null,
  statuses: AttendeeStatus[],
): number => statusId ?? statuses.find((s) => s.is_public_default)!.id;

/**
 * Derive the shared date range from an attendee's existing bookings. Only dated
 * (daily) rows count. When they agree, that range is returned; when they
 * disagree it seeds from the earliest start and longest duration and flags mixed
 * timings so the operator is warned before saving normalises them.
 */
export const resolveSharedDates = (
  bookings: ListingAttendeeRow[],
): SharedDates => {
  const dated = bookings
    .filter((b) => b.start_at && b.end_at)
    .map((b) => ({
      duration: bookingDurationDays(b) ?? 1,
      startDate: b.start_at!.slice(0, 10),
    }));
  if (dated.length === 0) {
    return { dayCount: 1, hasMixedTimings: false, startDate: "" };
  }
  const first = dated[0]!;
  const allSame = dated.every(
    (d) => d.startDate === first.startDate && d.duration === first.duration,
  );
  if (allSame) {
    return {
      dayCount: first.duration,
      hasMixedTimings: false,
      startDate: first.startDate,
    };
  }
  return {
    dayCount: Math.max(...dated.map((d) => d.duration)),
    hasMixedTimings: true,
    startDate: [...dated.map((d) => d.startDate)].sort()[0]!,
  };
};

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

/** Parse one quantity field value: blank/invalid → null, else the integer. */
const parseQuantity = (raw: string): number | null => {
  return parseNonNegativeInt(raw);
};

/** One editor line per `qty_<id>` field in the form, in document order and
 * de-duplicated, with the listing + existing booking resolved. */
const parseLines = (
  form: FormParams,
  resolve: (
    id: number,
    key: string,
  ) => Pick<AttendeeFormLine, "listing" | "existingBooking">,
): AttendeeFormLine[] => {
  const lines: AttendeeFormLine[] = [];
  const seen = new Set<number>();
  for (const [field, raw] of form.entries()) {
    if (!field.startsWith(QTY_PREFIX)) continue;
    const id = parsePositiveIntId(field.slice(QTY_PREFIX.length));
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const key = form.getString(`${LINE_KEY_PREFIX}${id}`);
    lines.push({
      error: null,
      key,
      listingId: id,
      quantity: parseQuantity(raw),
      ...resolve(id, key),
    });
  }
  return lines;
};

export const parseAttendeeForm = (
  form: FormParams,
  listingsById: Map<number, ListingWithCount>,
  existingByKey: Map<string, ListingAttendeeRow> = new Map(),
): ParsedAttendeeForm => {
  const statusIdRaw = form.getOptionalInt(STATUS_FIELD);
  return {
    address: form.getString("address"),
    dayCount: clampDayCount(form.getOptionalInt(DAY_COUNT_FIELD)),
    email: form.getString("email"),
    lines: parseLines(form, (id, key) => ({
      existingBooking: key ? (existingByKey.get(key) ?? null) : null,
      listing: listingsById.get(id) ?? null,
    })),
    name: form.getString("name"),
    phone: form.getString("phone"),
    remainingBalance: parseMoneyMinor(form.getString(REMAINING_BALANCE_FIELD)),
    returnUrl: form.getString("return_url"),
    special_instructions: form.getString("special_instructions"),
    startDate: form.getString(START_DATE_FIELD),
    statusId: statusIdRaw !== null && statusIdRaw > 0 ? statusIdRaw : null,
  };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const validateAttendeeBlock = (
  parsed: ParsedAttendeeForm,
): AttendeeFieldError | null => {
  if (!parsed.name.trim()) {
    return { field: "name", message: t("error.name_required") };
  }
  if (parsed.email) {
    const emailError = validateEmail(parsed.email);
    if (emailError) return { field: "email", message: emailError };
  }
  if (parsed.phone) {
    const phoneError = validatePhone(parsed.phone);
    if (phoneError) return { field: "phone", message: phoneError };
  }
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

/** True when a booked line targets a daily listing (needs the shared date). */
const isBookedDaily = (line: AttendeeFormLine): boolean =>
  isBookedLine(line) && line.listing!.listing_type === "daily";

/** Validate one booked line's quantity. Date/duration/overbooking concerns are
 * surfaced as non-blocking warnings elsewhere, not as errors. */
const validateLine = (line: AttendeeFormLine): string | null => {
  // isBookedLine already guarantees an integer quantity ≥ 1; the only quantity
  // error left is exceeding the listing's per-booking maximum.
  if (!isBookedLine(line)) return null;
  if (line.quantity! > line.listing!.max_quantity) {
    return `Quantity must be at most ${line.listing!.max_quantity}`;
  }
  return null;
};

/**
 * Validate the attendee block, the shared date, and each booked line. A daily
 * booking requires a valid shared start date; everything date- or
 * capacity-related beyond that is a warning, not an error.
 */
export const validateParsedForm = (
  parsed: ParsedAttendeeForm,
): ValidationResult => {
  const attendeeError = validateAttendeeBlock(parsed);
  const hasDailyBooking = parsed.lines.some(isBookedDaily);
  const dateError =
    hasDailyBooking && !isIsoDate(parsed.startDate)
      ? "A start date is required for the booked daily listings"
      : null;

  const lineErrors = new Map<number, string>();
  for (let i = 0; i < parsed.lines.length; i++) {
    const error = validateLine(parsed.lines[i]!);
    parsed.lines[i]!.error = error;
    if (error) lineErrors.set(i, error);
  }

  if (attendeeError || dateError || lineErrors.size > 0) {
    return {
      attendeeError,
      dateError,
      lineErrors,
      valid: false,
      values: parsed,
    };
  }
  return { valid: true, values: parsed };
};

// ---------------------------------------------------------------------------
// Mutation adapters — convert parsed form into the DB-layer input shapes
// ---------------------------------------------------------------------------

/** Booking date/duration for a line: the shared range for daily listings, none
 * for standard listings. */
const lineDate = (line: AttendeeFormLine, parsed: ParsedAttendeeForm) =>
  line.listing!.listing_type === "daily"
    ? { date: parsed.startDate, durationDays: parsed.dayCount }
    : { date: null, durationDays: 1 };

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
} => ({
  address: parsed.address,
  bookings: parsed.lines.filter(isBookedLine).map((line): ListingBooking => {
    const { date, durationDays } = lineDate(line, parsed);
    return {
      date,
      durationDays: date ? durationDays : undefined,
      listingId: line.listingId,
      quantity: line.quantity!,
    };
  }),
  email: parsed.email,
  name: parsed.name,
  phone: parsed.phone,
  remainingBalance: parsed.remainingBalance,
  special_instructions: parsed.special_instructions,
  statusId: parsed.statusId,
});

/**
 * Desired final-state lines for the atomic edit. A line that already has a
 * booking keeps its original key (with the old start_at) and `exists: true`, so
 * a moved shared date becomes an in-place UPDATE rather than a drop-and-recreate;
 * not-booked listings are simply absent, so the diff deletes any old row.
 */
export const toDesiredLines = (
  parsed: ParsedAttendeeForm,
): DesiredListingLine[] =>
  parsed.lines.filter(isBookedLine).map((line): DesiredListingLine => {
    const { date, durationDays } = lineDate(line, parsed);
    return {
      date,
      durationDays,
      exists: Boolean(line.existingBooking),
      key: line.key,
      listingId: line.listingId,
      quantity: line.quantity!,
    };
  });

/** A status/balance mismatch surfaced on the attendee form. */
export type BalanceNotice = { tone: "warning" | "info"; message: string };

/**
 * Flag a mismatch between an attendee's status and their balance, or null when
 * the two agree: a paid status that still owes (warning), a reservation with no
 * recorded balance while part of the order is unpaid (warning), or a fully-paid
 * reservation still in a reservation status (info nudge).
 */
export const attendeeBalanceNotice = (
  status: { is_paid_default: boolean; is_reservation: boolean } | null,
  remainingBalance: number,
  fullPrice: number,
  amountPaid: number,
  listedFullPrice = fullPrice,
): BalanceNotice | null => {
  if (!status) return null;
  if (status.is_paid_default) {
    return remainingBalance > 0
      ? {
          message: `This attendee is in a paid status but still owes ${formatCurrency(
            remainingBalance,
          )}.`,
          tone: "warning",
        }
      : null;
  }
  if (status.is_reservation && remainingBalance <= 0) {
    const owed = Math.max(fullPrice, listedFullPrice) - amountPaid;
    if (owed > 0) {
      return {
        message: `This reservation has no balance recorded, but ${formatCurrency(
          owed,
        )} of the order is still unpaid.`,
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
