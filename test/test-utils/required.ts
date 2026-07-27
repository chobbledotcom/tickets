/**
 * The value a test fixture says must be there.
 *
 * Test helpers constantly narrow away a `null` or `undefined` a fixture can
 * never really produce. Doing that with a hand-written `if` in each helper
 * leaves a throw nothing ever runs; this says the same thing in one place, so
 * a fixture that really does come back empty names what was missing.
 */
export const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
};
