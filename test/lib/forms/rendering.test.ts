import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  clearSavedFormData,
  type Field,
  renderField,
  renderFields,
  setSavedFormData,
} from "#shared/forms.tsx";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides });

const rendered = (
  overrides: Partial<Field> & { name: string; label: string },
  value?: string,
): string => renderField(field(overrides), value);

describe("renderField", () => {
  test("renders text input with label", () => {
    const html = rendered({ label: "Username", name: "username" });
    expect(html).toContain("<label>");
    expect(html).toContain("Username");
    expect(html).toContain('type="text"');
    expect(html).toContain('name="username"');
  });

  test("renders required attribute", () => {
    const html = rendered({
      label: "Email",
      name: "email",
      required: true,
      type: "email",
    });
    expect(html).toContain("required");
  });

  test("renders placeholder", () => {
    const html = rendered({
      label: "Name",
      name: "name",
      placeholder: "Enter your name",
    });
    expect(html).toContain('placeholder="Enter your name"');
  });

  test("marks a markdown textarea for preview, plain textarea is not marked", () => {
    const withPreview = rendered({
      label: "Bio",
      markdown: true,
      name: "bio",
      type: "textarea",
    });
    expect(withPreview).toContain("data-markdown-preview");

    const plain = rendered({ label: "Bio", name: "bio", type: "textarea" });
    expect(plain).not.toContain("data-markdown-preview");
  });

  test("renders a checkbox group only for the checkbox-group type", () => {
    // A non-checkbox field that happens to carry options must still render its
    // normal input — the checkbox-group branch is gated on the type, not just
    // the presence of options.
    const html = rendered({
      label: "Name",
      name: "name",
      options: [{ label: "A", value: "a" }],
      type: "text",
    });
    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="checkbox"');
  });

  test("renders hint text", () => {
    const html = rendered({
      hint: "Minimum 8 characters",
      label: "Password",
      name: "pw",
      type: "password",
    });
    expect(html).toContain("Minimum 8 characters");
    expect(html).toContain("<small");
  });

  test("renders hintHtml as raw HTML", () => {
    const html = rendered({
      hintHtml: '<a href="/guide">Help</a>',
      label: "Description",
      name: "desc",
    });
    expect(html).toContain('<a href="/guide">Help</a>');
    expect(html).toContain("<small");
  });

  test("renders min attribute for number", () => {
    const html = rendered({
      label: "Quantity",
      min: 1,
      name: "qty",
      type: "number",
    });
    expect(html).toContain('min="1"');
  });

  test("renders pattern attribute", () => {
    const html = rendered({ label: "Code", name: "code", pattern: "[A-Z]{3}" });
    expect(html).toContain('pattern="[A-Z]{3}"');
  });

  test("renders maxlength attribute", () => {
    const html = rendered({
      label: "Description",
      maxlength: 128,
      name: "desc",
    });
    expect(html).toContain('maxlength="128"');
  });

  test("renders autocomplete when provided, omits when absent", () => {
    expect(
      rendered({ autocomplete: "name", label: "Name", name: "name" }),
    ).toContain('autocomplete="name"');
    expect(rendered({ label: "Name", name: "name" })).not.toContain(
      "autocomplete",
    );
  });

  test("renders textarea for textarea type", () => {
    const html = rendered({
      label: "Description",
      name: "description",
      type: "textarea",
    });
    expect(html).toContain("<textarea");
    expect(html).not.toContain("<input");
  });

  test("renders value when provided", () => {
    expect(rendered({ label: "Name", name: "name" }, "John")).toContain(
      'value="John"',
    );
  });

  test("escapes HTML in value", () => {
    const html = rendered(
      { label: "Name", name: "name" },
      '<script>alert("xss")</script>',
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("renders textarea with value", () => {
    const html = rendered(
      { label: "Description", name: "description", type: "textarea" },
      "Some description",
    );
    expect(html).toContain(">Some description</textarea>");
  });

  describe("select type", () => {
    const colorSelect: Field = {
      label: "Color",
      name: "color",
      options: [
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
      ],
      type: "select",
    };

    test("renders select element with options", () => {
      const html = renderField(colorSelect);
      expect(html).toContain("<select");
      expect(html).toContain('name="color"');
      expect(html).toContain(">Red</option>");
      expect(html).toContain(">Blue</option>");
    });

    test("marks selected value and leaves others unselected", () => {
      const html = renderField(colorSelect, "blue");
      expect(html).toContain('value="blue" selected');
      expect(html).not.toContain('value="red" selected');
    });

    test("renders hint on select", () => {
      const html = renderField({
        hint: "Choose the priority",
        label: "Priority",
        name: "priority",
        options: [{ label: "Low", value: "low" }],
        type: "select",
      });
      expect(html).toContain("Choose the priority");
    });
  });

  describe("date type", () => {
    test("renders date input", () => {
      const html = rendered({
        label: "Start Date",
        name: "start_date",
        type: "date",
      });
      expect(html).toContain('type="date"');
      expect(html).toContain('name="start_date"');
    });

    test("renders date input with value", () => {
      const html = rendered(
        { label: "Start Date", name: "start_date", type: "date" },
        "2026-12-25",
      );
      expect(html).toContain('value="2026-12-25"');
    });
  });

  describe("datetime type", () => {
    test("renders split date and time inputs", () => {
      const html = rendered({
        label: "Closes At",
        name: "closes_at",
        type: "datetime",
      });
      expect(html).toContain('name="closes_at_date"');
      expect(html).toContain('placeholder="Date"');
      expect(html).toContain('name="closes_at_time"');
      expect(html).toContain('placeholder="Time"');
    });

    test("splits combined value into date and time parts", () => {
      const html = rendered(
        { label: "Closes At", name: "closes_at", type: "datetime" },
        "2099-06-15T14:30",
      );
      expect(html).toContain('value="2099-06-15"');
      expect(html).toContain('value="14:30"');
    });

    test("renders no value attributes when value is empty", () => {
      const html = rendered(
        { label: "Closes At", name: "closes_at", type: "datetime" },
        "",
      );
      expect(html).not.toContain("value=");
    });
  });

  describe("file type", () => {
    test("renders file input with accept attribute", () => {
      const html = rendered({
        accept: "image/jpeg,image/png",
        label: "Upload Image",
        name: "image",
        type: "file",
      });
      expect(html).toContain('type="file"');
      expect(html).toContain('accept="image/jpeg,image/png"');
    });
  });

  describe("checkbox-group type", () => {
    const daysField: Field = {
      label: "Days",
      name: "days",
      options: [
        { label: "Monday", value: "Monday" },
        { label: "Tuesday", value: "Tuesday" },
        { label: "Wednesday", value: "Wednesday" },
      ],
      type: "checkbox-group",
    };

    test("renders checkbox inputs with correct names and values", () => {
      const html = renderField(daysField);
      expect(html).toContain('type="checkbox"');
      expect(html).toContain('name="days"');
      expect(html).toContain('value="Monday"');
      expect(html).toContain('value="Tuesday"');
    });

    test("pre-selects matching values from comma-separated string", () => {
      const html = renderField(daysField, "Monday,Wednesday");
      expect(html).toContain('value="Monday" checked');
      expect(html).toContain('value="Wednesday" checked');
      expect(html).not.toContain('value="Tuesday" checked');
    });

    test("renders no checked state when value is empty", () => {
      expect(renderField(daysField)).not.toContain("checked");
    });
  });
});

describe("renderFields", () => {
  test("renders all fields", () => {
    const fields: Field[] = [
      field({ label: "Name", name: "name", required: true }),
      field({ label: "Email", name: "email", required: true, type: "email" }),
    ];
    const html = renderFields(fields);
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
  });

  test("populates field values", () => {
    const fields: Field[] = [
      field({ label: "Name", name: "name" }),
      field({ label: "Count", name: "count", type: "number" }),
    ];
    const html = renderFields(fields, { count: 42, name: "Test" });
    expect(html).toContain('value="Test"');
    expect(html).toContain('value="42"');
  });

  test("omits value attribute for null values", () => {
    const html = renderFields(
      [field({ label: "Price", name: "price", type: "number" })],
      { price: null },
    );
    expect(html).not.toContain('value="null"');
  });

  test("uses defaultValue when no explicit value or saved data", () => {
    const html = renderFields([
      field({ defaultValue: "US", label: "Country", name: "country" }),
    ]);
    expect(html).toContain('value="US"');
  });
});

describe("renderFields with saved form data", () => {
  afterEach(() => clearSavedFormData());

  test("restores saved text values", () => {
    setSavedFormData(new FormParams("name=Alice"));
    expect(renderFields([field({ label: "Name", name: "name" })])).toContain(
      'value="Alice"',
    );
  });

  test("explicit values take precedence over saved values", () => {
    setSavedFormData(new FormParams("name=Saved"));
    const html = renderFields([field({ label: "Name", name: "name" })], {
      name: "Explicit",
    });
    expect(html).toContain('value="Explicit"');
    expect(html).not.toContain("Saved");
  });

  test("saved data takes precedence over defaultValue", () => {
    setSavedFormData(new FormParams("country=GB"));
    const html = renderFields([
      field({ defaultValue: "US", label: "Country", name: "country" }),
    ]);
    expect(html).toContain('value="GB"');
    expect(html).not.toContain('value="US"');
  });
});
