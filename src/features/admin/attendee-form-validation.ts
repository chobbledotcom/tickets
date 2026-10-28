/**
 * Validation for the parsed attendee form: the attendee block, the shared
 * date, each editor line, and the submitted money. Pure data-in/data-out over
 * a {@link ParsedAttendeeForm} — the routes own the writes, and the re-render
 * paths surface these refusals in place.
 */

import { t } from "#i18n";
import {
  type AttendeeFormLine,
  isBookedLine,
  isNoQuantityLine,
  isPaymentLockedLine,
  type ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import {
  ADJUSTMENT_DESCRIPTION_LIMIT,
  isValidAdjustmentAmount,
  isValidPaymentAmount,
  quantityOverCap,
} from "#shared/booking-inputs.ts";
import { countsPerDate } from "#shared/capacity-rules.ts";
import { formatCurrency } from "#shared/currency.ts";
import { isIsoDate } from "#shared/validation/date-string.ts";
import {
  parseNonNegativeInt,
  parseSignedInt,
} from "#shared/validation/number.ts";
import {
  validateAddress,
  validateEmail,
  validateName,
  validatePhone,
  validateSpecialInstructions,
} from "#templates/fields/validators.ts";
import type { ContactInfo } from "#types";

/** Why a paid line cannot be marked no-quantity. The message shows at the top
 * of the page on a (hand-crafted) submission and on the disabled box's tooltip. */
export const PAID_NO_QUANTITY_MESSAGE = (): string =>
  t("attendee_form.paid_no_quantity_line");

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
      /** Form-wide error surfaced at the top of the page, for example a paid
       * line marked no-quantity. A per-line error instead shows in the table. */
      formError: string | null;
      lineErrors: Map<number, string>;
      values: ParsedAttendeeForm;
    };

/** The attendee block's refusal, or the validated contact fields. */
export const validateAttendeeBlock = (
  parsed: ParsedAttendeeForm,
): AttendeeFieldError | null => {
  if (!parsed.name.trim()) {
    return { field: "name", message: t("error.name_required") };
  }
  const nameError = validateName(parsed.name);
  if (nameError) return { field: "name", message: nameError };
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
  isBookedLine(line) && countsPerDate(line.listing!.listing_type);

/** Validate one line. Date/duration/overbooking concerns are surfaced as
 * non-blocking warnings elsewhere, not as errors. The paid-line no-quantity rule
 * is enforced form-wide ({@link validatePaidNoQuantity}) so its message lands at
 * the top of the page, not buried in the quantity table. */
const validateLine = (line: AttendeeFormLine): string | null => {
  // A price on a row that books nothing is a mistake worth refusing: the
  // operator probably meant the quantity on this row.
  if (!isBookedLine(line)) {
    return line.priceRaw === ""
      ? null
      : t("attendee_form.price_without_quantity");
  }
  if (line.priceRaw !== "" && parseNonNegativeInt(line.priceRaw) === null) {
    return t("attendee_form.price_invalid");
  }
  // isBookedLine already guarantees an integer quantity ≥ 1. The only quantity
  // error left is exceeding the listing's per-booking maximum.
  if (quantityOverCap(line.quantity!, line.listing!.max_quantity)) {
    return t("attendee_form.qty_max", { max: line.listing!.max_quantity });
  }
  return null;
};

/** Form-wide guard: forbid marking a PAID line no-quantity — the charge must be
 * refunded or retargeted to a real line first (enforces the §1 invariant). The
 * editor already disables the box for these lines, so this only fires on a
 * hand-crafted submission. Its message is shown at the top of the page. */
const validatePaidNoQuantity = (parsed: ParsedAttendeeForm): string | null =>
  parsed.lines.some((l) => isNoQuantityLine(l) && isPaymentLockedLine(l))
    ? PAID_NO_QUANTITY_MESSAGE()
    : null;

/** The first refusal on the submitted payment slots, or null when they all
 *  carry valid money. The message shows at the top of the page. */
const paymentRefusal = (parsed: ParsedAttendeeForm): string | null => {
  for (const raw of parsed.payments) {
    if (raw === null) continue;
    const amount = parseNonNegativeInt(raw);
    if (amount === null || !isValidPaymentAmount(amount)) {
      return t("attendee_form.payment_invalid");
    }
  }
  return null;
};

/** The first refusal on the submitted adjustment slots, or null when they all
 *  carry valid money. The message shows at the top of the page. */
const adjustmentRefusal = (parsed: ParsedAttendeeForm): string | null => {
  for (const slot of parsed.adjustments) {
    if (slot === null) continue;
    if (slot.description === "") {
      return t("attendee_form.adjustment_description_required");
    }
    if (slot.description.length > ADJUSTMENT_DESCRIPTION_LIMIT) {
      return t("attendee_form.adjustment_description_long", {
        limit: ADJUSTMENT_DESCRIPTION_LIMIT,
      });
    }
    const amount = parseSignedInt(slot.amount);
    if (amount === null || !isValidAdjustmentAmount(amount)) {
      return t("attendee_form.adjustment_amount_invalid");
    }
  }
  return null;
};

/**
 * Validate the attendee block, the shared date, and each booked line. A daily
 * booking requires a valid shared start date. Everything date- or
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
  const formError =
    validatePaidNoQuantity(parsed) ??
    paymentRefusal(parsed) ??
    adjustmentRefusal(parsed);

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

/** A status/balance mismatch surfaced on the attendee form. */
export type BalanceNotice = { tone: "warning" | "info"; message: string };

/**
 * Flag a mismatch between an attendee's status and their balance, or null when
 * the two agree. The mismatch is one of these: a paid status that still owes
 * (warning). A reservation with no recorded balance while part of the order is
 * unpaid (warning). A fully-paid reservation still in a reservation status
 * (info nudge).
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
