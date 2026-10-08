import { t } from "#i18n";
import {
  type AttendeeFailureFormatter,
  attendeeFailureFormatter,
} from "#shared/attendee-failures.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validatePrice } from "#shared/validation/money.ts";

/** Parse and validate a custom unit price from a form field.
 * Returns the price in minor units, or an error string if invalid. */
export const parseCustomPrice = (
  form: FormParams,
  fieldName: string,
  minPrice: number,
  maxPrice: number,
) => validatePrice(form.getString(fieldName), minPrice, maxPrice);

/** The messages a failed public booking answers with — written once here so
 * the web form and the JSON API never retype (and drift on) the same copy. */
export const bookingError = {
  /** Above a surface's maximum quantity or bundle limit. */
  aboveMaximumQuantity: (maximum: number): string =>
    t("booking.quantity_above_maximum", { maximum }),
  /** Below a surface's minimum quantity, with no listing name to point at. */
  belowMinimumQuantity: (minimum: number): string =>
    t("booking.quantity_below_minimum", { minimum }),
  /** An attendee write failure that isn't about capacity. */
  fallback: "Registration failed. Please try again.",
  /** Out of capacity, with no listing name to point at. */
  generic: "Sorry, not enough spots available",
  /** A booking for a date the listing doesn't offer. */
  invalidDate: "Please select a valid date",
  /** Below the listing's minimum quantity. */
  minimum: (name: string, minQuantity: number): string =>
    t("public.ticket.minimum_per_booking", { minimum: minQuantity, name }),
  /** Above the listing's maximum quantity. */
  maximum: (name: string, maxQuantity: number): string =>
    t("public.ticket.maximum_per_booking", { maximum: maxQuantity, name }),
  /** Above one package's bundle limit for the page. */
  packageMaximum: (name: string, maxPackages: number): string =>
    t("public.package_maximum_per_booking", { maximum: maxPackages, name }),
  /** Above one add-on's quantity ceiling. */
  addOnMaximum: (name: string, maxQuantity: number): string =>
    t("public.addon_maximum", { maximum: maxQuantity, name }),
  /** The payment provider wouldn't open a checkout session. */
  paymentSessionFailed: "Failed to create payment session",
  /** Out of capacity on a named listing. */
  withName: (name: string): string =>
    `Sorry, ${name} no longer has enough spots available`,
};

/** Format error message for failed attendee creation. */
export const formatAtomicError: AttendeeFailureFormatter =
  attendeeFailureFormatter(bookingError);
