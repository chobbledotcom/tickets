import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminQuestionPage } from "#templates/admin/questions.tsx";
import { resetFeaturePageTest } from "#test/ui/templates/admin/feature-page-test.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  testAnswer,
  testListingWithCount,
  testQuestion,
} from "#test-utils/factories.ts";
import {
  setupQuestionPageTest,
  TEST_LISTINGS,
  tShirtQuestion,
} from "./fixtures.ts";

describe("adminQuestionPage", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const question = tShirtQuestion;

  test("renders question text and edit form", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    assertStringIncludes(html, "T-shirt size?");
    assertStringIncludes(html, 'action="/admin/questions/1/edit"');
    assertStringIncludes(html, 'class="active" href="/admin/questions"');
    // The choice-type selector offers radio vs select, with the question's
    // current type (radio) pre-selected.
    assertStringIncludes(
      html,
      '<select name="display_type"><option selected value="radio">Radio buttons</option><option value="select">Select box</option></select>',
    );
  });

  test("renders answer list linking to each answer's edit page", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    assertStringIncludes(html, "Small");
    assertStringIncludes(html, "Large");
    assertStringIncludes(html, 'href="/admin/questions/1/answers/10/edit"');
    assertStringIncludes(html, 'href="/admin/questions/1/answers/11/edit"');
    assertStringIncludes(
      html,
      '<form action="/admin/questions/1/answers" autocomplete="off" method="POST" id="add-answer">',
    );
  });

  test("no longer links to answer deletion from the question page", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    assert(
      !html.includes("/admin/questions/1/answers/10/delete"),
      "the value should not contain the searched item",
    );
  });

  test("renders delete question link", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    assertStringIncludes(html, 'href="/admin/questions/1/delete"');
  });

  test("renders error message when provided", () => {
    const html = adminQuestionPage(question, OWNER_SESSION, "Error!");
    assertStringIncludes(html, "Error!");
  });

  test("renders empty answers state", () => {
    const html = adminQuestionPage(
      testQuestion({ id: 1, text: "Q?" }),
      OWNER_SESSION,
    );
    assertStringIncludes(html, "No answers yet");
  });

  test("locks the type on a free-text question's edit form", () => {
    const html = adminQuestionPage(
      testQuestion({
        display_type: "free_text",
        id: 1,
        text: "Notes?",
      }),
      OWNER_SESSION,
    );
    // No selector — a hidden field keeps it free-text and the choice options
    // are not offered.
    assertStringIncludes(
      html,
      '<input name="display_type" type="hidden" value="free_text"',
    );
    assert(
      !html.includes("Radio buttons"),
      "the value should not contain the searched item",
    );
  });

  test("hides answer management for a free-text question", () => {
    const html = adminQuestionPage(
      testQuestion({
        display_type: "free_text",
        id: 1,
        text: "Notes?",
      }),
      OWNER_SESSION,
    );
    // No add-answer form or answer heading — just an explanatory note that also
    // tells the operator a free-text question can't drive a price, and why.
    assert(
      !html.includes("/admin/questions/1/answers"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "they have no answer options");
    assertStringIncludes(html, "can't change the price");
    assertStringIncludes(html, "a price modifier attaches to a chosen answer");
  });

  test("renders answers in a table with their selection totals", () => {
    const counts = new Map([
      [10, 5],
      [11, 3],
    ]);
    const html = adminQuestionPage(question, OWNER_SESSION, undefined, counts);
    assertStringIncludes(html, "<table");
    assertStringIncludes(html, '<td class="col-quantity">5</td>');
    assertStringIncludes(html, '<td class="col-quantity">3</td>');
  });

  test("shows zero selections for answers with no stored total", () => {
    const html = adminQuestionPage(
      question,
      OWNER_SESSION,
      undefined,
      new Map(),
    );
    assertStringIncludes(html, '<td class="col-quantity">0</td>');
  });

  test("renders move-up and move-down buttons", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    assertStringIncludes(html, "/answers/10/move-down");
    assert(
      !html.includes("/answers/10/move-up"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "/answers/11/move-up");
    assert(
      !html.includes("/answers/11/move-down"),
      "the value should not contain the searched item",
    );
    // The answers table carries the reorder Order column header when writable.
    assertStringIncludes(html, '<th class="col-reorder">Order</th>');
  });

  test("renders both move buttons for middle answer", () => {
    const q = testQuestion({
      answers: [
        testAnswer({ id: 10, sort_order: 0, text: "A" }),
        testAnswer({ id: 11, sort_order: 1, text: "B" }),
        testAnswer({ id: 12, sort_order: 2, text: "C" }),
      ],
      id: 1,
      text: "Q?",
    });
    const html = adminQuestionPage(q, OWNER_SESSION);
    assertStringIncludes(html, "/answers/11/move-up");
    assertStringIncludes(html, "/answers/11/move-down");
  });

  test("keeps question details readable without write controls in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminQuestionPage(
      { ...question, assign_all: false },
      OWNER_SESSION,
      undefined,
      new Map([[10, 5]]),
      TEST_LISTINGS,
      new Set([1]),
    );
    assertStringIncludes(html, "T-shirt size?");
    assertStringIncludes(html, "<p>Spring Gig</p>");
    assert(
      !html.includes("<p>Summer Gig</p>"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('action="/admin/questions/1/listings"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('action="/admin/questions/1/edit"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/admin/questions/1/answers/10/edit"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/admin/questions/1/delete"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/answers/10/move-"),
      "the value should not contain the searched item",
    );
    // No reorder Order column on the answers table in read-only mode.
    assert(
      !html.includes('<th class="col-reorder">'),
      "the value should not contain the searched item",
    );
  });

  test("joins multiple assigned listing names with a comma in read-only mode", () => {
    // Read-only shows the assigned listings as plain text; two assigned
    // listings must render comma-separated, not run together into one word.
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminQuestionPage(
      { ...question, assign_all: false },
      OWNER_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
      new Set([1, 2]),
    );
    assertStringIncludes(html, "<p>Spring Gig, Summer Gig</p>");
  });

  test("renders empty state when no listings exist", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    assertStringIncludes(html, "Assign to Listings");
    assertStringIncludes(html, "No listings yet");
  });

  test("renders an listing checkbox for each listing", () => {
    const html = adminQuestionPage(
      question,
      OWNER_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
    );
    assertStringIncludes(
      html,
      '<form action="/admin/questions/1/listings" autocomplete="off" method="POST" id="question-listings">',
    );
    assertStringIncludes(html, "<strong>Linked listings (0):</strong>");
    assertStringIncludes(html, 'name="listing_ids"');
    assertStringIncludes(html, 'value="1"');
    assertStringIncludes(html, 'value="2"');
    assertStringIncludes(html, "Spring Gig");
    assertStringIncludes(html, "Summer Gig");
  });

  test("renders the assign-to-all toggle before the listing checkboxes", () => {
    const html = adminQuestionPage(
      { ...question, assign_all: true },
      OWNER_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
    );
    const toggle = html.indexOf('checked name="assign_all" type="checkbox"');
    const firstListing = html.indexOf('name="listing_ids"');
    expect(toggle).toBeGreaterThan(-1);
    expect(firstListing).toBeGreaterThan(toggle);
    assertStringIncludes(html, "Assign to all listings");
  });

  test("shows an '(all)' heading, not a stored-id count, when assign-all is set", () => {
    // assign_all applies to every listing even with no individually-ticked ids,
    // so the count must not read "(0)" next to a checked "Assign to all" toggle.
    const html = adminQuestionPage(
      { ...question, assign_all: true },
      OWNER_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
      new Set(),
    );
    assertStringIncludes(html, "<strong>Linked listings (all):</strong>");
    assert(
      !html.includes("Linked listings (0):"),
      "the value should not contain the searched item",
    );
  });

  test("sorts a deactivated listing last and renders it muted", () => {
    const html = adminQuestionPage(
      question,
      OWNER_SESSION,
      undefined,
      undefined,
      [
        testListingWithCount({ active: false, id: 1, name: "Retired Gig" }),
        testListingWithCount({ active: true, id: 2, name: "Live Gig" }),
      ],
    );
    const live = html.indexOf('value="2"');
    const retired = html.indexOf(
      '<label class="muted"><input name="listing_ids" type="checkbox" value="1"',
    );
    expect(live).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(live);
  });

  test("checks listings the question is assigned to", () => {
    const html = adminQuestionPage(
      question,
      OWNER_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
      new Set([1]),
    );
    assertStringIncludes(
      html,
      'checked name="listing_ids" type="checkbox" value="1"',
    );
    assert(
      !html.includes('checked name="listing_ids" type="checkbox" value="2"'),
      "the value should not contain the searched item",
    );
  });
});
