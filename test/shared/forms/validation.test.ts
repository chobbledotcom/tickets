import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { validateForm } from "#shared/forms/validation.ts";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides }) as Field;

const requiredName: Field[] = [
  field({ label: "Name", name: "name", required: true }),
];

const dayCheckboxFields = (invalidMessage?: string): Field[] => [
  field({
    ...(invalidMessage === undefined ? {} : { invalidMessage }),
    label: "Days",
    name: "days",
    options: [
      { label: "Monday", value: "Monday" },
      { label: "Wednesday", value: "Wednesday" },
    ],
    type: "checkbox-group",
  }),
];

const colorSelectFields = (invalidMessage?: string): Field[] => [
  field({
    ...(invalidMessage === undefined ? {} : { invalidMessage }),
    label: "Color",
    name: "color",
    options: [{ label: "Red", value: "red" }],
    type: "select",
  }),
];

describe("validateForm", () => {
  beforeAll(() => ensureMessageGroups(["validation"]));

  test("rejects empty required field", () => {
    const result = validateForm(new FormParams({ name: "" }), requiredName);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Name is required");
  });

  test("rejects whitespace-only required field", () => {
    expect(
      validateForm(new FormParams({ name: "   " }), requiredName).valid,
    ).toBe(false);
  });

  test("passes required field with value and trims it", () => {
    const result = validateForm(
      new FormParams({ name: "  John  " }),
      requiredName,
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.name).toBe("John");
  });

  test("parses number field to a numeric value", () => {
    const fields: Field[] = [
      field({ label: "Qty", name: "qty", required: true, type: "number" }),
    ];
    const result = validateForm(new FormParams({ qty: "42" }), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.qty).toBe(42);
  });

  test("returns null for empty optional number", () => {
    const fields: Field[] = [
      field({ label: "Price", name: "price", type: "number" }),
    ];
    const result = validateForm(new FormParams({ price: "" }), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.price).toBeNull();
  });

  test("returns empty string for empty optional text", () => {
    const fields: Field[] = [field({ label: "Note", name: "note" })];
    const result = validateForm(new FormParams({ note: "" }), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.note).toBe("");
  });

  test("returns null for an empty optional select", () => {
    expect(validateForm(new FormParams(), colorSelectFields())).toEqual({
      valid: true,
      values: { color: null },
    });
  });

  test("runs custom validate function and surfaces its error", () => {
    const fields: Field[] = [
      field({
        label: "Code",
        name: "code",
        required: true,
        validate: (v) => (v.length !== 3 ? "Code must be 3 characters" : null),
      }),
    ];
    const result = validateForm(new FormParams({ code: "AB" }), fields);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Code must be 3 characters");
  });

  test("rejects a value longer than the field's maxlength", () => {
    const fields: Field[] = [
      field({ label: "Bio", maxlength: 5, name: "bio" }),
    ];
    const result = validateForm(new FormParams({ bio: "abcdef" }), fields);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Bio must be 5 characters or fewer");
    }
  });

  test("accepts a value exactly at the field's maxlength", () => {
    const fields: Field[] = [
      field({ label: "Bio", maxlength: 5, name: "bio" }),
    ];
    const result = validateForm(new FormParams({ bio: "abcde" }), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.bio).toBe("abcde");
  });

  test("rejects a non-empty value when maxlength is zero", () => {
    const result = validateForm(new FormParams({ bio: "x" }), [
      field({ label: "Bio", maxlength: 0, name: "bio" }),
    ]);
    expect(result).toEqual({
      error: "Bio must be 0 characters or fewer",
      valid: false,
    });
  });

  test("skips custom validate for empty optional field", () => {
    const fields: Field[] = [
      field({
        label: "Code",
        name: "code",
        validate: (v) => (v.length !== 3 ? "bad" : null),
      }),
    ];
    expect(validateForm(new FormParams({ code: "" }), fields).valid).toBe(true);
  });

  test("uses a field parser instead of the built-in value", () => {
    const fields: Field[] = [
      field({ label: "Code", name: "code", parse: () => "parsed" }),
    ];
    expect(validateForm(new FormParams({ code: "raw" }), fields)).toEqual({
      valid: true,
      values: { code: "parsed" },
    });
  });

  test("keeps an explicitly empty required message", () => {
    expect(
      validateForm(new FormParams(), [
        field({
          label: "Name",
          name: "name",
          required: true,
          requiredMessage: "",
        }),
      ]),
    ).toEqual({ error: "", valid: false });
  });

  test("keeps an explicitly empty invalid message", () => {
    expect(
      validateForm(new FormParams({ color: "blue" }), colorSelectFields("")),
    ).toEqual({ error: "", valid: false });
  });

  test("accepts a declared select value", () => {
    expect(
      validateForm(new FormParams({ color: "red" }), colorSelectFields()),
    ).toEqual({
      valid: true,
      values: { color: "red" },
    });
  });

  test("rejects an undeclared select value with the default message", () => {
    expect(
      validateForm(new FormParams({ color: "blue" }), colorSelectFields()),
    ).toEqual({ error: "Color is invalid.", valid: false });
  });

  test("rejects parsers that return unusable values", () => {
    for (const [name, parse] of [
      ["missing", () => null],
      ["infinite", () => Number.POSITIVE_INFINITY],
    ] as const) {
      expect(
        validateForm(new FormParams({ [name]: "value" }), [
          field({ label: name, name, parse }),
        ]),
      ).toEqual({ error: `${name} is invalid.`, valid: false });
    }
  });

  test("uses a default when the submitted value is empty", () => {
    const fields: Field[] = [
      field({ defaultValue: "fallback", label: "Code", name: "code" }),
    ];
    expect(validateForm(new FormParams(), fields)).toEqual({
      valid: true,
      values: { code: "fallback" },
    });
  });

  test("keeps a submitted value instead of its default", () => {
    const fields: Field[] = [
      field({ defaultValue: "fallback", label: "Code", name: "code" }),
    ];
    expect(validateForm(new FormParams({ code: "given" }), fields)).toEqual({
      valid: true,
      values: { code: "given" },
    });
  });

  test("collects checkbox-group values from multiple form entries", () => {
    const form = new FormParams();
    form.append("days", "Monday");
    form.append("days", "Wednesday");
    const result = validateForm(form, dayCheckboxFields());
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.days).toBe("Monday,Wednesday");
  });

  test("normalizes checkbox-group values to option order", () => {
    const form = new FormParams("days=Wednesday&days=Monday&days=Wednesday");

    expect(validateForm(form, dayCheckboxFields())).toEqual({
      valid: true,
      values: { days: "Monday,Wednesday" },
    });
  });

  test("rejects a bad checkbox value mixed into valid selections", () => {
    expect(
      validateForm(
        new FormParams("days=Monday&days=Funday&days=Wednesday"),
        dayCheckboxFields("Choose listed days only."),
      ),
    ).toEqual({ error: "Choose listed days only.", valid: false });
  });

  test("keeps an explicitly empty invalid checkbox message", () => {
    expect(
      validateForm(new FormParams("days=Funday"), dayCheckboxFields("")),
    ).toEqual({ error: "", valid: false });
  });

  test("keeps a custom validation error for a bad checkbox value", () => {
    const fields = dayCheckboxFields();
    fields[0]!.validate = () => "Choose a valid day.";
    expect(validateForm(new FormParams("days=Funday"), fields)).toEqual({
      error: "Choose a valid day.",
      valid: false,
    });
  });

  test("returns empty string for empty checkbox-group", () => {
    const fields: Field[] = [
      field({
        label: "Days",
        name: "days",
        options: [{ label: "Monday", value: "Monday" }],
        type: "checkbox-group",
      }),
    ];
    const result = validateForm(new FormParams(), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.days).toBe("");
  });

  test("rejects an empty required checkbox group", () => {
    const fields = dayCheckboxFields();
    fields[0]!.required = true;
    expect(validateForm(new FormParams(), fields)).toEqual({
      error: "Days is required",
      valid: false,
    });
  });

  test("runs checkbox-group validation on selected values", () => {
    const fields = dayCheckboxFields();
    fields[0]!.validate = () => "Days cannot be combined.";
    expect(
      validateForm(new FormParams("days=Monday&days=Wednesday"), fields),
    ).toEqual({ error: "Days cannot be combined.", valid: false });
  });

  test("does not run checkbox-group validation without a selection", () => {
    const fields = dayCheckboxFields();
    fields[0]!.validate = () => "Unexpected validation.";
    expect(validateForm(new FormParams(), fields)).toEqual({
      valid: true,
      values: { days: "" },
    });
  });

  test("skips file fields and returns null", () => {
    const fields: Field[] = [
      field({ label: "Image", name: "image", type: "file" }),
    ];
    const result = validateForm(new FormParams(), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.image).toBeNull();
  });

  describe("datetime type", () => {
    const datetimeField: Field[] = [
      field({ label: "Closes At", name: "closes_at", type: "datetime" }),
    ];

    test("combines date and time parts into a datetime string", () => {
      const result = validateForm(
        new FormParams({
          closes_at_date: "2099-06-15",
          closes_at_time: "14:30",
        }),
        datetimeField,
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.values.closes_at).toBe("2099-06-15T14:30");
      }
    });

    test("returns an empty string when both date and time are empty", () => {
      const result = validateForm(
        new FormParams({ closes_at_date: "", closes_at_time: "" }),
        datetimeField,
      );
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.values.closes_at).toBe("");
    });

    test("defaults time to 00:00 when only date is provided", () => {
      const result = validateForm(
        new FormParams({ closes_at_date: "2099-06-15", closes_at_time: "" }),
        datetimeField,
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.values.closes_at).toBe("2099-06-15T00:00");
      }
    });

    test("rejects time without date", () => {
      const result = validateForm(
        new FormParams({ closes_at_date: "", closes_at_time: "14:30" }),
        datetimeField,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe(
          "Please enter a date when providing a time, or leave both blank",
        );
      }
    });

    test("rejects empty required datetime", () => {
      const fields: Field[] = [
        field({
          label: "Closes At",
          name: "closes_at",
          required: true,
          type: "datetime",
        }),
      ];
      const result = validateForm(
        new FormParams({ closes_at_date: "", closes_at_time: "" }),
        fields,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toBe("Closes At is required");
    });
  });
});
