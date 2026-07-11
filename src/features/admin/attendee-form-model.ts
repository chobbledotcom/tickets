/**
 * Shared form model for the unified add/edit attendee page.
 *
 * Both `/admin/attendees/new` (create) and `/admin/attendees/:id` (edit) render
 * the same fields and run the same validation. An attendee has ONE shared date
 * range — a `start_date` plus a day count — that applies to every daily listing
 * they book; standard (fixed-date) listings ignore it.
 *
 * The listing editor is a fixed table with ONE ROW PER BOOKING PATH — every
 * stored `listing_attendees` row (a listing may hold several: its own
 * standalone row beside package rows, or a child folded under a parent), plus
 * a blank standalone line per not-yet-booked listing and a blank line per
 * (package, member) path so the operator can book any combination a public
 * buyer could. Quantity ≥ 1 books a line, 0 leaves it out. There are no
 * add/remove-line buttons, so the form needs no server round-trips (the blank
 * lines hide behind pure-CSS toggles).
 */

import { mapNotNullish } from "#fp";
import { t } from "#i18n";
import type { PricedLine, PricedOrder } from "#shared/checkout-pricing.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type {
  DesiredListingLine,
  ListingAttendeeRow,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import type { FormParams } from "#shared/form-data.ts";
import { START_DATE_FIELD } from "#shared/order-select.ts";
import {
  type ContactInfo,
  type ListingWithCount,
  normalizeDurationDays,
} from "#shared/types.ts";
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
} from "#templates/fields/validators.ts";

// ---------------------------------------------------------------------------
// Field-name constants — single source of truth for template + parser
// ---------------------------------------------------------------------------

/** Shared day count (range length) for every daily listing. */
export const DAY_COUNT_FIELD = "day_count";
/** Per-line hidden field carrying the line's listing id: `line_listing_<i>`.
 * The presence of this field is what defines a line; `<i>` is the line's
 * position in the rendered editor, shared by every other per-line field. */
export const LINE_LISTING_PREFIX = "line_listing_";
/** Per-line quantity field: `qty_<i>`. */
export const QTY_PREFIX = "qty_";
/** Per-line "no quantity" checkbox: `noqty_<i>`. When ticked the line is kept
 * as a quantity-0 sentinel (counts toward no capacity/tickets/income and is
 * hidden from operational/public surfaces) instead of being booked or removed.
 * Owners never see a literal 0 — the checkbox is the proxy for `quantity == 0`. */
export const NO_QUANTITY_PREFIX = "noqty_";
/** Per-line hidden field carrying the existing booking row's key, so an edit
 * moves/keeps exactly that row: `line_key_<i>`. Empty on a blank line. */
export const LINE_KEY_PREFIX = "line_key_";
/** Per-line hidden field carrying the package path a BLANK line books through
 * when given a quantity: `line_package_<i>` (0 = the listing's own standalone
 * row). An existing row's path comes from the row itself, never this field. */
export const LINE_PACKAGE_PREFIX = "line_package_";
/** Checkbox that reveals the not-booked listing rows when at least one line is
 * already booked (pure-CSS, never parsed; omitted on a bare create form, which
 * shows every listing). */
export const SHOW_ALL_FIELD = "show_all";
/** Checkbox that reveals the blank package-path lines (pure CSS, never
 * parsed) — one line per (package, member) path the attendee could book. */
export const SHOW_PACKAGE_PATHS_FIELD = "show_package_paths";
export const STATUS_FIELD = "status_id";
export { START_DATE_FIELD };

