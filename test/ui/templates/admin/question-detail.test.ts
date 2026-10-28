import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  QuestionAnswersSection,
  QuestionEditPanel,
  QuestionListingsSection,
} from "#templates/admin/question-detail.tsx";
import { resetFeaturePageTest } from "#test/ui/templates/admin/feature-page-test.ts";
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
} from "./questions/fixtures.ts";

describe("QuestionEditPanel", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const question = tShirtQuestion;

  test("renders question text and edit form", () => {
    const html = String(QuestionEditPanel({ question }));
    assertStringIncludes(html, "T-shirt size?");
    assertStringIncludes(html, 'action="/admin/questions/1/edit"');
    // The choice-type selector offers radio vs select, with the question's
    // current type (radio) pre-selected.
    assertStringIncludes(
      html,
      '<select name="display_type"><option selected value="radio">Radio buttons</option><option value="select">Select box</option></select>',
    );
  });

  test("locks the type on a free-text question's edit form", () => {
    const html = String(
      QuestionEditPanel({
        question: testQuestion({
          display_type: "free_text",
          id: 1,
          text: "Notes?",
        }),
      }),
    );
    // No selector — a hidden field keeps it free-text and the choice options
    // are not offered.
    assertStringIncludes(
      html,
      '<input name="display_type" type="hidden" value="free_text"',
    );
    assert(!html.includes("Radio buttons"));
    // The free-text note renders inside its prose block, so a free-text
    // question still explains why it has no answers.
    assertStringIncludes(html, '<div class="prose">');
    assertStringIncludes(html, "Free-text questions collect a typed answer");
  });

  test("hides the edit form in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = String(QuestionEditPanel({ question }));
    assert(!html.includes('action="/admin/questions/1/edit"'));
  });
});

describe("QuestionAnswersSection", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const question = tShirtQuestion;

  test("renders answer list linking to each answer's edit page", () => {
    const html = String(
      QuestionAnswersSection({ answerCounts: new Map(), question }),
    );
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
    const html = String(
      QuestionAnswersSection({ answerCounts: new Map(), question }),
    );
    assert(!html.includes("/admin/questions/1/answers/10/delete"));
  });

  test("renders empty answers state", () => {
    const html = String(
      QuestionAnswersSection({
        answerCounts: new Map(),
        question: testQuestion({ id: 1, text: "Q?" }),
      }),
    );
    assertStringIncludes(html, "No answers yet");
  });

  test("renders nothing for a free-text question", () => {
    expect(
      QuestionAnswersSection({
        answerCounts: new Map(),
        question: testQuestion({
          display_type: "free_text",
          id: 1,
          text: "Notes?",
        }),
      }),
    ).toBeNull();
  });

  test("renders answers in a table with their selection totals", () => {
    const counts = new Map([
      [10, 5],
      [11, 3],
    ]);
    const html = String(
      QuestionAnswersSection({ answerCounts: counts, question }),
    );
    assertStringIncludes(html, "<table");
    assertStringIncludes(html, '<td class="col-quantity">5</td>');
    assertStringIncludes(html, '<td class="col-quantity">3</td>');
  });

  test("shows zero selections for answers with no stored total", () => {
    const html = String(
      QuestionAnswersSection({ answerCounts: new Map(), question }),
    );
    assertStringIncludes(html, '<td class="col-quantity">0</td>');
  });

  test("renders move-up and move-down buttons", () => {
    const html = String(
      QuestionAnswersSection({ answerCounts: new Map(), question }),
    );
    assertStringIncludes(html, "/answers/10/move-down");
    assert(!html.includes("/answers/10/move-up"));
    assertStringIncludes(html, "/answers/11/move-up");
    assert(!html.includes("/answers/11/move-down"));
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
    const html = String(
      QuestionAnswersSection({ answerCounts: new Map(), question: q }),
    );
    assertStringIncludes(html, "/answers/11/move-up");
    assertStringIncludes(html, "/answers/11/move-down");
  });

  test("hides the write controls in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = String(
      QuestionAnswersSection({ answerCounts: new Map(), question }),
    );
    assert(!html.includes('action="/admin/questions/1/answers"'));
    assert(!html.includes("/admin/questions/1/answers/10/edit"));
    assert(!html.includes("/answers/10/move-"));
    assert(!html.includes('<th class="col-reorder">'));
  });
});

describe("QuestionListingsSection", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  const question = tShirtQuestion;

  test("renders empty state when no listings exist", () => {
    const html = String(
      QuestionListingsSection({
        allListings: [],
        assignedListingIds: new Set(),
        question,
      }),
    );
    assertStringIncludes(html, "Assign to Listings");
    assertStringIncludes(html, "No listings yet");
  });

  test("renders an listing checkbox for each listing", () => {
    const html = String(
      QuestionListingsSection({
        allListings: TEST_LISTINGS,
        assignedListingIds: new Set(),
        question,
      }),
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
    const html = String(
      QuestionListingsSection({
        allListings: TEST_LISTINGS,
        assignedListingIds: new Set(),
        question: { ...question, assign_all: true },
      }),
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
    const html = String(
      QuestionListingsSection({
        allListings: TEST_LISTINGS,
        assignedListingIds: new Set(),
        question: { ...question, assign_all: true },
      }),
    );
    assertStringIncludes(html, "<strong>Linked listings (all):</strong>");
    assert(!html.includes("Linked listings (0):"));
  });

  test("sorts a deactivated listing last and renders it muted", () => {
    const html = String(
      QuestionListingsSection({
        allListings: [
          testListingWithCount({ active: false, id: 1, name: "Retired Gig" }),
          testListingWithCount({ active: true, id: 2, name: "Live Gig" }),
        ],
        assignedListingIds: new Set(),
        question,
      }),
    );
    const live = html.indexOf('value="2"');
    const retired = html.indexOf(
      '<label class="muted"><input name="listing_ids" type="checkbox" value="1"',
    );
    expect(live).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(live);
  });

  test("checks listings the question is assigned to", () => {
    const html = String(
      QuestionListingsSection({
        allListings: TEST_LISTINGS,
        assignedListingIds: new Set([1]),
        question,
      }),
    );
    assertStringIncludes(
      html,
      'checked name="listing_ids" type="checkbox" value="1"',
    );
    assert(
      !html.includes('checked name="listing_ids" type="checkbox" value="2"'),
    );
  });

  test("joins multiple assigned listing names with a comma in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = String(
      QuestionListingsSection({
        allListings: TEST_LISTINGS,
        assignedListingIds: new Set([1, 2]),
        question: { ...question, assign_all: false },
      }),
    );
    assertStringIncludes(html, "<p>Spring Gig, Summer Gig</p>");
    assert(!html.includes('action="/admin/questions/1/listings"'));
  });
});
