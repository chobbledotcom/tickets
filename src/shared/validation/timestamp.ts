import { Temporal } from "temporal-polyfill";

/**
 * Instant validation, and the ISO-string to epoch-millis conversions the ledger
 * persists by. `Temporal.Instant.from` is the single source of truth for "is
 * this a real instant": it REJECTS Feb 30, month 13, and hour 24, where
 * `Date.parse` silently normalises them (`2026-02-30` becomes Mar 2) and
 * valibot's `isoTimestamp` checks only the format. Temporal comes from
 * `temporal-polyfill` because the edge runtime exposes no stable global.
 *
 * Transfers store integer epoch-millis, so the indexed `occurred_at` column
 * sorts and ranges by integer comparison, not by fixed-width string.
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
