import * as v from "valibot";

/**
 * Calendar-date validation — the single source of truth for "is this a real
 * day" in `YYYY-MM-DD` form across the app. Format is delegated to valibot's
 * `isoDate` action (a 4-digit year, month `01`–`12`, day `01`–`31`); the
 * real-day check below additionally rejects rollover typos that share the
 * format but aren't real days — e.g. `2026-02-30`, which `Date` would silently
 * roll forward to March 2.
 *
 * Mirrors the schema + isValidXxx shape of validation/email.ts as the rest of
 * the app's validation migrates to valibot.
 */

/** Whether a `YYYY-MM-DD` string round-trips through a UTC `Date` as the same
 * day — so it names a real calendar day, not a rollover impossibility like
 * `2026-02-30` that `Date` would silently normalise. Safe on any string: an
 * unparseable value is `NaN`, never a real day. */
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

/** Parse a date that a checked boundary has already cleaned — a stored value
 *  or a validated form value. A stored date the rule refuses is an
 *  impossible state. Name where it came from and stop loudly. */
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

/**
 * A calendar month in strict `YYYY-MM` form, month `01`–`12` — the shape the
 * date pickers round-trip as their paged-month query param. valibot has no
 * `isoMonth` action, so the format lives in one regex here rather than being
 * re-spelt (more laxly — a bare `\d{2}` month accepts `00` and `99`) at each
 * query-string boundary.
 */
export const IsoMonthSchema = v.pipe(
  v.string(),
  v.regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM"),
);

/** Whether a string is a calendar month in strict `YYYY-MM` form. */
export const isIsoMonth = (value: string): boolean =>
  v.is(IsoMonthSchema, value);
