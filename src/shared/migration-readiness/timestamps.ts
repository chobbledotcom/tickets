/**
 * Legacy timestamp conversion for the migration-readiness verdict. Every
 * stored time column must normalise to the canonical `…sssZ` ISO instant the
 * forward copy expects. An unrecoverable value is a contradiction.
 */

import { Temporal } from "temporal-polyfill";
import type {
  CheckoutStageRow,
  Contradiction,
  ProcessedPaymentRow,
  SumupCheckoutRow,
} from "#shared/migration-readiness/readiness.ts";
import { epochMsToIso } from "#shared/validation/timestamp.ts";

/** Normalise a legacy stored timestamp to the canonical `…sssZ` ISO instant.
 *  Accepts ISO-8601 instants (any offset or sub-second precision) and the
 *  whole-epoch-millis strings older rows stored. Returns `""` for an empty
 *  column. The caller knows whether the column is required and handles a
 *  genuinely absent time. Returns `null` when a value is neither a real
 *  instant nor a representable epoch-millis, so the caller can surface it
 *  instead of inventing a moment. */
export const convertLegacyTimestamp = (value: string): string | null => {
  if (value === "") return "";
  if (/^\d+$/.test(value)) {
    const epoch = Number(value);
    if (!Number.isInteger(epoch) || epoch <= 0) return null;
    try {
      return epochMsToIso(epoch);
    } catch {
      // Values outside Date's representable range (for example an overflowed
      // epoch) are not real instants. Surface them rather than throw.
      return null;
    }
  }
  try {
    // Temporal rejects impossible dates (month 13, Feb 30) where Date
    // silently fixes them. It is the honest boundary for "is this a real
    // instant". The epoch-millis round trip yields the canonical form.
    return epochMsToIso(Temporal.Instant.from(value).epochMilliseconds);
  } catch {
    return null;
  }
};

/** Convert every legacy timestamp column to a canonical instant. Returns one
 *  contradiction per value that is neither a real instant nor a representable
 *  epoch-millis. `processed_at`, `checkout_stages.created_at`, and
 *  `sumup_checkouts.created_at` are NOT NULL in the schema, so an empty value
 *  is corruption. `provider_refunded_at` is optional, so an empty value is
 *  not a contradiction. */
export const convertAllTimestamps = (
  processed: readonly ProcessedPaymentRow[],
  stages: readonly CheckoutStageRow[],
  sumup: readonly SumupCheckoutRow[],
): { contradictions: Contradiction[]; converted: number } => {
  const contradictions: Contradiction[] = [];
  let converted = 0;
  const check = (value: string, label: string, required: boolean): void => {
    if (value === "") {
      if (required) {
        contradictions.push({ detail: label, kind: "unconvertible_timestamp" });
      }
      return;
    }
    // A non-empty value converts to a canonical instant or null. A non-null
    // result is a successful conversion. "" is never a conversion result.
    const result = convertLegacyTimestamp(value);
    if (result === null) {
      contradictions.push({ detail: label, kind: "unconvertible_timestamp" });
    } else {
      converted += 1;
    }
  };
  for (const row of processed) {
    check(
      row.processed_at,
      `processed_payments.processed_at = ${row.processed_at}`,
      true,
    );
    check(
      row.provider_refunded_at,
      `processed_payments.provider_refunded_at = ${row.provider_refunded_at}`,
      false,
    );
  }
  for (const row of stages) {
    check(
      row.created_at,
      `checkout_stages.created_at = ${row.created_at}`,
      true,
    );
  }
  for (const row of sumup) {
    check(
      row.created_at,
      `sumup_checkouts.created_at = ${row.created_at}`,
      true,
    );
  }
  return { contradictions, converted };
};
