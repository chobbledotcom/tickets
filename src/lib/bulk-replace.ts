/**
 * Pure string and date replacement logic for bulk actions.
 *
 * Used by both the server (to apply replacements when duplicating events)
 * and the client (to render a live preview of the same replacements).
 * Shared module must be browser-compatible: no runtime imports.
 */

/** Inputs describing a single find/replace pass over a group's events */
export interface DuplicateReplacements {
  /** Substring to find inside event names (empty → no name change) */
  nameFind: string;
  /** Substring to substitute for `nameFind` */
  nameReplace: string;
  /** Reference date (YYYY-MM-DD). Empty → no date shift. */
  dateFind: string;
  /** Target date (YYYY-MM-DD). Empty → no date shift. */
  dateReplace: string;
}

/** Preview of what a single event becomes after replacements are applied */
export interface DuplicatePreviewRow {
  id: number;
  originalName: string;
  newName: string;
  /** Original UTC ISO datetime, or empty string for events with no date */
  originalDate: string;
  /** Shifted UTC ISO datetime, or empty string for events with no date */
  newDate: string;
}

/** Event data needed to compute a preview row */
export interface PreviewableEvent {
  id: number;
  name: string;
  date: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * Apply a literal find/replace substitution to a name.
 * Uses split/join so every occurrence is replaced without regex escaping.
 * An empty `find` returns the original name unchanged.
 */
export const applyNameReplacement = (
  name: string,
  find: string,
  replace: string,
): string => (find ? name.split(find).join(replace) : name);

/** Parse a YYYY-MM-DD string to a UTC millisecond timestamp, or null if invalid */
const parseIsoDateToUtcMs = (value: string): number | null => {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
};

/**
 * Compute the day offset between `find` and `replace` dates (replace - find).
 * Returns 0 if either value is empty or unparseable.
 */
export const computeDayOffset = (find: string, replace: string): number => {
  const f = parseIsoDateToUtcMs(find);
  const r = parseIsoDateToUtcMs(replace);
  if (f === null || r === null) return 0;
  return Math.round((r - f) / MS_PER_DAY);
};

/**
 * Shift a UTC ISO datetime by a number of days.
 * Empty input or zero-offset returns the input unchanged.
 * Invalid ISO strings pass through unchanged.
 */
export const shiftUtcIsoByDays = (iso: string, days: number): string => {
  if (!iso || days === 0) return iso;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + days * MS_PER_DAY).toISOString();
};

/** Build preview rows for a list of events using the shared replacement rules */
export const buildDuplicatePreview = (
  events: readonly PreviewableEvent[],
  r: DuplicateReplacements,
): DuplicatePreviewRow[] => {
  const offset = computeDayOffset(r.dateFind, r.dateReplace);
  return events.map((e) => ({
    id: e.id,
    newDate: shiftUtcIsoByDays(e.date, offset),
    newName: applyNameReplacement(e.name, r.nameFind, r.nameReplace),
    originalDate: e.date,
    originalName: e.name,
  }));
};

/**
 * Format a UTC ISO datetime as "YYYY-MM-DD HH:MM" in the given timezone.
 * Browser-compatible (uses Intl via toLocaleString). Empty input → empty.
 * Mirrors the output of `formatDatetimeShortInTz` so server-rendered rows
 * and client-updated rows display identical strings.
 */
export const formatIsoForPreview = (iso: string, tz: string): string => {
  if (!iso) return "";
  const formatted = new Date(iso).toLocaleString("sv-SE", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: tz,
    year: "numeric",
  });
  return formatted.replace(/^(\d{4}-\d{2}-\d{2}) 24:/, "$1 00:");
};
