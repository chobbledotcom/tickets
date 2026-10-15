import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type AnswerLinks,
  AnswerLinksForm,
  SCOPE_LINK_KINDS,
  type ScopeLinks,
  ScopeLinksForm,
} from "#templates/admin/modifiers/links.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testModifier } from "#test-utils/factories.ts";

const MODIFIER = testModifier({ id: 1 });

describe("SCOPE_LINK_KINDS", () => {
  test("maps each kind to its form field and plural type term", () => {
    expect(SCOPE_LINK_KINDS.listings).toEqual({
      field: "listing_ids",
      term: "terms.listings",
    });
    expect(SCOPE_LINK_KINDS.groups).toEqual({
      field: "group_ids",
      term: "terms.groups",
    });
  });
});

describe("ScopeLinksForm", () => {
  beforeAll(setupAdminPageTest);

  const render = (links: ScopeLinks): string =>
    String(ScopeLinksForm({ links, modifier: MODIFIER }));

  test("posts to the links action and renders a save button", () => {
    const html = render({
      kind: "listings",
      options: [{ active: true, id: 7, name: "VIP Pass" }],
      selected: [7],
    });
    assertStringIncludes(html, 'action="/admin/modifiers/1/links"');
    assertStringIncludes(html, "/icons.svg#save");
    assertStringIncludes(html, "Save scope");
  });

  test("renders listing checkboxes under the listings field, current links checked", () => {
    const html = render({
      kind: "listings",
      options: [
        { active: true, id: 7, name: "VIP Pass" },
        { active: true, id: 8, name: "Day Pass" },
      ],
      selected: [7],
    });
    assertStringIncludes(html, "<strong>Linked listings (1):</strong>");
    assertStringIncludes(
      html,
      'checked name="listing_ids" type="checkbox" value="7"',
    );
    assertStringIncludes(
      html,
      '<label><input name="listing_ids" type="checkbox" value="8"',
    );
    assertStringIncludes(html, "VIP Pass");
  });

  test("renders group checkboxes under the groups field", () => {
    const html = render({
      kind: "groups",
      options: [{ active: true, id: 3, name: "Weekend" }],
      selected: [],
    });
    assertStringIncludes(html, "<strong>Linked groups (0):</strong>");
    assertStringIncludes(html, 'name="group_ids" type="checkbox" value="3"');
    assertStringIncludes(html, "Weekend");
    assert(
      !html.includes('name="listing_ids"'),
      "the value should not contain the searched item",
    );
  });

  test("sorts a deactivated listing last and renders it muted", () => {
    const html = render({
      kind: "listings",
      options: [
        { active: false, id: 7, name: "Retired Pass" },
        { active: true, id: 8, name: "Live Pass" },
      ],
      selected: [],
    });
    const live = html.indexOf('value="8"');
    const retired = html.indexOf(
      '<label class="muted"><input name="listing_ids" type="checkbox" value="7"',
    );
    expect(live).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(live);
  });

  test("shows the empty note (and no checkboxes) when nothing is linkable", () => {
    const html = render({ kind: "listings", options: [], selected: [] });
    assertStringIncludes(html, "Nothing available to link yet");
    assert(
      !html.includes('type="checkbox"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Linked listings"),
      "the value should not contain the searched item",
    );
  });
});

describe("AnswerLinksForm", () => {
  beforeAll(setupAdminPageTest);

  const render = (answerLinks: AnswerLinks): string =>
    String(AnswerLinksForm({ answerLinks, modifier: MODIFIER }));

  test("posts to the answers action with the hint and a save button", () => {
    const html = render({
      options: [{ id: 10, name: "Size — Large" }],
      selected: [10],
    });
    assertStringIncludes(html, 'action="/admin/modifiers/1/answers"');
    assertStringIncludes(
      html,
      "when a buyer selects any of the ticked answers",
    );
    assertStringIncludes(html, "/icons.svg#save");
    assertStringIncludes(html, "Save answers");
  });

  test("checks linked answers and leaves unlinked ones unchecked", () => {
    const html = render({
      options: [
        { id: 10, name: "Size — Large" },
        { id: 11, name: "Size — Small" },
      ],
      selected: [10],
    });
    assertStringIncludes(html, "<strong>Linked answers (1):</strong>");
    assertStringIncludes(
      html,
      'checked name="answer_ids" type="checkbox" value="10"',
    );
    assertStringIncludes(
      html,
      '<label><input name="answer_ids" type="checkbox" value="11"',
    );
  });

  test("renders answers active (never muted), since answers have no deactivated state", () => {
    const html = render({
      options: [{ id: 10, name: "Size — Large" }],
      selected: [],
    });
    assert(
      !html.includes('<label class="muted"><input name="answer_ids"'),
      "the value should not contain the searched item",
    );
  });

  test("shows the empty note when there are no answers to link", () => {
    const html = render({ options: [], selected: [] });
    assertStringIncludes(html, "No question answers to link yet");
    assert(
      !html.includes('type="checkbox"'),
      "the value should not contain the searched item",
    );
  });
});
