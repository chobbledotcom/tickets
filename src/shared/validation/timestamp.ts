import { Temporal } from "temporal-polyfill";

/**
 * Instant validation and the ISO-string ⇄ epoch-millis conversions the ledger
 * persists by.
 *
 * `Temporal.Instant.from` is the single source of truth for "is this a real
 * instant": it accepts any ISO-8601 instant — a `Z` or a numeric offset, at any
 * sub-second precision — and *rejects* impossible ones (Feb 30, month 13, hour
 * 24, malformed text) with a `RangeError`, where `Date.parse` would silently
 * normalise them (`2026-02-30` → Mar 2). valibot's `isoTimestamp` only checks
 * the format and so accepts those overflow days, which is why the instant rules
 * live on Temporal here rather than on a valibot schema. Temporal is imported
 * from `temporal-polyfill` (as `shared/timezone.ts` does) since the edge runtime
 * exposes no stable global.
 *
 * Transfers store time as INTEGER epoch-millis: the indexed `occurred_at` column
 * then sorts and ranges chronologically with integer comparisons at high row
 * counts, instead of relying on a fixed-width canonical string. The value read
 * back is always the canonical `YYYY-MM-DDTHH:mm:ss.sssZ` form, so a
 * non-canonical input (an offset, or no milliseconds) is normalised on the
 * round-trip.
 */

/**
 * Whether a string is a real ISO-8601 instant Temporal can parse *and* one we can
 * store losslessly. The ledger persists millisecond resolution (epoch-millis), so
 * an instant carrying finer precision is rejected rather than silently truncated —
 * otherwise two sub-millisecond-distinct moments would collapse to one stored ms
 * and read back equal.
 */
export const isInstant = (value: string): boolean => {
  try {
    return Temporal.Instant.from(value).epochNanoseconds % 1_000_000n === 0n;
  } catch {
    return false;
  }
};

/**
 * Epoch-millis for an instant string. Throws on a non-instant, so call it only
 * after {@link isInstant} — the ledger validates every transfer before it posts.
 */
export const instantToEpochMs = (value: string): number =>
  Temporal.Instant.from(value).epochMilliseconds;

/** The canonical `…sssZ` ISO string for an epoch-millis value. */
export const epochMsToIso = (ms: number): string => new Date(ms).toISOString();
