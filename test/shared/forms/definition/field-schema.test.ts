import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { defineForm } from "#shared/forms/definition.ts";
import type { Field } from "#shared/forms/field.ts";
import { renderField } from "#shared/forms/rendering.tsx";
import { ensureMessageGroups } from "#shared/i18n.ts";

const singleActionSelect = (invalidMessage?: string) =>
  defineForm({
    fields: [
      {
        ...(invalidMessage === undefined ? {} : { invalidMessage }),
        label: "Action",
        name: "action",
        options: [{ label: "Pay", value: "pay" }],
        type: "select",
      },
    ] as const,
  });

describe("form field schema", () => {
  beforeAll(() => ensureMessageGroups(["validation"]));

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
    });

    expect(form.validate(new FormParams({ action: "refund" }))).toEqual({
      error: "Choose a listed action.",
      valid: false,
    });
  });

  test("uses the shared invalid message when a choice has no custom message", () => {
    const form = singleActionSelect();

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
    });

    const result = form.validate(new FormParams({ action: "pay" }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      const action: "pay" | "charge" | null = result.values.action;
      expect(action).toBe("pay");
    }
  });

  test("normalizes an empty select value to null", () => {
    const form = singleActionSelect();

    expect(form.validate(new FormParams())).toEqual({
      valid: true,
      values: { action: null },
    });
  });

  test("requires options when declaring a select field", () => {
    const acceptField = (_field: Field): void => {};
    // @ts-expect-error A select without options is not a valid Field.
    acceptField({ label: "Action", name: "action", type: "select" });
    acceptField({
      label: "Action",
      name: "action",
      // @ts-expect-error A select must offer at least one option.
      options: [],
      type: "select",
    });
    const valid = {
      label: "Action",
      name: "action",
      options: [{ label: "Pay", value: "pay" }],
      type: "select",
    } as const satisfies Field;
    expect(renderField(valid)).toContain("<select");
  });

  test("throws when defining a select with an empty option list", () => {
    const defineEmptySelect = () =>
      defineForm({
        fields: [
          {
            label: "Action",
            name: "action",
            options: [],
            type: "select",
          } as unknown as Field,
        ] as const,
      });

    expect(defineEmptySelect).toThrow("Action must define at least one option");
  });

  test("rejects checkbox choices submitted as one comma-separated token", () => {
    const form = defineForm({
      fields: [
        {
          label: "Days",
          name: "days",
          options: [
            { label: "Monday", value: "Monday" },
            { label: "Wednesday", value: "Wednesday" },
          ],
          type: "checkbox-group",
        },
      ] as const,
    });

    expect(
      form.validate(new FormParams({ days: "Monday, Wednesday" })),
    ).toEqual({
      error: "Days is invalid.",
      valid: false,
    });
  });

  test("rejects ambiguous checkbox option values when defining a form", () => {
    for (const value of ["one,two", "", " padded "]) {
      expect(() =>
        defineForm({
          fields: [
            {
              label: "Tags",
              name: "tags",
              options: [{ label: "Tag", value }],
              type: "checkbox-group",
            },
          ] as const,
        }),
      ).toThrow(
        "Tags checkbox option values must be trimmed, non-empty, and contain no commas",
      );
    }
  });

  test("rejects empty tokens in comma-separated checkbox choices", () => {
    const form = defineForm({
      fields: [
        {
          label: "Tags",
          name: "tags",
          options: [
            { label: "One", value: "one" },
            { label: "Two", value: "two" },
          ],
          type: "checkbox-group",
        },
      ] as const,
    });

    expect(form.validate(new FormParams({ tags: "one,,two" }))).toEqual({
      error: "Tags is invalid.",
      valid: false,
    });
  });

  test("renders fields by their typed section id", () => {
    const form = defineForm({
      fields: [
        { label: "Name", name: "name", section: "main", type: "text" },
        { label: "Summary", name: "summary", type: "text" },
        {
          label: "Private",
          name: "private",
          section: "advanced",
          type: "text",
          visible: false,
        },
      ] as const,
    });
    const rejectUnknownSection = () => {
      // @ts-expect-error Section ids come from the field declarations.
      form.section("missing");
    };

    expect(form.sections).toEqual(["main", "advanced"]);
    expect(form.section("main")).toContain('name="name"');
    expect(form.section("main")).not.toContain('name="summary"');
    expect(form.section("advanced")).not.toContain('name="private"');
    expect(rejectUnknownSection).toThrow("Unknown section: missing");
  });

  test("throws when a field lookup uses an unknown name", () => {
    const form = defineForm({
      fields: [{ label: "Name", name: "name", type: "text" }] as const,
    });
    const renderUnknownField = () => {
      // @ts-expect-error Field names come from the field declarations.
      form.renderField("missing");
    };

    expect(renderUnknownField).toThrow("Unknown field: missing");
  });

  test("renders an omitted field value as blank", () => {
    const form = defineForm({
      fields: [{ label: "Name", name: "name", type: "text" }] as const,
    });

    expect(form.renderField("name")).not.toContain("value=");
  });
});
