import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { defineForm } from "#shared/forms/definition.ts";
import { type Field, renderField } from "#shared/forms.tsx";

describe("form field schema", () => {
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

  test("rejects a select value outside its declared options", () => {
    const form = defineForm({
      fields: [
        {
          invalidMessage: "Choose a listed action.",
          label: "Action",
          name: "action",
          options: [
            { label: "Pay", value: "pay" },
            { label: "Charge", value: "charge" },
          ],
          type: "select",
        },
      ] as const,
      id: "select-validation",
    });

    expect(form.validate(new FormParams({ action: "refund" }))).toEqual({
      error: "Choose a listed action.",
      valid: false,
    });
  });

  test("uses the shared invalid message when a choice has no custom message", () => {
    const form = defineForm({
      fields: [
        {
          label: "Action",
          name: "action",
          options: [{ label: "Pay", value: "pay" }],
          type: "select",
        },
      ] as const,
      id: "default-choice-message",
    });

    expect(form.validate(new FormParams({ action: "refund" }))).toEqual({
      error: "Action is invalid.",
      valid: false,
    });
  });

  test("derives a select value union from its options", () => {
    const form = defineForm({
      fields: [
        {
          label: "Action",
          name: "action",
          options: [
            { label: "Pay", value: "pay" },
            { label: "Charge", value: "charge" },
          ],
          type: "select",
        },
      ] as const,
      id: "select-values",
    });

    const result = form.validate(new FormParams({ action: "pay" }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      const action: "pay" | "charge" | null = result.values.action;
      expect(action).toBe("pay");
    }
  });

  test("requires options when declaring a select field", () => {
    const acceptField = (_field: Field): void => {};
    // @ts-expect-error A select without options is not a valid Field.
    acceptField({ label: "Action", name: "action", type: "select" });
    const valid = {
      label: "Action",
      name: "action",
      options: [{ label: "Pay", value: "pay" }],
      type: "select",
    } as const satisfies Field;
    expect(renderField(valid)).toContain("<select");
  });

  test("throws when a select has an empty option list", () => {
    const form = defineForm({
      fields: [
        { label: "Action", name: "action", options: [], type: "select" },
      ] as const,
      id: "empty-select",
    });
    expect(() => form.validate(new FormParams({ action: "pay" }))).toThrow(
      "Action must define at least one option",
    );
  });

  test("renders fields by their typed section id", () => {
    const form = defineForm({
      fields: [
        { label: "Name", name: "name", section: "main", type: "text" },
        {
          label: "Private",
          name: "private",
          section: "advanced",
          type: "text",
          visible: false,
        },
      ] as const,
      id: "sections",
    });
    const rejectUnknownSection = () => {
      // @ts-expect-error Section ids come from the field declarations.
      form.section("missing");
    };

    expect(form.sections).toEqual(["main", "advanced"]);
    expect(form.section("main")).toContain('name="name"');
    expect(form.section("advanced")).not.toContain('name="private"');
    expect(typeof rejectUnknownSection).toBe("function");
  });

  test("throws when a field lookup uses an unknown name", () => {
    const form = defineForm({
      fields: [{ label: "Name", name: "name", type: "text" }] as const,
      id: "field-lookup",
    });
    const renderUnknownField = () => {
      // @ts-expect-error Field names come from the field declarations.
      form.field("missing").render();
    };

    expect(renderUnknownField).toThrow("Unknown field: missing");
  });

  test("renders omitted and null field values as blank", () => {
    const form = defineForm({
      fields: [{ label: "Name", name: "name", type: "text" }] as const,
      id: "blank-field",
    });

    expect(form.field("name").render()).not.toContain("value=");
    expect(form.field("name").render(null)).not.toContain("value=");
  });
});
