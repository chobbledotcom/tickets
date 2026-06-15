import * as v from "valibot";

/**
 * Calendar-date validation — the single source of truth for "is this a real
 * day" in `YYYY-MM-DD` form across the app. Format is delegated to valibot's
 * `isoDate` action (a 4-digit year, month `01`–`12`, day `01`–`31`); the
 * trailing `check` additionally rejects rollover typos that share the format
 * but aren't real days — e.g. `2026-02-30`, which `Date` would silently roll
 * forward to March 2. valibot's `isoDate` already excludes out-of-range parts
 * (`2026-99-99`), so the round-tripped `Date` can never be invalid here.
 *
 * Mirrors the schema + isValidXxx shape of validation/email.ts as the rest of
 * the app's validation migrates to valibot.
 */
export const IsoDateSchema = v.pipe(
  v.string(),
  v.isoDate(),
  v.check(
    (value) =>
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    "Date is not a real calendar day",
  ),
);

/** Whether a string is a real calendar date in strict `YYYY-MM-DD` form. */
export const isIsoDate = (value: string): boolean => v.is(IsoDateSchema, value);
