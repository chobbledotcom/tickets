/**
 * Pure string and date replacement logic for bulk actions.
 *
 * Used by both the server (to apply replacements when duplicating listings)
 * and the client (to render a live preview of the same replacements).
 * Shared module must be browser-compatible: no runtime imports.
 */

/** Inputs describing a single find/replace pass over a group's listings */
export interface DuplicateReplacements {
  /** Reference date (YYYY-MM-DD). Empty → no date shift. */
  dateFind: string;
  /** Target date (YYYY-MM-DD). Empty → no date shift. */
  dateReplace: string;
  /** Substring to find inside listing names (empty → no name change) */
  nameFind: string;
  /** Substring to substitute for `nameFind` */
  nameReplace: string;
}

/** Preview of what a single listing becomes after replacements are applied */
export interface DuplicatePreviewRow {
  id: number;
  /** Shifted UTC ISO datetime, or empty string for listings with no date */
  newDate: string;
  newName: string;
  /** Original UTC ISO datetime, or empty string for listings with no date */
  originalDate: string;
  originalName: string;
}

/** Listing data needed to compute a preview row */
export interface PreviewableListing {
  date: string;
  id: number;
  name: string;
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

/**
 * Compute the day offset between `find` and `replace` dates (replace - find).
 * Both must be YYYY-MM-DD strings from a `<input type="date">`. Empty values
 * short-circuit to 0 (no shift).
 */
export const computeDayOffset = (find: string, replace: string): number => {
  if (!find || !replace) return 0;
  return Math.round((Date.parse(replace) - Date.parse(find)) / MS_PER_DAY);
};

/**
 * Shift a UTC ISO datetime by a number of days.
 * Empty input or zero offset returns the input unchanged.
 */
export const shiftUtcIsoByDays = (iso: string, days: number): string => {
  if (!iso || days === 0) return iso;
  return new Date(Date.parse(iso) + days * MS_PER_DAY).toISOString();
};

/** Build preview rows for a list of listings using the shared replacement rules */
export const buildDuplicatePreview = (
  listings: readonly PreviewableListing[],
  r: DuplicateReplacements,
): DuplicatePreviewRow[] => {
  const offset = computeDayOffset(r.dateFind, r.dateReplace);
  return listings.map((e) => ({
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
