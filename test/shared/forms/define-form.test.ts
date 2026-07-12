import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { defineForm } from "#shared/forms/definition.ts";
import { testWithSetting } from "#test-utils/settings.ts";

describe("defineForm", () => {
  testWithSetting(
    "renders money fields with the active currency precision",
    { currency: "KWD" },
    () => {
      const form = defineForm({
        fields: [
          {
            label: "Amount",
            min: 0,
            name: "amount",
            required: true,
            type: "money",
          },
        ] as const,
        id: "money",
      });

      const html = form.render({ amount: "1.005" });
      expect(html).toContain('type="number"');
      expect(html).toContain('inputmode="decimal"');
      expect(html).toContain('step="0.001"');
      expect(html).toContain('value="1.005"');
    },
  );

  testWithSetting(
    "renders optional money fields with an explicit id",
    { currency: "GBP" },
    () => {
      const form = defineForm({
        fields: [
          {
            id: "refund-amount",
            label: "Amount",
            name: "amount",
            type: "money",
          },
        ] as const,
        id: "optional-money",
      });

      const html = form.render();
      expect(html).toContain('id="refund-amount"');
      expect(html).toContain('step="0.01"');
      expect(html).not.toContain(" required");
      expect(html).not.toContain(' min="');
    },
  );

  test("renders native datetime-local fields", () => {
    const form = defineForm({
      fields: [
        { label: "When", name: "when", type: "datetime-local" },
      ] as const,
      id: "datetime-local",
    });
    expect(form.render({ when: "2026-06-22T09:30" })).toContain(
      'type="datetime-local"',
    );
  });

  const formWithMessages = () =>
    defineForm({
      fields: [
        {
          invalidMessage: "Enter a whole amount.",
          label: "Amount",
          name: "amount",
          parse: (value: string) =>
            /^\d+$/.test(value) ? Number(value) : null,
          required: true,
          requiredMessage: "Enter an amount.",
          type: "money",
        },
      ] as const,
      id: "messages",
    });

  test("uses the schema message when a required value is missing", () => {
    const form = formWithMessages();
    expect(form.validate(new FormParams({ amount: "" }))).toEqual({
      error: "Enter an amount.",
      valid: false,
    });
  });

  test("uses the schema message when a parsed value is invalid", () => {
    const form = formWithMessages();
    expect(form.validate(new FormParams({ amount: "1.5" }))).toEqual({
      error: "Enter a whole amount.",
      valid: false,
    });
  });

  test("uses a default message when a non-empty value parses to null", () => {
    const form = defineForm({
      fields: [
        {
          label: "Amount",
          name: "amount",
          parse: () => null,
          type: "money",
        },
      ] as const,
      id: "null-result",
    });

    expect(form.validate(new FormParams({ amount: "12" }))).toEqual({
      error: "Amount is invalid.",
      valid: false,
    });
  });

  test("rejects a non-finite parsed number", () => {
    const form = defineForm({
      fields: [
        {
          label: "Amount",
          name: "amount",
          parse: () => Number.NaN,
          type: "money",
        },
      ] as const,
      id: "non-finite-result",
    });

    expect(form.validate(new FormParams({ amount: "not-a-number" }))).toEqual({
      error: "Amount is invalid.",
      valid: false,
    });
  });

  test("renders select option hints from the field schema", () => {
    const form = defineForm({
      fields: [
        {
          label: "Action",
          name: "action",
          options: [
            { hint: "Use cash.", label: "Payment", value: "pay" },
            { label: "Charge", value: "charge" },
          ],
          type: "select",
        },
      ] as const,
      id: "option-hints",
    });
    const html = form.render();
    expect(html).toContain("<strong>Payment:</strong> Use cash.");
    expect(html).not.toContain("<strong>Charge:</strong>");
  });

  test("validates and parses typed values", () => {
    const form = defineForm({
      fields: [
        {
          label: "Age",
          name: "age",
          parse: (value) => Number.parseInt(value, 10),
          required: true,
          type: "number",
        },
      ] as const,
      id: "test",
    });

    const result = form.validate(new FormParams({ age: "25" }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.age).toBe(25);
  });

  test("render returns fields HTML", () => {
    const form = defineForm({
      fields: [
        { label: "Name", name: "name", required: true, type: "text" },
      ] as const,
      id: "test",
    });

    const html = form.render({ name: "Alice" });
    expect(html).toContain("Alice");
    expect(html).toContain('name="name"');
  });

  test("field render returns single field HTML", () => {
    const form = defineForm({
      fields: [{ label: "Color", name: "color", type: "text" }] as const,
      id: "test",
    });

    const html = form.field("color").render("blue");
    expect(html).toContain("blue");
  });

  test("optional select field normalizes empty string to null", () => {
    const form = defineForm({
      fields: [
        {
          label: "Date",
          name: "date",
          options: [{ label: "Select", value: "" }],
          type: "select",
        },
      ] as const,
      id: "test",
    });

    const result = form.validate(new FormParams({ date: "" }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.date).toBeNull();
  });

  test("optional number field preserves numeric value", () => {
    const form = defineForm({
      fields: [
        {
          label: "Qty",
          name: "qty",
          type: "number",
        },
      ] as const,
      id: "test",
    });

    const result = form.validate(new FormParams({ qty: "5" }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.qty).toBe(5);
  });

  test("optional number field preserves a zero value (not coerced to null)", () => {
    const form = defineForm({
      fields: [{ label: "Qty", name: "qty", type: "number" }] as const,
      id: "test",
    });

    const result = form.validate(new FormParams({ qty: "0" }));
    expect(result.valid).toBe(true);
    // 0 is a real value: it must survive the `?? null` normalisation rather
    // than being treated as "missing" (which `|| null` would do).
    if (result.valid) expect(result.values.qty).toBe(0);
  });

  test("rejects trailing text in a number field", () => {
    const form = defineForm({
      fields: [{ label: "Quantity", name: "qty", type: "number" }] as const,
      id: "strict-number",
    });

    expect(form.validate(new FormParams({ qty: "5abc" }))).toEqual({
      error: "Quantity is invalid.",
      valid: false,
    });
  });

  test("preserves a decimal number instead of truncating it", () => {
    const form = defineForm({
      fields: [{ label: "Value", name: "value", type: "number" }] as const,
      id: "decimal-number",
    });

    expect(form.validate(new FormParams({ value: "1.5" }))).toEqual({
      valid: true,
      values: { value: 1.5 },
    });
  });

  test("runs custom validate when provided", () => {
    const form = defineForm({
      fields: [
        { label: "Code", name: "code", required: true, type: "text" },
      ] as const,
      id: "test",
      validate: (values) => (values.code === "secret" ? null : "Invalid code"),
    });

    const fail = form.validate(new FormParams({ code: "wrong" }));
    expect(fail.valid).toBe(false);
    if (!fail.valid) expect(fail.error).toBe("Invalid code");

    const pass = form.validate(new FormParams({ code: "secret" }));
    expect(pass.valid).toBe(true);
  });

  test("returns base validation error without running custom validate", () => {
    const form = defineForm({
      fields: [
        { label: "Name", name: "name", required: true, type: "text" },
      ] as const,
      id: "test",
      validate: () => "should not run",
    });

    const result = form.validate(new FormParams({ name: "" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe("Name is required");
  });
});
