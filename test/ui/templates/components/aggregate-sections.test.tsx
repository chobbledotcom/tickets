import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  CheckboxesFieldset,
  CheckboxForm,
  CheckboxLabel,
  FormSections,
  SectionFieldset,
  StackDetails,
} from "#templates/components/aggregate-sections.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("SectionFieldset", () => {
  test("puts its children directly in a legend fieldset", () => {
    const html = String(
      SectionFieldset({ children: "inner", legend: "Legend here" }),
    );
    expect(html).toBe("<fieldset><legend>Legend here</legend>inner</fieldset>");
  });
});

describe("FormSections", () => {
  test("renders each section as a listing-section legend fieldset", () => {
    const html = String(
      FormSections({
        sections: [
          { children: "one", legend: "First" },
          { children: "two", legend: "Second" },
        ],
      }),
    );
    expect(html).toBe(
      '<fieldset class="listing-section"><legend>First</legend>one</fieldset>' +
        '<fieldset class="listing-section"><legend>Second</legend>two</fieldset>',
    );
  });

  test("keeps a section's own className when it supplies one", () => {
    const html = String(
      FormSections({
        sections: [
          { children: "x", className: "listing-section extra", legend: "L" },
        ],
      }),
    );
    expect(html).toBe(
      '<fieldset class="listing-section extra"><legend>L</legend>x</fieldset>',
    );
  });

  test("falls back to listing-section for a blank className", () => {
    const html = String(
      FormSections({
        sections: [{ children: "x", className: "", legend: "L" }],
      }),
    );
    expect(html).toBe(
      '<fieldset class="listing-section"><legend>L</legend>x</fieldset>',
    );
  });
});

describe("StackDetails", () => {
  test("keeps its related children in a page block inside the details", () => {
    const html = String(
      StackDetails({ children: "inner", summary: "Summary here" }),
    );
    expect(html).toBe(
      '<details><summary>Summary here</summary><div class="page-block">inner</div></details>',
    );
  });
});

describe("CheckboxForm", () => {
  beforeAll(setupAdminPageTest);

  test("wraps its children in a checkboxes fieldset with a save submit", () => {
    const html = String(
      CheckboxForm({ action: "/x", children: "kids", submitLabel: "Save it" }),
    );
    expect(html).toContain('<fieldset class="checkboxes">kids</fieldset>');
    expect(html).toContain("/icons.svg#save");
    expect(html).toContain("<span>Save it</span>");
  });
});

describe("CheckboxLabel", () => {
  test("renders a plain enabled checkbox with its label", () => {
    const html = String(
      CheckboxLabel({
        checked: undefined,
        label: "Pick me",
        name: "choices",
        value: "7",
      }),
    );
    expect(html).toBe(
      '<label><input name="choices" type="checkbox" value="7">Pick me</label>',
    );
  });

  test("renders the checked, disabled, and class attributes when set", () => {
    const html = String(
      CheckboxLabel({
        checked: true,
        className: "muted",
        disabled: true,
        label: "Locked in",
        name: "choices",
        value: "8",
      }),
    );
    expect(html).toBe(
      '<label class="muted">' +
        '<input checked disabled name="choices" type="checkbox" value="8">' +
        "Locked in</label>",
    );
  });
});

describe("CheckboxesFieldset", () => {
  test("renders the none message when there are no options", () => {
    const html = String(
      CheckboxesFieldset({
        fieldName: "listing_ids",
        noneMessage: "Nothing to pick",
        options: [],
        selected: [],
      }),
    );
    expect(html).toBe("<p>Nothing to pick</p>");
  });

  test("checks exactly the selected options", () => {
    const html = String(
      CheckboxesFieldset({
        fieldName: "listing_ids",
        noneMessage: "Nothing to pick",
        options: [
          { id: 1, name: "First" },
          { id: 2, name: "Second" },
        ],
        selected: [2],
      }),
    );
    expect(html).toContain('<fieldset class="checkboxes">');
    expect(html).toContain(
      '<input name="listing_ids" type="checkbox" value="1"> First',
    );
    expect(html).toContain(
      '<input checked name="listing_ids" type="checkbox" value="2"> Second',
    );
  });
});
