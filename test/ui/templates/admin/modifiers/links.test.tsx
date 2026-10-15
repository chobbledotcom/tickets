import { assert } from "@std/assert";
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
import { says } from "#test-utils/says.ts";

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
    says(html, 'action="/admin/modifiers/1/links"');
    says(html, "/icons.svg#save");
    says(html, "Save scope");
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
    says(html, "<strong>Linked listings (1):</strong>");
    says(html, 'checked name="listing_ids" type="checkbox" value="7"');
    says(html, '<label><input name="listing_ids" type="checkbox" value="8"');
    says(html, "VIP Pass");
  });

  test("renders group checkboxes under the groups field", () => {
    const html = render({
      kind: "groups",
      options: [{ active: true, id: 3, name: "Weekend" }],
      selected: [],
    });
    says(html, "<strong>Linked groups (0):</strong>");
    says(html, 'name="group_ids" type="checkbox" value="3"');
    says(html, "Weekend");
    assert(!html.includes('name="listing_ids"'));
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
    says(html, "Nothing available to link yet");
    assert(!html.includes('type="checkbox"'));
    assert(!html.includes("Linked listings"));
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
    says(html, 'action="/admin/modifiers/1/answers"');
    says(html, "when a buyer selects any of the ticked answers");
    says(html, "/icons.svg#save");
    says(html, "Save answers");
  });

  test("checks linked answers and leaves unlinked ones unchecked", () => {
    const html = render({
      options: [
        { id: 10, name: "Size — Large" },
        { id: 11, name: "Size — Small" },
      ],
      selected: [10],
    });
    says(html, "<strong>Linked answers (1):</strong>");
    says(html, 'checked name="answer_ids" type="checkbox" value="10"');
    says(html, '<label><input name="answer_ids" type="checkbox" value="11"');
  });

  test("renders answers active (never muted), since answers have no deactivated state", () => {
    const html = render({
      options: [{ id: 10, name: "Size — Large" }],
      selected: [],
    });
    assert(!html.includes('<label class="muted"><input name="answer_ids"'));
  });

  test("shows the empty note when there are no answers to link", () => {
    const html = render({ options: [], selected: [] });
    says(html, "No question answers to link yet");
    assert(!html.includes('type="checkbox"'));
  });
});
