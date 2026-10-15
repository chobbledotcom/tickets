import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type LinkedItemGroup,
  type LinkedItemOption,
  LinkedItemsCheckboxes,
  toLinkedItemOptions,
} from "#templates/components/linked-items.tsx";
import { says } from "#test-utils/says.ts";

const option = (
  value: string,
  overrides: Partial<LinkedItemOption> = {},
): LinkedItemOption => ({
  active: true,
  checked: false,
  label: `Label ${value}`,
  value,
  ...overrides,
});

const render = (groups: LinkedItemGroup[]): string =>
  String(LinkedItemsCheckboxes({ groups, name: "linked" }));

describe("LinkedItemsCheckboxes", () => {
  test("renders one labelled checkbox row per type with the linked count", () => {
    const html = render([
      {
        label: "Listings",
        options: [option("listing:1", { checked: true }), option("listing:2")],
      },
      { label: "Groups", options: [option("group:3", { checked: true })] },
    ]);

    says(html, "<p><strong>Linked items (2):</strong></p>");
    says(html, '<ul class="linked-items">');
    says(html, '<li class="checkboxes"><strong>Listings:</strong>');
    says(html, '<li class="checkboxes"><strong>Groups:</strong>');
    says(html, 'checked name="linked" type="checkbox" value="listing:1"');
    says(html, '<input name="linked" type="checkbox" value="listing:2"');
  });

  test("keeps each option under its own type's row", () => {
    const html = render([
      { label: "Listings", options: [option("listing:1")] },
      { label: "Groups", options: [option("group:2")] },
    ]);

    const listingsRow = html.indexOf("<strong>Listings:</strong>");
    const listing = html.indexOf('value="listing:1"');
    const groupsRow = html.indexOf("<strong>Groups:</strong>");
    const group = html.indexOf('value="group:2"');
    expect(listingsRow).toBeGreaterThan(-1);
    expect(listing).toBeGreaterThan(listingsRow);
    expect(groupsRow).toBeGreaterThan(listing);
    expect(group).toBeGreaterThan(groupsRow);
  });

  test("renders a single populated type as one line without a list", () => {
    const html = render([
      {
        label: "Listings",
        options: [option("listing:1", { checked: true }), option("listing:2")],
      },
      { label: "Groups", options: [] },
    ]);

    says(
      html,
      '<fieldset class="checkboxes"><strong>Linked listings (1):</strong>',
    );
    assert(!html.includes("<ul"));
    assert(!html.includes("Linked items"));
    assert(!html.includes("Groups"));
  });

  test("sorts deactivated options last and renders them muted", () => {
    const html = render([
      {
        label: "Listings",
        options: [
          option("listing:1", { active: false, label: "Old listing" }),
          option("listing:2", { label: "Live listing" }),
        ],
      },
      { label: "Groups", options: [option("group:3")] },
    ]);

    const live = html.indexOf('value="listing:2"');
    const old = html.indexOf('value="listing:1"');
    expect(live).toBeGreaterThan(-1);
    expect(old).toBeGreaterThan(live);
    says(
      html,
      '<label class="muted"><input name="linked" type="checkbox" value="listing:1"',
    );
    assert(
      !html.includes(
        '<label class="muted"><input name="linked" type="checkbox" value="listing:2"',
      ),
    );
  });

  test("disables a blocked option and shows its refusal beside it", () => {
    const html = render([
      {
        label: "Listings",
        options: [
          option("listing:1", { blocked: "Clashes with the group" }),
          option("listing:2"),
        ],
      },
    ]);

    expect(html).toMatch(/<input disabled[^>]*value="listing:1"/);
    says(html, '<small class="muted">Clashes with the group</small>');
    expect(html).not.toMatch(/<input disabled[^>]*value="listing:2"/);
    assert(!html.includes('<small class="muted">Label listing:2</small>'));
  });

  test("sorts already-linked options to the front, keeping the rest in order", () => {
    const html = render([
      {
        label: "Listings",
        options: [
          option("listing:1"),
          option("listing:2", { checked: true }),
          option("listing:3"),
        ],
      },
    ]);

    const second = html.indexOf('value="listing:2"');
    const first = html.indexOf('value="listing:1"');
    const third = html.indexOf('value="listing:3"');
    // The checked option leads; the two unchecked keep their original order.
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
    expect(third).toBeGreaterThan(first);
  });

  test("a linked deactivated option still leads over an unlinked active one", () => {
    const html = render([
      {
        label: "Listings",
        options: [
          option("listing:1", { label: "Live unlinked" }),
          option("listing:2", {
            active: false,
            checked: true,
            label: "Old linked",
          }),
        ],
      },
    ]);

    const linkedOld = html.indexOf('value="listing:2"');
    const unlinkedLive = html.indexOf('value="listing:1"');
    expect(linkedOld).toBeGreaterThan(-1);
    expect(unlinkedLive).toBeGreaterThan(linkedOld);
  });

  test("counts only checked options, including deactivated ones", () => {
    const html = render([
      {
        label: "Listings",
        options: [
          option("listing:1", { active: false, checked: true }),
          option("listing:2"),
        ],
      },
    ]);

    says(html, "<strong>Linked listings (1):</strong>");
  });

  test("applies a custom heading and renders the leading control first", () => {
    const html = String(
      LinkedItemsCheckboxes({
        groups: [{ label: "Listings", options: [option("listing:1")] }],
        heading: ({ type }) => `Add ${type}:`,
        leading: (
          <label>
            <input name="all" type="checkbox" />
            All
          </label>
        ),
        name: "linked",
      }),
    );

    says(html, "<strong>Add listings:</strong>");
    assert(!html.includes("Linked"));
    const leading = html.indexOf('name="all"');
    const firstOption = html.indexOf('name="linked"');
    expect(leading).toBeGreaterThan(-1);
    expect(firstOption).toBeGreaterThan(leading);
  });
});

describe("toLinkedItemOptions", () => {
  test("maps id/name/active rows and checks the selected ids", () => {
    const options = toLinkedItemOptions(
      [
        { active: true, id: 1, name: "First" },
        { active: false, id: 2, name: "Second" },
      ],
      new Set([2]),
    );

    expect(options).toEqual([
      { active: true, checked: false, label: "First", value: "1" },
      { active: false, checked: true, label: "Second", value: "2" },
    ]);
  });

  test("accepts an array of selected ids and leaves unlisted ones unchecked", () => {
    const options = toLinkedItemOptions(
      [{ active: true, id: 5, name: "Only" }],
      [],
    );

    expect(options).toEqual([
      { active: true, checked: false, label: "Only", value: "5" },
    ]);
  });
});
