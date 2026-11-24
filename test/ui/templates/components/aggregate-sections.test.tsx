import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  CheckboxForm,
  CheckboxLabel,
  FormSections,
  IdCheckboxLabel,
  ItemCheckboxList,
  RunningTotalsFieldset,
  SectionFieldset,
  StackDetails,
} from "#templates/components/aggregate-sections.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";

describe("IdCheckboxLabel", () => {
  test("ticks the box of an id inside the chosen set", () => {
    const html = String(
      IdCheckboxLabel({
        checkedIds: new Set([7]),
        id: 7,
        label: "Pick me",
        name: "choices",
      }),
    );
    expect(html).toBe(
      '<label><input checked name="choices" type="checkbox" value="7">Pick me</label>',
    );
  });

  test("leaves the box of an id outside the chosen set unticked", () => {
    const html = String(
      IdCheckboxLabel({
        checkedIds: new Set([7]),
        id: 8,
        label: "Leave me",
        name: "choices",
      }),
    );
    expect(html).toBe(
      '<label><input name="choices" type="checkbox" value="8">Leave me</label>',
    );
    assert(!html.includes("checked"));
  });
});

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
    expectIncludesAll(html, [
      '<fieldset class="checkboxes">kids</fieldset>',
      "/icons.svg#save",
      "<span>Save it</span>",
    ]);
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

describe("ItemCheckboxList", () => {
  test("ticks exactly the items whose ids are chosen", () => {
    const html = String(
      ItemCheckboxList({
        checkedIds: new Set([2]),
        items: [
          { id: 1, name: "First" },
          { id: 2, name: "Second" },
        ],
        name: "listingIds",
      }),
    );
    expectIncludesAll(html, [
      '<input name="listingIds" type="checkbox" value="1"> First',
      '<input checked name="listingIds" type="checkbox" value="2"> Second',
    ]);
  });
});

describe("RunningTotalsFieldset", () => {
  const config = {
    fields: [],
    legend: "Running totals",
    note: "Totals update as money moves.",
    recalculateHref: "/admin/listing/1/recalculate",
    recalculateLabel: "Recalculate",
    values: {},
  };

  test("offers the recalculate step as a link while the site is writable", () => {
    const html = String(RunningTotalsFieldset({ config }));
    expectIncludesAll(html, [
      "<legend>Running totals</legend>",
      '<a href="/admin/listing/1/recalculate">Recalculate</a>',
    ]);
  });

  test("shows the recalculate label as plain text once the site is read-only", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = String(RunningTotalsFieldset({ config }));
    assertStringIncludes(html, "Recalculate");
    assert(!html.includes("<a href="));
  });
});
