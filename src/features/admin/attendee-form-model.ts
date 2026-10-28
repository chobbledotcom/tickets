/**
 * An attendee has ONE shared date range — a `start_date` plus a day count —
 * that applies to every daily listing they book. Fixed-date listings ignore it.
 *
 * The listing table is fixed: one row per booking path, and one for a path not
 * booked yet. Quantity 0 means "not booked". That is what lets the form work
 * with no add/remove buttons and no server round-trips.
 */

import {
  type AttendeeStatus,
  publicDefaultStatusOf,
} from "#db/attendee-statuses.ts";
import type {
  DesiredListingLine,
  ListingAttendeeRow,
  ListingBooking,
} from "#db/attendee-types.ts";
import { range } from "#fp";
import {
  type PackagePricesByListingId,
  parseLines,
} from "#routes/admin/attendee-form-lines.ts";
import {
  isValidAdjustmentAmount,
  isValidPaymentAmount,
} from "#shared/booking-inputs.ts";
import { countsPerDate } from "#shared/capacity-rules.ts";
import type { CreateReceipts } from "#shared/checkout-complete.ts";
import { listPriceOrder, type PricedOrder } from "#shared/checkout-pricing.ts";
import type { FormParams } from "#shared/form-data.ts";
import { START_DATE_FIELD } from "#shared/order-select.ts";
import {
  parseNonNegativeInt,
  parseSignedInt,
} from "#shared/validation/number.ts";
import {
  type ContactInfo,
  clampDurationDays,
  type ListingWithCount,
} from "#types";

// ---------------------------------------------------------------------------
// Field-name constants — single source of truth for template + parser
// ---------------------------------------------------------------------------

/** Shared day count (range length) for every daily listing. */
export const DAY_COUNT_FIELD = "day_count";
export const STATUS_FIELD = "status_id";
export { START_DATE_FIELD };

/** DOM id of the add/edit form, also the post-save scroll anchor. */
export const ATTENDEE_FORM_ID = "attendee-form";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** One row of the listing editor, and its quantity. The row is one booking
 * PATH of a listing: its own standalone row, one package's row, or an
 * existing folded-child row. */
export type AttendeeFormLine = {
  /** Listing id this row books. */
  listingId: number;
  /** The package this line books through (0 = the listing's own row). An
   * existing row's stored value, or a blank line's chosen path. */
  packageGroupId: number;
  /** The package's per-unit price override for this line's path (null = the
   * listing's own price applies — always null on a standalone line). Prices
   * the manual-add ledger legs. */
  packagePrice: number | null;
  /** The parent an EXISTING row was folded under as an add-on (0 = none).
   * Display + slot identity only — the form never creates folded rows. */
  parentListingId: number;
  /** The agreed per-unit price the operator typed for this line, raw. ""
   *  when the row carries none, so the package path's or the listing's own
   *  price applies. Validated by validateLine. */
  priceRaw: string;
  /** Booked quantity. Null/0 means the listing is not booked. */
  quantity: number | null;
  /** True when the "no quantity" box is ticked: keep this line as a quantity-0
   * sentinel rather than booking (quantity ≥ 1) or removing it (box unticked). */
  noQuantity: boolean;
  /** Resolved listing reference (null when the id is unknown). */
  listing: ListingWithCount | null;
  /** Existing booking row, when the attendee already books this listing. */
  existingBooking: ListingAttendeeRow | null;
  /** Stable key of the existing row (`${listingId}|${startAt}`). Empty when new. */
  key: string;
  /** Line-level validation error (set by validateParsedForm). */
  error: string | null;
};

/** One submitted adjustment slot: its raw description and signed amount.
 *  A slot the operator left entirely blank is null. */
export type SubmittedAdjustment = {
  amount: string;
  description: string;
};

/** The fixed payment slots the create form renders. A blank slot is null. */
export const PAYMENT_SLOTS = 3;
/** The fixed adjustment slots the create form renders. */
export const ADJUSTMENT_SLOTS = 3;