/** DOM id of the add/edit form, also the post-save scroll anchor. */
export const ATTENDEE_FORM_ID = "attendee-form";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** One row of the listing editor — one booking PATH of a listing (its own
 * standalone row, one package's row, or an existing folded-child row) and its
 * quantity. */
export type AttendeeFormLine = {
  /** Listing id this row books. */
  listingId: number;
  /** The package this line books through (0 = the listing's own row). An
   * existing row's stored value; a blank line's chosen path. */
  packageGroupId: number;
  /** The package's per-unit price override for this line's path (null = no
   * override, so the listing's own price applies — always null on a
   * standalone line). Prices the manual-add ledger legs. */
  packagePrice: number | null;
  /** The parent an EXISTING row was folded under as an add-on (0 = none).
   * Display + slot identity only — the form never creates folded rows. */
  parentListingId: number;
  /** Booked quantity; null/0 means the listing is not booked. */
  quantity: number | null;
  /** True when the "no quantity" box is ticked: keep this line as a quantity-0
   * sentinel rather than booking (quantity ≥ 1) or removing it (quantity 0,
   * box unticked). */
  noQuantity: boolean;
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
export type ParsedAttendeeForm = ContactInfo & {
  /** Selected attendee status id, or null for "no status". */
  statusId: number | null;
  /** Shared start date (YYYY-MM-DD) for every daily listing; "" when unset. */
  startDate: string;
  /** Shared range length in days (≥ 1) for every daily listing. */
  dayCount: number;
  lines: AttendeeFormLine[];
  returnUrl: string;
};

/** Attendee-level validation error. */
export type AttendeeFieldError = {
  field: keyof ContactInfo;
  message: string;
};

/** Result of validating a parsed form. */
export type ValidationResult =
  | { valid: true; values: ParsedAttendeeForm }
  | {
      valid: false;
      attendeeError: AttendeeFieldError | null;
      dateError: string | null;
      /** Form-wide error surfaced at the top of the page (e.g. a paid line was
       * marked no-quantity), as opposed to a per-line error shown in the table. */
      formError: string | null;
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

/** True when the line should become a booking (quantity ≥ 1). Governs capacity,
 * validation, warnings, and logistics — everything the quantity-0 sentinel is
 * deliberately absent from. */
export const isBookedLine = (line: AttendeeFormLine): boolean =>
  line.quantity !== null && line.quantity >= 1 && line.listing !== null;

/** True when the "no quantity" box is ticked for a resolvable listing: a
 * deliberate quantity-0 sentinel line to keep, not a real booking. */
export const isNoQuantityLine = (line: AttendeeFormLine): boolean =>
  line.noQuantity && line.listing !== null;

/** True when a line carries a captured payment (price_paid > 0 on its existing
 * booking). Such a line can't be marked no-quantity until the charge is
 * refunded — silently clearing price_paid would drop listing income and strand
 * the charge behind the quantity-0 refund guards — so the editor disables its
 * "no quantity" box ({@link PAID_NO_QUANTITY_MESSAGE} as the tooltip) and the
 * validator rejects a hand-crafted tick. */
export const isPaymentLockedLine = (line: AttendeeFormLine): boolean =>
  (line.existingBooking?.price_paid ?? 0) > 0;

/** Why a paid line can't be marked no-quantity: shown at the top of the page on
 * a (hand-crafted) submission and as the disabled box's hover tooltip. */
export const PAID_NO_QUANTITY_MESSAGE = (): string =>
  t("attendee_form.paid_no_quantity_line");

/** True when the line should be persisted at all: a real booking OR a deliberate
 * no-quantity line. The persistence + no-lines paths use THIS (so a checked
 * quantity-0 line is kept and a no-quantity-only save isn't rejected as "book at
 * least one listing"), while capacity/validation keep {@link isBookedLine}. */
export const isRetainedLine = (line: AttendeeFormLine): boolean =>
  isBookedLine(line) || isNoQuantityLine(line);

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
const parseQuantity = (raw: string): number | null => parseNonNegativeInt(raw);

/** The packages each listing can book through, with each path's per-unit
 * price override (null = no override — the listing's own price applies):
 * membership validates a blank line's chosen path, the price feeds the
 * manual-add ledger. */
export type PackagePricesByListingId = ReadonlyMap<
  number,
  ReadonlyMap<number, number | null>
>;

/** The package a BLANK line books through: its submitted `line_package_<i>`,
 * accepted only when it names a real package containing this listing (the
 * caller's membership map). Anything else — including a package deleted while
 * the form was open — books the listing's own standalone row instead of
 * minting a row tagged with a package that does not exist. */
const resolveNewLinePackage = (
  raw: string,
  listingId: number,
  packagesByListingId: PackagePricesByListingId,
): number => {
  const groupId = parsePositiveIntId(raw);
  return groupId !== null &&
    packagesByListingId.get(listingId)?.has(groupId) === true
    ? groupId
    : 0;
};

/** One editor line per `line_listing_<i>` field in the form, in document order
 * and de-duplicated by index, with the listing + existing booking resolved. An
 * existing row's path (package, folded parent) comes from the row; a blank
 * line's package path from its validated `line_package_<i>`. A ticked
 * `noqty_<i>` box forces quantity to 0 and marks the line no-quantity (its
 * quantity input is CSS-hidden, so its submitted value is ignored). */
const parseLines = (
  form: FormParams,
  resolve: (
    id: number,
    key: string,
  ) => Pick<AttendeeFormLine, "listing" | "existingBooking">,
  packagesByListingId: PackagePricesByListingId,
): AttendeeFormLine[] => {
  const lines: AttendeeFormLine[] = [];
  const seen = new Set<number>();
  for (const [field, raw] of form.entries()) {
    if (!field.startsWith(LINE_LISTING_PREFIX)) continue;
    // Line indexes start at 0, so this must accept zero (unlike listing ids).
    const index = parseNonNegativeInt(field.slice(LINE_LISTING_PREFIX.length));
    if (index === null || seen.has(index)) continue;
    seen.add(index);
    const id = parsePositiveIntId(raw);
    if (id === null) continue;
    const key = form.getString(`${LINE_KEY_PREFIX}${index}`);
    const resolved = resolve(id, key);
    const noQuantity = form.getString(`${NO_QUANTITY_PREFIX}${index}`) !== "";
    const packageGroupId =
      resolved.existingBooking?.package_group_id ??
      resolveNewLinePackage(
        form.getString(`${LINE_PACKAGE_PREFIX}${index}`),
        id,
        packagesByListingId,
      );
    lines.push({
      error: null,
      key,
      listingId: id,
      noQuantity,
      packageGroupId,
      packagePrice:
        packageGroupId > 0
          ? (packagesByListingId.get(id)?.get(packageGroupId) ?? null)
          : null,
      parentListingId: resolved.existingBooking?.parent_listing_id ?? 0,
      quantity: noQuantity
        ? 0
        : parseQuantity(form.getString(`${QTY_PREFIX}${index}`)),
      ...resolved,
    });
  }
  return lines;
};

export const parseAttendeeForm = (
  form: FormParams,
  listingsById: Map<number, ListingWithCount>,
  existingByKey: Map<string, ListingAttendeeRow> = new Map(),
  packagesByListingId: PackagePricesByListingId = new Map(),
): ParsedAttendeeForm => {
  const statusIdRaw = form.getOptionalInt(STATUS_FIELD);
  return {
    address: form.getString("address"),
    dayCount: clampDayCount(form.getOptionalInt(DAY_COUNT_FIELD)),
    email: form.getString("email"),
    lines: parseLines(
      form,
      (id, key) => ({
        existingBooking: key ? (existingByKey.get(key) ?? null) : null,
        listing: listingsById.get(id) ?? null,
      }),
      packagesByListingId,
    ),
    name: form.getString("name"),
    phone: form.getString("phone"),
    returnUrl: form.getString("return_url"),
    special_instructions: form.getString("special_instructions"),
    startDate: form.getString(START_DATE_FIELD),
    statusId: statusIdRaw !== null && statusIdRaw > 0 ? statusIdRaw : null,
  };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const validateAttendeeBlock = (
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

/** Validate one line. Date/duration/overbooking concerns are surfaced as
 * non-blocking warnings elsewhere, not as errors. The paid-line no-quantity rule
 * is enforced form-wide ({@link validatePaidNoQuantity}) so its message lands at
 * the top of the page, not buried in the quantity table. */
const validateLine = (line: AttendeeFormLine): string | null => {
  // isBookedLine already guarantees an integer quantity ≥ 1; the only quantity
  // error left is exceeding the listing's per-booking maximum.
  if (!isBookedLine(line)) return null;
  if (line.quantity! > line.listing!.max_quantity) {
    return t("attendee_form.qty_max", { max: line.listing!.max_quantity });
  }
  return null;
};

/** Form-wide guard: forbid marking a PAID line no-quantity — the charge must be
 * refunded or retargeted to a real line first (enforces the §1 invariant). The
 * editor already disables the box for these lines, so this only fires on a
 * hand-crafted submission; its message is shown at the top of the page. */
const validatePaidNoQuantity = (parsed: ParsedAttendeeForm): string | null =>
  parsed.lines.some((l) => isNoQuantityLine(l) && isPaymentLockedLine(l))
    ? PAID_NO_QUANTITY_MESSAGE()
    : null;

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
      ? t("attendee_form.date_required")
      : null;
  const formError = validatePaidNoQuantity(parsed);

  const lineErrors = new Map<number, string>();
  for (let i = 0; i < parsed.lines.length; i++) {
    const error = validateLine(parsed.lines[i]!);
    parsed.lines[i]!.error = error;
    if (error) lineErrors.set(i, error);
  }

  if (attendeeError || dateError || formError || lineErrors.size > 0) {
    return {
      attendeeError,
      dateError,
      formError,
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
): ContactInfo & {
  bookings: ListingBooking[];
  statusId: number | null;
} => ({
  address: parsed.address,
  // Retained lines, not just booked lines: a no-quantity line is persisted as a
  // quantity-0 sentinel (price_paid defaults to 0, satisfying the §1 invariant).
  bookings: parsed.lines.filter(isRetainedLine).map((line): ListingBooking => {
    const { date, durationDays } = lineDate(line, parsed);
    return {
      date,
      ...(date && durationDays !== undefined ? { durationDays } : {}),
      listingId: line.listingId,
      // Each line books its own path, so two lines for one listing (its own
      // row beside a package's row) persist as two rows on distinct slots.
      packageGroupId: line.packageGroupId,
      // A retained line always has a non-null quantity: isBookedLine guarantees
      // ≥ 1, and a no-quantity line is parsed/built with quantity 0.
      quantity: line.quantity!,
    };
  }),
  email: parsed.email,
  name: parsed.name,
  phone: parsed.phone,
  special_instructions: parsed.special_instructions,
  statusId: parsed.statusId,
});

/**
 * Build the gross priced order for a manual add's ledger legs: one line per
 * booked path at its current list price × quantity — a package-path line at
 * that package's per-unit override (an explicit 0 is a free member), any
 * other line at the listing's own price. The add form captures no amount paid
 * and no booking fee, so this carries no extras and a zero total —
 * `owedOrderForLedger`/`bookingFactsFromOrder` then recognise each line's gross
 * as a `sale` leg (income) with no `payment`/`fee` leg, and the manual-add poster
 * reconciles the owner-entered outstanding balance on top. A booked line always
 * resolves its listing (`isBookedLine`), so `listing!` is safe.
 */
export const toLedgerOrder = (parsed: ParsedAttendeeForm): PricedOrder => {
  const lines: PricedLine[] = parsed.lines
    .filter(isBookedLine)
    .map((line): PricedLine => {
      const listing = line.listing!;
      const unitPrice = line.packagePrice ?? listing.unit_price;
      return {
        chargedUnitAmount: unitPrice,
        item: {
          listingId: line.listingId,
          name: listing.name,
          quantity: line.quantity!,
          slug: listing.slug,
          unitPrice,
        },
        quantity: line.quantity!,
      };
    });
  return {
    extras: [],
    fullSubtotal: 0,
    lines,
    modifierApplications: [],
    total: 0,
  };
};

/**
 * Desired final-state lines for the atomic edit — one per retained editor
 * line. The editor renders one line per booking PATH (every stored row plus
 * the blank standalone/package lines), so the retained set IS the complete
 * desired state: a line that already has a row keeps that row's key (an
 * in-place UPDATE, even across a date move), a blank line given a quantity
 * INSERTs on its chosen path, and any stored row whose line was zeroed or
 * omitted falls out and is deleted.
 */
export const toDesiredLines = (
  parsed: ParsedAttendeeForm,
): DesiredListingLine[] =>
  // Retained lines, not just booked lines: a checked quantity-0 line must
  // persist (become/stay a quantity-0 row) rather than fall out and be
  // deleted.
  parsed.lines.filter(isRetainedLine).map((line): DesiredListingLine => {
    const { date, durationDays } = lineDate(line, parsed);
    return {
      date,
      durationDays,
      exists: Boolean(line.existingBooking),
      key: line.key,
      listingId: line.listingId,
      // The line's own path — an existing row's stored values, a blank
      // line's chosen package — so the edit always targets exactly one slot.
      packageGroupId: line.packageGroupId,
      parentListingId: line.parentListingId,
      // A retained line always has a non-null quantity: isBookedLine
      // guarantees ≥ 1, and a no-quantity line is parsed/built with
      // quantity 0.
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
          message: t("attendee_form.balance_paid_but_owes", {
            amount: formatCurrency(remainingBalance),
          }),
          tone: "warning",
        }
      : null;
  }
  if (status.is_reservation && remainingBalance <= 0) {
    const owed = Math.max(fullPrice, listedFullPrice) - amountPaid;
    if (owed > 0) {
      return {
        message: t("attendee_form.balance_reservation_unpaid", {
          amount: formatCurrency(owed),
        }),
        tone: "warning",
      };
    }
    if (fullPrice > 0) {
      return {
        message: t("attendee_form.balance_reservation_paid"),
        tone: "info",
      };
    }
  }
  return null;
};
