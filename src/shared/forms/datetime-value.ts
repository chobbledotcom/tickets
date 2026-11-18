/** The datetime composition at the form boundary, kept pure so the coverage
 *  merger sees it exercised from one isolate. */

import type { FormParams } from "#shared/form-data.ts";
import { datetimePartNames } from "#shared/forms/datetime-parts.ts";
import { parseDateString } from "#shared/validation/date-string.ts";

/** Read one datetime field's submitted date and time parts.
 *
 *  - Both parts present: the date half is cleaned at the boundary and the
 *    parts compose.
 *  - A date without a time: the time defaults to midnight.
 *  - A time without a date: the partial the schema reports.
 *  - An unusable date half: composes raw, so the field's own validate hook
 *    reports its message.
 */
export const getDatetimeValue = (
  form: FormParams,
  name: string,
): string | null => {
  const parts = datetimePartNames(name);
  const date = form.getString(parts.date);
  const time = form.getString(parts.time);
  if (!date) return time ? null : "";
  const cleaned = parseDateString(date) ?? date;
  return time ? `${cleaned}T${time}` : `${cleaned}T00:00`;
};
