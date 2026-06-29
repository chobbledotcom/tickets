import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { type Field, validateForm } from "#shared/forms.tsx";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides });

const requiredName: Field[] = [
  field({ label: "Name", name: "name", required: true }),
];

describe("validateForm", () => {
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

  test("collects checkbox-group values from multiple form entries", () => {
    const fields: Field[] = [
      field({ label: "Days", name: "days", type: "checkbox-group" }),
    ];
    const form = new FormParams();
    form.append("days", "Monday");
    form.append("days", "Wednesday");
    const result = validateForm(form, fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.days).toBe("Monday,Wednesday");
  });

  test("returns empty string for empty checkbox-group", () => {
    const fields: Field[] = [
      field({ label: "Days", name: "days", type: "checkbox-group" }),
    ];
    const result = validateForm(new FormParams(), fields);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.days).toBe("");
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

    test("returns null when both date and time are empty", () => {
      const result = validateForm(
        new FormParams({ closes_at_date: "", closes_at_time: "" }),
        datetimeField,
      );
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.values.closes_at).toBeNull();
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
