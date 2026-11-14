import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";

/** One holiday field as the form and the list show it. */
const readableField = (field: (typeof HOLIDAY_FIELDS)[number]) => ({
  header: t(field.header),
  hint: "hint" in field ? t(field.hint) : null,
  key: field.key,
  kind: field.kind,
  label: t(field.label),
  placeholder: "placeholder" in field ? t(field.placeholder) : null,
});

describe("the holiday fields", () => {
  test("name each field with the words the form and the list show", () => {
    expect(HOLIDAY_FIELDS.map(readableField)).toEqual([
      {
        header: "Name",
        hint: null,
        key: "name",
        kind: "name",
        label: "Holiday name",
        placeholder: "Bank holiday",
      },
      {
        header: "Start date",
        hint: null,
        key: "start_date",
        kind: "date",
        label: "Start date",
        placeholder: null,
      },
      {
        header: "End date",
        hint: "Must be on or after the start date",
        key: "end_date",
        kind: "date",
        label: "End date",
        placeholder: null,
      },
    ]);
  });
});
