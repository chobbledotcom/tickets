import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import { FormParams } from "#shared/form-data.ts";
import type { ShownField } from "#shared/rest/field-specs.ts";
import { fieldsForm } from "#templates/fields/record-fields.ts";
import { validateDate } from "#templates/fields/validators.ts";

await ensureMessageGroups(MESSAGE_GROUPS);

const FIELDS = [
  {
    header: "common.name",
    key: "title",
    kind: "name",
    label: "fields.holiday.name",
    placeholder: "fields.holiday.name_placeholder",
  },
  {
    header: "holidays.col.end_date",
    hint: "fields.holiday.end_date_hint",
    key: "ends",
    kind: "date",
    label: "fields.holiday.end_date",
  },
] as const satisfies readonly ShownField[];

describe("fieldsForm", () => {
  test("builds one required box per field, in declaration order", () => {
    expect(fieldsForm(FIELDS)().fields).toEqual([
      {
        label: "Holiday name",
        name: "title",
        placeholder: "Bank holiday",
        required: true,
        type: "text",
      },
      {
        hint: "Must be on or after the start date",
        label: "End date",
        name: "ends",
        required: true,
        type: "date",
        validate: validateDate,
      },
    ]);
  });

  test("gives a box only the texts and rule its field declares", () => {
    const boxKeys = fieldsForm(FIELDS)().fields.map((box) =>
      Object.keys(box).sort(),
    );
    expect(boxKeys).toEqual([
      ["label", "name", "placeholder", "required", "type"],
      ["hint", "label", "name", "required", "type", "validate"],
    ]);
  });

  test("a date box refuses text that is not a date", () => {
    const form = fieldsForm(FIELDS)();
    const refused = form.validate(
      new FormParams({ ends: "soon", title: "Fair" }),
    );
    expect(refused).toEqual({
      error: "Please enter a valid date (YYYY-MM-DD)",
      valid: false,
    });
    const accepted = form.validate(
      new FormParams({ ends: "2026-01-02", title: "Fair" }),
    );
    expect(accepted).toEqual({
      valid: true,
      values: { ends: "2026-01-02", title: "Fair" },
    });
  });
});
