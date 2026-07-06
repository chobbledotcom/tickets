import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  CheckboxesFieldset,
  CheckboxForm,
  CheckboxLabel,
  StackDetails,
  StackFieldset,
} from "#templates/components/aggregate-sections.tsx";
import { setupTestEncryptionKey } from "#test-utils";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("StackFieldset", () => {
  test("wraps its children in a stack inside a legend fieldset", () => {
    const html = String(
      StackFieldset({ children: "inner", legend: "Legend here" }),
    );
    expect(html).toBe(
      '<fieldset><legend>Legend here</legend><div class="stack">inner</div></fieldset>',
    );
  });
});

describe("StackDetails", () => {
  test("wraps its children in a stack inside a details element", () => {
    const html = String(
      StackDetails({ children: "inner", summary: "Summary here" }),
    );
    expect(html).toBe(
      '<details><summary>Summary here</summary><div class="stack">inner</div></details>',
    );
  });
});

describe("CheckboxForm", () => {
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
