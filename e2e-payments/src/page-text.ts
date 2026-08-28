/**
 * Page-text assertions whose marker the label gate scans. A plain
 * `text.includes("Booking made")` says nothing to the gate. These calls
 * name the marker as catalog copy, so a rename fails its own PR instead of
 * the schedule-only nightly run. Assert text the app builds outside the
 * catalog with the plain string methods instead.
 */

/** Does the captured page text carry this catalog-rendered marker? */
export const pageTextIncludes = (text: string, marker: string): boolean =>
  text.includes(marker);

/** How many times the captured page text carries this marker. */
export const pageTextCount = (text: string, marker: string): number =>
  text.split(marker).length - 1;
