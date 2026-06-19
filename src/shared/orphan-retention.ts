/**
 * Retention options for purging "orphaned" attendees — attendee records left
 * with no listing bookings (e.g. the only listing they were on was deleted).
 *
 * Pure constants + helpers with no database or settings dependency, so the
 * settings layer, the Privacy page template, the form handler, and the prune
 * scheduler can all share one source of truth for the allowed ages, their
 * labels, and how an age maps to a cut-off timestamp.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** One selectable retention age: its stored value (whole days) and label key. */
export type OrphanRetentionOption = {
  /** Stored value — the age in whole days, as a string ("0" = immediately). */
  value: string;
  /** Locale key for the human label shown in the dropdown. */
  labelKey: string;
};

/**
 * The ages offered in the "purge orphaned attendees older than…" dropdown,
 * in display order. Stored as day counts so the cut-off is plain subtraction;
 * "0" means "any age" (delete every orphan immediately).
 */
export const ORPHAN_RETENTION_OPTIONS: readonly OrphanRetentionOption[] = [
  { labelKey: "privacy.retention.immediately", value: "0" },
  { labelKey: "privacy.retention.6_months", value: "182" },
  { labelKey: "privacy.retention.1_year", value: "365" },
  { labelKey: "privacy.retention.2_years", value: "730" },
  { labelKey: "privacy.retention.3_years", value: "1095" },
  { labelKey: "privacy.retention.4_years", value: "1460" },
  { labelKey: "privacy.retention.5_years", value: "1825" },
];

/** Default retention when nothing is configured: 6 months. */
export const DEFAULT_ORPHAN_RETENTION = "182";

const ORPHAN_RETENTION_VALUES: ReadonlySet<string> = new Set(
  ORPHAN_RETENTION_OPTIONS.map((option) => option.value),
);

/** True when `value` is one of the allowed retention ages. */
export const isOrphanRetentionValue = (value: string): boolean =>
  ORPHAN_RETENTION_VALUES.has(value);

/**
 * Compute the ISO cut-off for a retention age: orphans whose `created` is
 * strictly before this are old enough to purge. "0" days yields the current
 * time, so every orphan qualifies (purge immediately). Falls back to the
 * default age when given an unrecognised value, so a stale/garbled setting can
 * never widen the deletion window.
 */
export const orphanRetentionCutoffIso = (
  value: string,
  nowMsValue: number,
): string => {
  const safeValue = isOrphanRetentionValue(value)
    ? value
    : DEFAULT_ORPHAN_RETENTION;
  const days = Number.parseInt(safeValue, 10);
  return new Date(nowMsValue - days * DAY_MS).toISOString();
};
