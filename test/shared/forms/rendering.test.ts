import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import {
  renderField,
  renderFields,
  renderSelectOptions,
} from "#shared/forms/rendering.tsx";
import {
  clearSavedFormData,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";

const field = (
  overrides: Partial<Field> & { name: string; label: string },
): Field => ({ type: "text", ...overrides }) as Field;

const rendered = (
  overrides: Partial<Field> & { name: string; label: string },
  value?: string,
): string => renderField(field(overrides), value);

describe("renderField", () => {
  test("renders all ordinary input attributes and escaped content exactly", () => {
    expect(
      rendered(
        {
          autocomplete: "name",
          autofocus: true,
          hint: "Plain hint",
          hintHtml: "<b>Trusted hint</b>",
          id: "name-id",
          inputmode: "text",
          label: "Name",
          max: 9,
          maxlength: 8,
          min: 1,
          minlength: 2,
          name: "name",
          pattern: "[A-Z]+",
          placeholder: "Enter name",
          required: true,
          title: "Uppercase letters",
        },
        '<A&B">',
      ),
    ).toBe(
      '<label>Name<input autocomplete="name" autofocus id="name-id" inputmode="text" max="9" maxlength="8" min="1" minlength="2" name="name" pattern="[A-Z]+" placeholder="Enter name" required title="Uppercase letters" type="text" value="&lt;A&amp;B&quot;&gt;"><small>Plain hint</small><small><b>Trusted hint</b></small></label>',
    );
  });

  test("omits optional attributes, value, and beforeHtml when absent", () => {
    expect(rendered({ label: "Name", name: "name" })).toBe(
      '<label>Name<input name="name" type="text"></label>',
    );
  });

  test("renders trusted beforeHtml before the label", () => {
    expect(rendered({ beforeHtml: "<hr>", label: "Name", name: "name" })).toBe(
      '<hr><label>Name<input name="name" type="text"></label>',
    );
  });

  for (const { description, field: textarea, expected, value } of [
    {
      description: "markdown textarea attributes and an escaped value",
      expected:
        '<label>Bio<textarea autocomplete="off" data-markdown-preview id="bio-id" maxlength="10" name="bio" placeholder="Write" required>A &lt; B</textarea></label>',
      field: field({
        autocomplete: "off",
        id: "bio-id",
        label: "Bio",
        markdown: true,
        maxlength: 10,
        name: "bio",
        placeholder: "Write",
        required: true,
        type: "textarea",
      }),
      value: "A < B",
    },
    {
      description: "plain textarea without markdown metadata",
      expected: '<label>Bio<textarea name="bio"></textarea></label>',
      field: field({ label: "Bio", name: "bio", type: "textarea" }),
      value: "",
    },
  ] as const) {
    test(`renders ${description}`, () => {
      expect(renderField(textarea, value)).toBe(expected);
    });
  }

  test("renders file attributes exactly", () => {
    expect(
      rendered({
        accept: "image/png",
        id: "image-id",
        label: "Image",
        name: "image",
        required: true,
        type: "file",
      }),
    ).toBe(
      '<label>Image<input accept="image/png" id="image-id" name="image" required type="file"></label>',
    );
  });

  describe("select", () => {
    test("renders an explicit id, required state, selection, and option hints", () => {
      expect(
        rendered(
          {
            id: "shade-id",
            label: "Shade",
            name: "shade",
            options: [
              { hint: "Warm", label: "Red", value: "red" },
              { label: "Blue", value: "blue" },
            ],
            required: true,
            type: "select",
          },
          "blue",
        ),
      ).toBe(
        '<label>Shade<select name="shade" id="shade-id" required><option value="red">Red</option><option value="blue" selected>Blue</option></select></label><ul><li><strong>Red:</strong> Warm</li></ul>',
      );
    });

    test("uses the field name as id and omits required and empty option hints", () => {
      expect(
        rendered(
          {
            label: "Color",
            name: "color",
            options: [
              { label: "Red", value: "red" },
              { label: "Blue", value: "blue" },
            ],
            type: "select",
          },
          "red",
        ),
      ).toBe(
        '<label>Color<select name="color" id="color"><option value="red" selected>Red</option><option value="blue">Blue</option></select></label>',
      );
    });
  });

  describe("checkbox group", () => {
    const days = field({
      label: "Days",
      name: "days",
      options: [
        { label: "Monday", value: "Monday" },
        { label: "Tuesday", value: "Tuesday" },
        { label: "Wednesday", value: "Wednesday" },
      ],
      type: "checkbox-group",
    });

    test("uses commas as delimiters and trims each selected value", () => {
      expect(renderField(days, "Monday, Wednesday")).toBe(
        '<label>Days<fieldset class="checkboxes"><label><input type="checkbox" name="days" value="Monday" checked> Monday</label><label><input type="checkbox" name="days" value="Tuesday"> Tuesday</label><label><input type="checkbox" name="days" value="Wednesday" checked> Wednesday</label></fieldset></label>',
      );
    });

    test("renders no checked attributes for an empty value", () => {
      expect(renderField(days, "")).toBe(
        '<label>Days<fieldset class="checkboxes"><label><input type="checkbox" name="days" value="Monday"> Monday</label><label><input type="checkbox" name="days" value="Tuesday"> Tuesday</label><label><input type="checkbox" name="days" value="Wednesday"> Wednesday</label></fieldset></label>',
      );
    });
  });

  describe("datetime", () => {
    for (const { description, expected, value } of [
      {
        description: "empty date and time inputs",
        expected:
          '<label>Closes<input type="date" name="closes_date" placeholder="Date" aria-label="Date"><input type="time" name="closes_time" placeholder="Time" aria-label="Time"></label>',
        value: "",
      },
      {
        description: "a date without adding a time value",
        expected:
          '<label>Closes<input type="date" name="closes_date" placeholder="Date" aria-label="Date" value="2099-06-15"><input type="time" name="closes_time" placeholder="Time" aria-label="Time"></label>',
        value: "2099-06-15",
      },
      {
        description: "separate date and time values",
        expected:
          '<label>Closes<input type="date" name="closes_date" placeholder="Date" aria-label="Date" value="2099-06-15"><input type="time" name="closes_time" placeholder="Time" aria-label="Time" value="14:30"></label>',
        value: "2099-06-15T14:30",
      },
    ] as const) {
      test(`renders ${description}`, () => {
        expect(
          rendered(
            { label: "Closes", name: "closes", type: "datetime" },
            value,
          ),
        ).toBe(expected);
      });
    }
  });

  describe("money", () => {
    test("renders its id, minimum, required state, and value", () => {
      expect(
        rendered(
          {
            id: "fee-id",
            label: "Fee",
            min: 0,
            name: "fee",
            required: true,
            type: "money",
          },
          "12.34",
        ),
      ).toBe(
        '<label>Fee<input id="fee-id" inputmode="decimal" min="0" name="fee" required step="0.01" type="number" value="12.34"></label>',
      );
    });

    test("omits optional attributes and value when empty", () => {
      expect(rendered({ label: "Fee", name: "fee", type: "money" }, "")).toBe(
        '<label>Fee<input inputmode="decimal" name="fee" step="0.01" type="number"></label>',
      );
    });
  });

  describe("public link", () => {
    const withPublicLink = {
      label: "Slug",
      name: "slug",
      publicLinkPath: (slug: string) => `/news/${slug}`,
    } as const;

    test("renders the link for a value", () => {
      expect(rendered(withPublicLink, "my-post")).toBe(
        '<label>Slug<input name="slug" type="text" value="my-post"><small class="public-link">Public link: <a href="/news/my-post" rel="noopener" target="_blank">/news/my-post</a></small></label>',
      );
    });

    for (const { description, linkField, value } of [
      {
        description: "the path builder is absent",
        linkField: { label: "Slug", name: "slug" },
        value: "my-post",
      },
      {
        description: "the value is empty",
        linkField: withPublicLink,
        value: "",
      },
    ] as const) {
      test(`omits the link when ${description}`, () => {
        expect(rendered(linkField, value)).toBe(
          `<label>Slug<input name="slug" type="text"${
            value ? ` value="${value}"` : ""
          }></label>`,
        );
      });
    }
  });
});

describe("renderFields", () => {
  test("renders visible fields in order with string and number values", () => {
    expect(
      renderFields(
        [
          field({ label: "Name", name: "name" }),
          field({ label: "Hidden", name: "hidden", visible: false }),
          field({
            label: "Count",
            name: "count",
            type: "number",
            visible: true,
          }),
        ],
        { count: 42, hidden: "secret", name: "Test" },
      ),
    ).toBe(
      '<label>Name<input name="name" type="text" value="Test"></label><label>Count<input name="count" type="number" value="42"></label>',
    );
  });

  describe("saved form data precedence", () => {
    afterEach(() => clearSavedFormData());

    for (const { description, expected, saved, value } of [
      {
        description: "a non-empty explicit value over saved data",
        expected: "Explicit",
        saved: "Saved",
        value: "Explicit",
      },
      {
        description: "saved data over an explicit empty string",
        expected: "Saved",
        saved: "Saved",
        value: "",
      },
      {
        description: "saved data over the field default",
        expected: "Saved",
        saved: "Saved",
        value: undefined,
      },
    ] as const) {
      test(`uses ${description}`, () => {
        setSavedFormData(new FormParams(`name=${saved}`));
        expect(
          renderFields(
            [field({ defaultValue: "Default", label: "Name", name: "name" })],
            value === undefined ? {} : { name: value },
          ),
        ).toBe(
          `<label>Name<input name="name" type="text" value="${expected}"></label>`,
        );
      });
    }

    for (const { description, expected, value } of [
      {
        description: "the default for a missing value",
        expected: ' value="Default"',
        value: undefined,
      },
      {
        description: "the default for a null value",
        expected: ' value="Default"',
        value: null,
      },
      {
        description: "blank for an explicit empty string",
        expected: "",
        value: "",
      },
    ] as const) {
      test(`uses ${description} when there is no saved data`, () => {
        expect(
          renderFields(
            [field({ defaultValue: "Default", label: "Name", name: "name" })],
            value === undefined ? {} : { name: value },
          ),
        ).toBe(`<label>Name<input name="name" type="text"${expected}></label>`);
      });
    }

    test("falls back to a blank value when no source has a value", () => {
      expect(renderFields([field({ label: "Name", name: "name" })])).toBe(
        '<label>Name<input name="name" type="text"></label>',
      );
    });

    test("keeps an explicit zero", () => {
      expect(
        renderFields(
          [field({ label: "Count", name: "count", type: "number" })],
          {
            count: 0,
          },
        ),
      ).toBe(
        '<label>Count<input name="count" type="number" value="0"></label>',
      );
    });
  });
});

describe("renderSelectOptions", () => {
  test("escapes entries and marks only the selected option", () => {
    expect(
      renderSelectOptions([
        { label: "One & only", value: '1"' },
        { label: "Two < three", selected: true, value: "2" },
      ]),
    ).toBe(
      '<option value="1&quot;">One &amp; only</option><option value="2" selected>Two &lt; three</option>',
    );
    expect(renderSelectOptions([])).toBe("");
  });
});
