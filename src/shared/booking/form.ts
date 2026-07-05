import { capacityErrorFormatter } from "#shared/capacity-error.ts";
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

/** Format error message for failed attendee creation. */
export const formatAtomicError = capacityErrorFormatter({
  fallback: "Registration failed. Please try again.",
  generic: "Sorry, not enough spots available",
  withName: (name) => `Sorry, ${name} no longer has enough spots available`,
});
