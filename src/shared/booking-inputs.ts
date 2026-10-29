/** Booking-input rules shared by the surfaces that create or edit bookings:
 *  the admin form and the admin JSON API. Each rule lives here once, and every
 *  surface writes only its own refusal message around it. */

import * as v from "valibot";
import type { CreateAdjustment } from "#shared/checkout-complete.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The per-purchase cap a booking line's quantity must respect: one line never
 *  books more places than its listing allows in a single purchase. */
export const quantityOverCap = (quantity: number, cap: number): boolean =>
  quantity > cap;

/** The longest description a named one-off adjustment carries. */
export const ADJUSTMENT_DESCRIPTION_LIMIT = 200;

/** A payment records money the operator already received: a positive whole
 *  amount in minor units. */
export const isValidPaymentAmount = (amount: number): boolean =>
  Number.isSafeInteger(amount) && amount >= 1;

/** A named adjustment's amount is signed minor units and never zero:
 *  positive bills the attendee, negative forgives part of the debt. */
export const isValidAdjustmentAmount = (amount: number): boolean =>
  Number.isSafeInteger(amount) && amount !== 0;

/** One booking line's agreed per-unit price, or the refusal. Absent means the
 *  listing's own list price. Zero is a deliberate free line, like a stored
 *  zero override. */
export const parseLinePrice = (
  raw: unknown,
  at: string,
): Result<number | undefined> => {
  if (raw === undefined) return okResult(undefined);
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return errorResult(
      `${at}.price must be a whole number of pence or cents from 0`,
    );
  }
  return okResult(raw);
};

/** One payment a create records: a positive minor-unit amount received. */
const PAYMENT_SCHEMA = v.object({
  amount: v.pipe(v.number(), v.check(isValidPaymentAmount)),
});

/** One adjustment's refusal, or the validated entry. */
const parseAdjustment = (
  item: unknown,
  at: string,
): Result<CreateAdjustment> => {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return errorResult(`${at} must name a description and an amount`);
  }
  const { amount, description } = item as Record<string, unknown>;
  if (typeof description !== "string" || description === "") {
    return errorResult(`${at}.description must be text`);
  }
  if (description.length > ADJUSTMENT_DESCRIPTION_LIMIT) {
    return errorResult(
      `${at}.description must be ${ADJUSTMENT_DESCRIPTION_LIMIT} characters or fewer`,
    );
  }
  if (typeof amount !== "number" || !isValidAdjustmentAmount(amount)) {
    return errorResult(
      `${at}.amount must be a whole number of pence or cents, not zero`,
    );
  }
  return okResult({ amount, description });
};

/** Parse every element of an optional array, or the first refusal. Absent
 *  parses to an empty array. */
export const parseEach = <T>(
  raw: unknown,
  label: string,
  parseOne: (item: unknown, at: string) => Result<T>,
): Result<T[]> => {
  if (raw === undefined) return okResult([]);
  if (!Array.isArray(raw)) return errorResult(`${label} must be an array`);
  const values: T[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = parseOne(item, `${label}[${index}]`);
    if (!parsed.ok) return parsed;
    values.push(parsed.value);
  }
  return okResult(values);
};

/** The payments a create records, or the refusal. Each is one cash amount
 *  already received (minor units). Absent means nothing was collected. */
export const parsePayments = (raw: unknown): Result<number[]> =>
  parseEach(raw, "payments", (item, at) => {
    const parsed = v.safeParse(PAYMENT_SCHEMA, item);
    if (!parsed.success) {
      return errorResult(
        `${at}.amount must be a positive whole number of pence or cents`,
      );
    }
    return okResult(parsed.output.amount);
  });

/** The named one-off adjustments, or the refusal. Each names an amount
 *  (signed minor units, never zero) and a description. A positive amount bills
 *  the attendee. A negative one forgives part of the debt. */
export const parseAdjustments = (raw: unknown): Result<CreateAdjustment[]> =>
  parseEach(raw, "adjustments", parseAdjustment);
