import { assert, assertStringIncludes } from "@std/assert";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  ListingOverviewPanel,
  overviewStatsFromAttendees,
} from "#templates/admin/listings/overview.tsx";
import { ListingQuestionsPanel } from "#templates/admin/questions.tsx";
import { resetFeaturePageTest } from "#test/ui/templates/admin/feature-page-test.ts";
import {
  singleAnswerSizeQuestionData,
  testAnswer,
  testListingWithCount,
  testQuestion,
} from "#test-utils/factories.ts";
import { setupQuestionPageTest } from "./fixtures.ts";

describe("adminListingQuestionsPage", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  test("shows empty state when no questions exist", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const html = String(
      ListingQuestionsPanel({
        allQuestions: [],
        assignedIds: new Set(),
        listing,
      }),
    );
    // The empty-state prompt keeps a space before the create link.
    assertStringIncludes(
      html,
      'No questions created yet. <a href="/admin/questions">Create questions</a> first.',
    );
  });

  test("shows singular option count for question with one answer", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      testQuestion({
        answers: [testAnswer({ id: 10, text: "Yes" })],
        id: 1,
        text: "Yes or no?",
      }),
    ];
    const html = String(
      ListingQuestionsPanel({
        allQuestions: questions,
        assignedIds: new Set(),
        listing,
      }),
    );
    assertStringIncludes(
      html,
      '<input name="question_ids" type="checkbox" value="1">',
    );
    // A single space sits before the "(1 option…)" summary inside the label.
    assertStringIncludes(html, "<small> (1 option: Yes)</small>");
    assert(
      !html.includes("1 options"),
      "the value should not contain the searched item",
    );
  });

  test("shows Manage questions link below form", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      testQuestion({
        answers: [
          testAnswer({ id: 10, sort_order: 0, text: "A" }),
          testAnswer({ id: 11, sort_order: 1, text: "B" }),
        ],
        id: 1,
        text: "Q?",
      }),
    ];
    const html = String(
      ListingQuestionsPanel({
        allQuestions: questions,
        assignedIds: new Set(),
        listing,
      }),
    );
    assertStringIncludes(html, 'href="/admin/questions"');
    assertStringIncludes(html, "Manage questions");
  });

  test("lists option names in parentheses", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      testQuestion({
        answers: [
          testAnswer({ id: 10, sort_order: 0, text: "S" }),
          testAnswer({ id: 11, sort_order: 1, text: "M" }),
          testAnswer({ id: 12, sort_order: 2, text: "L" }),
        ],
        id: 1,
        text: "Size?",
      }),
    ];
    const html = String(
      ListingQuestionsPanel({
        allQuestions: questions,
        assignedIds: new Set(),
        listing,
      }),
    );
    assertStringIncludes(html, "3 options: S, M, L)");
  });
});

describe("adminListingPage with questionData", () => {
  beforeAll(setupQuestionPageTest);
  afterAll(resetFeaturePageTest);

  test("renders answer summary rows in details table", () => {
    const listing = testListingWithCount({ id: 1, name: "E" });
    const html = String(
      ListingOverviewPanel({
        allowedDomain: "example.com",
        isOwner: false,
        listing,
        noteNames: new Map(),
        publicPage: "available",
        questionData: singleAnswerSizeQuestionData(),
        stats: overviewStatsFromAttendees(listing, []),
      }),
    );
    assertStringIncludes(html, "<th>Size?</th>");
    assertStringIncludes(html, "S (0)");
  });
});
