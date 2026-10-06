import * as v from "valibot";

/**
 * Calendar-date parsing — the single source of truth for "is this a real
 * day" in `YYYY-MM-DD` form across the app. Format is delegated to valibot's
 * `isoDate` action, which asks for a 4-digit year, a month from `01` to `12`,
 * and a day from `01` to `31`. The real-day check below additionally rejects
 * rollover typos that share the format but do not name real days. An example
 * is `2026-02-30`, which `Date` silently rolls forward to March 2.
 *
 * Mirrors the schema + isValidXxx shape of validation/email.ts as the rest of
 * the app's validation migrates to valibot.
 */

/** Whether a `YYYY-MM-DD` string round-trips through a UTC `Date` as the same
 * day. The round trip holds only when the value names a real calendar day.
 * `Date` silently normalises a rollover value such as `2026-02-30`. Safe on
 * any string: an unparseable value is `NaN`, never a real day. */
export const isRealCalendarDay = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

export const IsoDateSchema = v.pipe(
  v.string(),
  v.isoDate(),
  v.check(isRealCalendarDay, "Date is not a real calendar day"),
);

/** Whether a string is a real calendar date in strict `YYYY-MM-DD` form. */
export const isIsoDate = (value: string): boolean => v.is(IsoDateSchema, value);

declare const dateBrand: unique symbol;

/** A `YYYY-MM-DD` string that passed the real-calendar-day check. The brand
 *  is the compile-level half of the cleanup. Every helper that consumes a
 *  date — comparisons, storage, normalisation — takes a `DateString`, so a
 *  caller that skips the parser cannot type-check. */
export type DateString = string & { readonly [dateBrand]: "DateString" };

/** Clean one raw date value at a boundary: trim the whitespace around it,
 *  then demand the strict real-calendar-day shape. Null means the value is
 *  unusable and the surface reports its own field-named message. */
export const parseDateString = (raw: string): DateString | null => {
  const value = raw.trim();
  if (!v.is(IsoDateSchema, value)) return null;
  return value as DateString;
};

/** Parse a date that a checked boundary has already cleaned — a validated
 *  form value. A value the rule refuses stops loudly: name where it came
 *  from. */
export const parseDateStringOrThrow = (
  raw: string,
  what: string,
): DateString => {
  const parsed = parseDateString(raw);
  if (parsed === null) {
    throw new Error(`${what} does not hold a usable date: ${raw}`);
  }
  return parsed;
};

/** The unpadded-ISO repair of the pre-2476 mapper's stored dates, or null
 *  when the value is not that shape. */
const padLegacyDateParts = (raw: string): string | null => {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  return parts === null
    ? null
    : `${parts[1]}-${parts[2]!.padStart(2, "0")}-${parts[3]!.padStart(2, "0")}`;
};

/** Parse a stored date as a read fallback. The pre-2476 mapper stored
 *  supplied strings without validation, so legacy rows can hold unpadded
 *  dates whose parts are unambiguous: "2027-6-1" names June the first. One
 *  bounded repair pads those parts and re-runs the strict rule. A value the
 *  rule still refuses stops loudly: the repair must not guess. */
export const parseStoredDateString = (
  raw: string,
  what: string,
): DateString => {
  const repaired = padLegacyDateParts(raw);
  return parseDateString(repaired ?? raw) ?? parseDateStringOrThrow(raw, what);
};

/** Whether a value is a UTC instant of a real calendar day — the shape the
 *  listing datetime columns store. The whole value must match. The date half
 *  answers to the shared real-day rule. The clock half allows hours 00–23
 *  and minutes 00–59, with optional seconds and a fractional part, before
 *  the zone designator. A value with no zone designator is refused rather
 *  than silently read as local time. A fractional second needs the seconds:
 *  `10:00.1Z` names no instant `Date` can read. */
export const isUtcInstantOfRealDay = (value: string): boolean => {
  const [datePart = "", timePart = "", surplus] = value.split("T");
  if (surplus !== undefined) return false;
  return (
    isIsoDate(datePart) &&
    /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?Z$/.test(timePart)
  );
};
