import { expect } from "@std/expect";
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
    expect(html).toContain(
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
    expect(html).toContain(
      '<input name="question_ids" type="checkbox" value="1">',
    );
    // A single space sits before the "(1 option…)" summary inside the label.
    expect(html).toContain("<small> (1 option: Yes)</small>");
    expect(html).not.toContain("1 options");
  });

  test("shows Manage Questions link below form", () => {
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
    expect(html).toContain('href="/admin/questions"');
    expect(html).toContain("Manage Questions");
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
    expect(html).toContain("3 options: S, M, L)");
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
        listing,
        noteNames: new Map(),
        questionData: singleAnswerSizeQuestionData(),
        stats: overviewStatsFromAttendees(listing, []),
      }),
    );
    expect(html).toContain("<th>Size?</th>");
    expect(html).toContain("S (0)");
  });
});