/** The full parsed form — attendee fields, the shared range, and line items. */
export type ParsedAttendeeForm = ContactInfo & {
  /** Selected attendee status id, or null for "no status". */
  statusId: number | null;
  /** Shared start date (YYYY-MM-DD) for every daily listing, "" when unset. */
  startDate: string;
  /** Shared range length in days (≥ 1) for every daily listing. */
  dayCount: number;
  lines: AttendeeFormLine[];
  returnUrl: string;
  /** Payments already received, one raw amount per rendered slot (null when
   *  the slot is blank). Validation turns these into recorded amounts. */
  payments: (string | null)[];
  /** Named one-off adjustments, one raw entry per rendered slot (null when
   *  the slot is blank). */
  adjustments: (SubmittedAdjustment | null)[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the line becomes a booking (quantity ≥ 1). Governs capacity,
 * validation, warnings, and logistics — everything the quantity-0 sentinel is
 * deliberately absent from. */
export const isBookedLine = (line: AttendeeFormLine): boolean =>
  line.quantity !== null && line.quantity >= 1 && line.listing !== null;

/** True when the "no quantity" box is ticked for a resolvable listing: a
 * deliberate quantity-0 sentinel line to keep, not a real booking. */
export const isNoQuantityLine = (line: AttendeeFormLine): boolean =>
  line.noQuantity && line.listing !== null;

/** True when a line carries a captured payment (price_paid > 0 on its existing
 * booking). Such a line cannot be marked no-quantity until the charge is
 * refunded. Silently clearing price_paid drops listing income and strands the
 * charge behind the quantity-0 refund guards. The editor disables
 * the line's "no quantity" box ({@link PAID_NO_QUANTITY_MESSAGE} as the
 * tooltip), and the validator rejects a hand-crafted tick. */
export const isPaymentLockedLine = (line: AttendeeFormLine): boolean =>
  (line.existingBooking?.price_paid ?? 0) > 0;

/** True when the line is persisted at all: a real booking OR a deliberate
 * no-quantity line. The persistence + no-lines paths use THIS. A checked
 * quantity-0 line is kept, and a no-quantity-only save is not rejected as
 * "book at least one listing". Capacity/validation keep {@link isBookedLine}. */
export const isRetainedLine = (line: AttendeeFormLine): boolean =>
  isBookedLine(line) || isNoQuantityLine(line);

const clampDayCount = (raw: number | null): number =>
  clampDurationDays(raw ?? 1);

/** The submitted payment slots, blank-aligned: null marks a blank slot, so a
 *  re-render keeps it blank and the operator's typing never shifts slots. */
const paymentSlots = (form: FormParams): (string | null)[] =>
  range(0, PAYMENT_SLOTS).map((slot) => {
    const raw = form.getString(`payment_amount_${slot}`);
    return raw === "" ? null : raw;
  });

/** The submitted adjustment slots, blank-aligned the same way. */
const adjustmentSlots = (form: FormParams): (SubmittedAdjustment | null)[] =>
  range(0, ADJUSTMENT_SLOTS).map((slot) => {
    const amount = form.getString(`adjustment_amount_${slot}`);
    const description = form.getString(`adjustment_description_${slot}`);
    return amount === "" && description === "" ? null : { amount, description };
  });

/**
 * The status an attendee resolves to: their submitted choice, or the public
 * default (the status new bookings start in) when none was given. The form
 * offers no "no status" choice. A missing value — only reachable from a
 * hand-crafted POST — is coerced back to the default rather than clearing it.
 */
export const resolveStatusId = (
  statusId: number | null,
  statuses: AttendeeStatus[],
): number => statusId ?? publicDefaultStatusOf(statuses).id;

export const parseAttendeeForm = (
  form: FormParams,
  listingsById: Map<number, ListingWithCount>,
  existingByKey: Map<string, ListingAttendeeRow> = new Map(),
  packagesByListingId: PackagePricesByListingId = new Map(),
): ParsedAttendeeForm => {
  const statusIdRaw = form.getOptionalInt(STATUS_FIELD);
  return {
    address: form.getString("address"),
    adjustments: adjustmentSlots(form),
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
    payments: paymentSlots(form),
    phone: form.getString("phone"),
    returnUrl: form.getString("return_url"),
    special_instructions: form.getString("special_instructions"),
    startDate: form.getString(START_DATE_FIELD),
    statusId: statusIdRaw !== null && statusIdRaw > 0 ? statusIdRaw : null,
  };
};

// ---------------------------------------------------------------------------
// Mutation adapters — convert parsed form into the DB-layer input shapes
// ---------------------------------------------------------------------------

/** Booking date/duration for a line: the shared range for daily listings, none
 * for standard listings. */
const lineDate = (line: AttendeeFormLine, parsed: ParsedAttendeeForm) =>
  countsPerDate(line.listing!.listing_type)
    ? { date: parsed.startDate, durationDays: parsed.dayCount }
    : { date: null, durationDays: 1 };

/** The booking fields every persisted line carries — its date range, its own
 * booking path, and its quantity. Shared by the create and edit adapters so
 * the two can never disagree about what a line stores. */
const lineBookingFields = (
  line: AttendeeFormLine,
  parsed: ParsedAttendeeForm,
): {
  date: string | null;
  durationDays: number;
  listingId: number;
  packageGroupId: number;
  quantity: number;
} => ({
  ...lineDate(line, parsed),
  listingId: line.listingId,
  // Each line books its own path. Two lines for one listing (its own
  // row beside a package's row) persist as two rows on distinct slots.
  packageGroupId: line.packageGroupId,
  // A retained line always has a non-null quantity: isBookedLine guarantees
  // ≥ 1, and a no-quantity line is parsed/built with quantity 0.
  quantity: line.quantity!,
});

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
    // A date-less (standard) line stores no duration.
    const { durationDays, ...booking } = lineBookingFields(line, parsed);
    return {
      ...booking,
      ...(booking.date ? { durationDays } : {}),
    };
  }),
  email: parsed.email,
  name: parsed.name,
  phone: parsed.phone,
  special_instructions: parsed.special_instructions,
  statusId: parsed.statusId,
});

