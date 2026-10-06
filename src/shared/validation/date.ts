import * as v from "valibot";

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
