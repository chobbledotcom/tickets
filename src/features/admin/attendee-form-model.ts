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
import { addDays, getAvailableDates } from "#shared/dates.ts";
import type {
  DesiredListingLine,
  ListingAttendeeRow,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import { bookingSlotKey } from "#shared/db/attendees/booking-slot.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MAX_FORM_LINES } from "#shared/limits.ts";
import type { Holiday, ListingWithCount } from "#shared/types.ts";
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
export const LINE_KEY_PREFIX = "line_key_";
export const LINE_COUNT_FIELD = "line_count";

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

  return {
    action: parseAction(form),
    address: form.getString("address"),
    email: form.getString("email"),
    lines,
    name: form.getString("name"),
    phone: form.getString("phone"),
    returnUrl: form.getString("return_url"),
    special_instructions: form.getString("special_instructions"),
  };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isValidDateString = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Reject rollover typos (e.g. 2026-02-30 → Mar 2) by requiring the parsed
  // date to serialize back to the same string, not just be non-NaN.
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

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
    return { field: "name", message: "Name is required" };
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
    if (!isValidDateString(line.date)) {
      return "Date must be a valid YYYY-MM-DD value";
    }
    const allowed = new Set(getAvailableDates(line.listing, holidays));
    if (!allowed.has(line.date)) {
      return "Date is not bookable for this listing";
    }
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
export const toCreateInput = (
  parsed: ParsedAttendeeForm,
): {
  address: string;
  bookings: ListingBooking[];
  email: string;
  name: string;
  phone: string;
  special_instructions: string;
} => {
  const bookings: ListingBooking[] = pipe(
    filter(isFillableLine),
    map(
      (line: AttendeeFormLine): ListingBooking => ({
        date: line.listing!.listing_type === "daily" ? line.date : null,
        durationDays:
          line.listing!.listing_type === "daily"
            ? line.listing!.duration_days
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
    special_instructions: parsed.special_instructions,
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
        durationDays: isDaily ? line.listing!.duration_days : 1,
        exists: Boolean(line.key) && Boolean(line.existingBooking),
        key: line.key,
        listingId: line.listingId,
        quantity: line.quantity!,
      };
    }),
  )(parsed.lines);
