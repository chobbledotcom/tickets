import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { defineForm } from "#shared/forms.tsx";

describe("defineForm", () => {
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

  test("normalizes nullish parser output to null for optional fields", () => {
    const form = defineForm({
      fields: [
        {
          label: "Maybe",
          name: "maybe",
          parse: () => undefined as unknown as string | number | null,
          type: "text",
        },
      ] as const,
      id: "test",
    });

    const result = form.validate(new FormParams({ maybe: "value" }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.values.maybe).toBeNull();
  });
});
