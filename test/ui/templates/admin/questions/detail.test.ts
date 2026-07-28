import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminQuestionPage } from "#templates/admin/questions.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  testAnswer,
  testListingWithCount,
  testQuestion,
} from "#test-utils/factories.ts";
import { resetFeaturePageTest } from "../feature-page-test.ts";
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
    expect(html).toContain("T-shirt size?");
    expect(html).toContain('action="/admin/questions/1/edit"');
    expect(html).toContain('class="active" href="/admin/questions"');
    // The choice-type selector offers radio vs select, with the question's
    // current type (radio) pre-selected.
    expect(html).toContain(
      '<select name="display_type"><option selected value="radio">Radio buttons</option><option value="select">Select box</option></select>',
    );
  });

  test("renders answer list linking to each answer's edit page", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    expect(html).toContain("Small");
    expect(html).toContain("Large");
    expect(html).toContain('href="/admin/questions/1/answers/10/edit"');
    expect(html).toContain('href="/admin/questions/1/answers/11/edit"');
    expect(html).toContain(
      '<form action="/admin/questions/1/answers" autocomplete="off" method="POST" id="add-answer">',
    );
  });

  test("no longer links to answer deletion from the question page", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    expect(html).not.toContain("/admin/questions/1/answers/10/delete");
  });

  test("renders delete question link", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    expect(html).toContain('href="/admin/questions/1/delete"');
  });

  test("renders error message when provided", () => {
    const html = adminQuestionPage(question, OWNER_SESSION, "Error!");
    expect(html).toContain("Error!");
  });

  test("renders empty answers state", () => {
    const html = adminQuestionPage(
      testQuestion({ id: 1, text: "Q?" }),
      OWNER_SESSION,
    );
    expect(html).toContain("No answers yet");
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
    expect(html).toContain(
      '<input name="display_type" type="hidden" value="free_text"',
    );
    expect(html).not.toContain("Radio buttons");
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
    expect(html).not.toContain("/admin/questions/1/answers");
    expect(html).toContain("they have no answer options");
    expect(html).toContain("can't change the price");
    expect(html).toContain("a price modifier attaches to a chosen answer");
  });

  test("renders answers in a table with their selection totals", () => {
    const counts = new Map([
      [10, 5],
      [11, 3],
    ]);
    const html = adminQuestionPage(question, OWNER_SESSION, undefined, counts);
    expect(html).toContain("<table");
    expect(html).toContain('<td class="col-quantity">5</td>');
    expect(html).toContain('<td class="col-quantity">3</td>');
  });

  test("shows zero selections for answers with no stored total", () => {
    const html = adminQuestionPage(
      question,
      OWNER_SESSION,
      undefined,
      new Map(),
    );
    expect(html).toContain('<td class="col-quantity">0</td>');
  });

  test("renders move-up and move-down buttons", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    expect(html).toContain("/answers/10/move-down");
    expect(html).not.toContain("/answers/10/move-up");
    expect(html).toContain("/answers/11/move-up");
    expect(html).not.toContain("/answers/11/move-down");
    // The answers table carries the reorder Order column header when writable.
    expect(html).toContain('<th class="col-reorder">Order</th>');
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
    expect(html).toContain("/answers/11/move-up");
    expect(html).toContain("/answers/11/move-down");
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
    expect(html).toContain("T-shirt size?");
    expect(html).toContain("<p>Spring Gig</p>");
    expect(html).not.toContain("<p>Summer Gig</p>");
    expect(html).not.toContain('action="/admin/questions/1/listings"');
    expect(html).not.toContain('action="/admin/questions/1/edit"');
    expect(html).not.toContain("/admin/questions/1/answers/10/edit");
    expect(html).not.toContain("/admin/questions/1/delete");
    expect(html).not.toContain("/answers/10/move-");
    // No reorder Order column on the answers table in read-only mode.
    expect(html).not.toContain('<th class="col-reorder">');
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
    expect(html).toContain("<p>Spring Gig, Summer Gig</p>");
  });

  test("renders empty state when no listings exist", () => {
    const html = adminQuestionPage(question, OWNER_SESSION);
    expect(html).toContain("Assign to Listings");
    expect(html).toContain("No listings yet");
  });

  test("renders an listing checkbox for each listing", () => {
    const html = adminQuestionPage(
      question,
      OWNER_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
    );
    expect(html).toContain(
      '<form action="/admin/questions/1/listings" autocomplete="off" method="POST" id="question-listings">',
    );
    expect(html).toContain("<strong>Linked listings (0):</strong>");
    expect(html).toContain('name="listing_ids"');
    expect(html).toContain('value="1"');
    expect(html).toContain('value="2"');
    expect(html).toContain("Spring Gig");
    expect(html).toContain("Summer Gig");
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
    expect(html).toContain("Assign to all listings");
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
    expect(html).toContain("<strong>Linked listings (all):</strong>");
    expect(html).not.toContain("Linked listings (0):");
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
    expect(html).toContain(
      'checked name="listing_ids" type="checkbox" value="1"',
    );
    expect(html).not.toContain(
      'checked name="listing_ids" type="checkbox" value="2"',
    );
  });
});
