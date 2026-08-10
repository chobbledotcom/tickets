/**
 * Shared iCalendar (RFC 5545) text helpers. One home for the escaping and date
 * formatting so the public listings feed (`src/features/feeds.ts`) and the
 * CalDAV mirror (`src/shared/caldav/`) speak exactly the same ICS vocabulary.
 */

/**
 * Escape text for an ICS content line. Line breaks are normalized to `\n`
 * first — a stored value with Windows `\r\n` (or a bare `\r`) would otherwise
 * leak a raw carriage return into the output, which some calendar servers
 * reject as malformed.
 */
export const escapeIcs = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");

/** Format a date string as an ICS UTC timestamp (YYYYMMDDTHHMMSSZ). */
export const formatIcsDate = (dateStr: string): string =>
  new Date(dateStr)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/**
 * Append the shared DTSTART/LOCATION lines for anything carrying a date and a
 * location — feed items and mirrored listing events alike.
 */
export const appendItemSchedule = (
  lines: string[],
  item: { date: string | null; location: string },
): void => {
  if (item.date) lines.push(`DTSTART:${formatIcsDate(item.date)}`);
  if (item.location) lines.push(`LOCATION:${escapeIcs(item.location)}`);
};
