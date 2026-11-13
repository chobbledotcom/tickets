/** The holiday fields: the stored row, the write input, the API bodies, the
 *  form, and the list columns all derive from this one list. */

import type { ShownField } from "#shared/rest/field-specs.ts";

/* jscpd:ignore-start -- a list of strings, not code */
export const HOLIDAY_FIELDS = [
  {
    header: "common.name",
    key: "name",
    kind: "name",
    label: "fields.holiday.name",
    placeholder: "fields.holiday.name_placeholder",
  },
  {
    header: "holidays.col.start_date",
    key: "start_date",
    kind: "date",
    label: "fields.holiday.start_date",
  },
  {
    header: "holidays.col.end_date",
    hint: "fields.holiday.end_date_hint",
    key: "end_date",
    kind: "date",
    label: "fields.holiday.end_date",
  },
] as const satisfies readonly ShownField[];
/* jscpd:ignore-end */
