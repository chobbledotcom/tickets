import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import { FormParams } from "#shared/form-data.ts";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount-hint.ts";
import type { FormField, ShownField } from "#shared/rest/field-specs.ts";
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

  test("a switch is the status page's one-option checkbox group", () => {
    const [box] = fieldsForm([
      {
        exclusive: {
          other: "isPaidDefault",
          why: "statuses.error_paid_default_reservation",
        },
        key: "isReservation",
        kind: "switch",
        label: "statuses.form_reservation_checkbox",
      },
    ] as const satisfies readonly FormField[])().fields;
    expect(box).toEqual({
      exclusive: {
        other: "isPaidDefault",
        why: t("statuses.error_paid_default_reservation"),
      },
      label: "",
      name: "isReservation",
      options: [
        {
          label: t("statuses.form_reservation_checkbox"),
          value: "1",
        },
      ],
      type: "checkbox-group",
    });
  });

  test("a text box joins its literal hint prefix to the translated hint", () => {
    const [box] = fieldsForm([
      {
        default: "0",
        hint: "statuses.form_reservation_amount_hint",
        hintPrefix: RESERVATION_AMOUNT_HINT,
        key: "reservationAmount",
        kind: "text",
        label: "statuses.form_reservation_amount_label",
      },
    ] as const satisfies readonly FormField[])().fields;
    expect(box).toEqual({
      defaultValue: "0",
      hint: `${RESERVATION_AMOUNT_HINT}${t(
        "statuses.form_reservation_amount_hint",
      )}`,
      label: t("statuses.form_reservation_amount_label"),
      name: "reservationAmount",
      required: false,
      type: "text",
    });
  });

  test("a required box keeps the field's own refusal", () => {
    const form = fieldsForm([
      {
        key: "name",
        kind: "name",
        label: "common.name",
        requiredMessageKey: "statuses.name_required",
      },
    ] as const satisfies readonly FormField[])();
    expect(form.validate(new FormParams({ name: "" }))).toEqual({
      error: "Please enter a name",
      valid: false,
    });
  });
});