/**
 * Build the gross priced order for a manual add's ledger legs, one line per
 * booked path at its current list price × quantity. A package-path line uses
 * that package's per-unit override, and an explicit 0 is a free member. Any
 * other line uses the listing's own price. The add form captures no amount
 * paid and no booking fee, so this carries no extras and a zero total.
 * `owedOrderForLedger`/`bookingFactsFromOrder` then recognise each line's
 * gross as a `sale` leg (income) with no `payment`/`fee` leg. The manual-add
 * poster reconciles the owner-entered outstanding balance on top.
 */
export const toLedgerOrder = (parsed: ParsedAttendeeForm): PricedOrder =>
  listPriceOrder(
    parsed.lines.filter(isBookedLine).map((line) => {
      const agreedPrice = parseNonNegativeInt(line.priceRaw);
      return {
        listing: line.listing!,
        quantity: line.quantity!,
        // The operator's agreed price wins. A package path's override is
        // next. The listing's own list price is the default. Validation has
        // already refused malformed agreed prices.
        ...(line.packagePrice === null ? {} : { unitPrice: line.packagePrice }),
        ...(agreedPrice === null ? {} : { unitPrice: agreedPrice }),
      };
    }),
  );

/** The recorded receipts behind a validated form: the payments and named
 *  adjustments as the ledger poster takes them. Only a validated form reaches
 *  this, so every kept slot converts. */
export const receiptsOf = (parsed: ParsedAttendeeForm): CreateReceipts => ({
  adjustments: parsed.adjustments.flatMap((slot) => {
    if (slot === null || slot.description === "") return [];
    const amount = parseSignedInt(slot.amount);
    return amount !== null && isValidAdjustmentAmount(amount)
      ? [{ amount, description: slot.description }]
      : [];
  }),
  payments: parsed.payments.flatMap((raw) => {
    if (raw === null) return [];
    const amount = parseNonNegativeInt(raw);
    return amount !== null && isValidPaymentAmount(amount) ? [amount] : [];
  }),
});

/**
 * Desired final-state lines for the atomic edit — one per retained editor
 * line. The editor renders one line per booking PATH (every stored row plus
 * the blank standalone/package lines), so the retained set IS the complete
 * desired state. A line that already has a row keeps that row's key (an
 * in-place UPDATE, even across a date move). A blank line given a quantity
 * INSERTs on its chosen path. A stored row whose line was zeroed or omitted
 * falls out and is deleted.
 */
export const toDesiredLines = (
  parsed: ParsedAttendeeForm,
): DesiredListingLine[] =>
  // Retained lines, not just booked lines: a checked quantity-0 line must
  // persist (become/stay a quantity-0 row) rather than fall out and be
  // deleted.
  parsed.lines.filter(isRetainedLine).map(
    (line): DesiredListingLine => ({
      // The shared fields include the line's own path: an existing row's
      // stored values, or a blank line's chosen package. The edit therefore
      // always targets exactly one slot.
      ...lineBookingFields(line, parsed),
      exists: Boolean(line.existingBooking),
      key: line.key,
      parentListingId: line.parentListingId,
    }),
  );
