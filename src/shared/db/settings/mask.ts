/**
 * Mask sentinel used by masked-input settings fields.
 *
 * A masked secret field renders its current value as a row of bullets and
 * submits this sentinel when the operator leaves it untouched. The writers
 * treat the sentinel as "no change"; any other non-empty value replaces the
 * stored secret.
 */

export const MASK_SENTINEL = "••••••••••••";

/** True when `value` is the no-change sentinel submitted by a masked field. */
export const isMaskSentinel = (value: string): boolean =>
  value === MASK_SENTINEL;
