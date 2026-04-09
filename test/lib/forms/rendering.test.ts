import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  clearSavedFormData,
  type Field,
  renderField,
  renderFields,
  setSavedFormData,
} from "#lib/forms.tsx";
import { FormParams } from "#lib/form-data.ts";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides });

const rendered = (
  overrides: Partial<Field> & { name: string; label: string },
  value?: string,
): string => renderField(field(overrides), value);

describe("renderField", () => {
  test("renders text input with label", () => {
    const html = rendered({ name: "username", label: "Username" });
    expect(html).toContain("<label>");
    expect(html).toContain("Username");
    expect(html).toContain('type="text"');
    expect(html).toContain('name="username"');
  });

  test("renders required attribute", () => {
    const html = rendered({ name: "email", label: "Email", type: "email", required: true });
    expect(html).toContain("required");
  });

  test("renders placeholder", () => {
    const html = rendered({ name: "name", label: "Name", placeholder: "Enter your name" });
    expect(html).toContain('placeholder="Enter your name"');
  });

  test("renders hint text", () => {
    const html = rendered({ name: "pw", label: "Password", type: "password", hint: "Minimum 8 characters" });
    expect(html).toContain("Minimum 8 characters");
    expect(html).toContain("<small");
  });

  test("renders hintHtml as raw HTML", () => {
    const html = rendered({ name: "desc", label: "Description", hintHtml: '<a href="/guide">Help</a>' });
    expect(html).toContain('<a href="/guide">Help</a>');
    expect(html).toContain("<small");
  });

  test("renders min attribute for number", () => {
    const html = rendered({ name: "qty", label: "Quantity", type: "number", min: 1 });
    expect(html).toContain('min="1"');
  });

  test("renders pattern attribute", () => {
    const html = rendered({ name: "code", label: "Code", pattern: "[A-Z]{3}" });
    expect(html).toContain('pattern="[A-Z]{3}"');
  });

  test("renders maxlength attribute", () => {
    const html = rendered({ name: "desc", label: "Description", maxlength: 128 });
    expect(html).toContain('maxlength="128"');
  });

  test("renders autocomplete when provided, omits when absent", () => {
    expect(rendered({ name: "name", label: "Name", autocomplete: "name" })).toContain('autocomplete="name"');
    expect(rendered({ name: "name", label: "Name" })).not.toContain("autocomplete");
  });

  test("renders textarea for textarea type", () => {
    const html = rendered({ name: "description", label: "Description", type: "textarea" });
    expect(html).toContain("<textarea");
    expect(html).not.toContain("<input");
  });

  test("renders value when provided", () => {
    expect(rendered({ name: "name", label: "Name" }, "John")).toContain('value="John"');
  });

  test("escapes HTML in value", () => {
    const html = rendered({ name: "name", label: "Name" }, '<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("renders textarea with value", () => {
    const html = rendered({ name: "description", label: "Description", type: "textarea" }, "Some description");
    expect(html).toContain(">Some description</textarea>");
  });

  describe("select type", () => {
    const colorSelect: Field = {
      name: "color",
      label: "Color",
      type: "select",
      options: [
        { value: "red", label: "Red" },
        { value: "blue", label: "Blue" },
      ],
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
        name: "priority",
        label: "Priority",
        type: "select",
        hint: "Choose the priority",
        options: [{ value: "low", label: "Low" }],
      });
      expect(html).toContain("Choose the priority");
    });
  });

  describe("date type", () => {
    test("renders date input", () => {
      const html = rendered({ name: "start_date", label: "Start Date", type: "date" });
      expect(html).toContain('type="date"');
      expect(html).toContain('name="start_date"');
    });

    test("renders date input with value", () => {
      const html = rendered({ name: "start_date", label: "Start Date", type: "date" }, "2026-12-25");
      expect(html).toContain('value="2026-12-25"');
    });
  });

  describe("datetime type", () => {
    test("renders split date and time inputs", () => {
      const html = rendered({ name: "closes_at", label: "Closes At", type: "datetime" });
      expect(html).toContain('name="closes_at_date"');
      expect(html).toContain('placeholder="Date"');
      expect(html).toContain('name="closes_at_time"');
      expect(html).toContain('placeholder="Time"');
    });

    test("splits combined value into date and time parts", () => {
      const html = rendered({ name: "closes_at", label: "Closes At", type: "datetime" }, "2099-06-15T14:30");
      expect(html).toContain('value="2099-06-15"');
      expect(html).toContain('value="14:30"');
    });

    test("renders no value attributes when value is empty", () => {
      const html = rendered({ name: "closes_at", label: "Closes At", type: "datetime" }, "");
      expect(html).not.toContain("value=");
    });
  });

  describe("file type", () => {
    test("renders file input with accept attribute", () => {
      const html = rendered({ name: "image", label: "Upload Image", type: "file", accept: "image/jpeg,image/png" });
      expect(html).toContain('type="file"');
      expect(html).toContain('accept="image/jpeg,image/png"');
    });
  });

  describe("checkbox-group type", () => {
    const daysField: Field = {
      name: "days",
      label: "Days",
      type: "checkbox-group",
      options: [
        { value: "Monday", label: "Monday" },
        { value: "Tuesday", label: "Tuesday" },
        { value: "Wednesday", label: "Wednesday" },
      ],
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
      field({ name: "name", label: "Name", required: true }),
      field({ name: "email", label: "Email", type: "email", required: true }),
    ];
    const html = renderFields(fields);
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
  });

  test("populates field values", () => {
    const fields: Field[] = [
      field({ name: "name", label: "Name" }),
      field({ name: "count", label: "Count", type: "number" }),
    ];
    const html = renderFields(fields, { name: "Test", count: 42 });
    expect(html).toContain('value="Test"');
    expect(html).toContain('value="42"');
  });

  test("omits value attribute for null values", () => {
    const html = renderFields([field({ name: "price", label: "Price", type: "number" })], { price: null });
    expect(html).not.toContain('value="null"');
  });

  test("uses defaultValue when no explicit value or saved data", () => {
    const html = renderFields([field({ name: "country", label: "Country", defaultValue: "US" })]);
    expect(html).toContain('value="US"');
  });
});

describe("renderFields with saved form data", () => {
  afterEach(() => clearSavedFormData());

  test("restores saved text values", () => {
    setSavedFormData(new FormParams("name=Alice"));
    expect(renderFields([field({ name: "name", label: "Name" })])).toContain('value="Alice"');
  });

  test("explicit values take precedence over saved values", () => {
    setSavedFormData(new FormParams("name=Saved"));
    const html = renderFields([field({ name: "name", label: "Name" })], { name: "Explicit" });
    expect(html).toContain('value="Explicit"');
    expect(html).not.toContain("Saved");
  });

  test("saved data takes precedence over defaultValue", () => {
    setSavedFormData(new FormParams("country=GB"));
    const html = renderFields([field({ name: "country", label: "Country", defaultValue: "US" })]);
    expect(html).toContain('value="GB"');
    expect(html).not.toContain('value="US"');
  });
});
