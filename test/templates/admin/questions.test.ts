import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  adminListingPage,
  buildAnswerSummaryRows,
} from "#templates/admin/listings.tsx";
import {
  adminAnswerDeletePage,
  adminListingQuestionsPage,
  adminQuestionDeletePage,
  adminQuestionPage,
  adminQuestionsPage,
} from "#templates/admin/questions.tsx";
import { setupTestEncryptionKey, testListingWithCount } from "#test-utils";

const TEST_LISTINGS = [
  testListingWithCount({ id: 1, name: "Spring Gig" }),
  testListingWithCount({ id: 2, name: "Summer Gig" }),
];

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminQuestionsPage", () => {
  test("renders empty state when no questions", () => {
    const html = adminQuestionsPage([], TEST_SESSION);
    expect(html).toContain("No custom questions yet");
  });

  test("renders question list with answer counts", () => {
    const html = adminQuestionsPage(
      [
        {
          answers: [
            { id: 10, question_id: 1, sort_order: 0, text: "Red" },
            { id: 11, question_id: 1, sort_order: 1, text: "Blue" },
          ],
          display_type: "radio" as const,
          id: 1,
          text: "Favourite colour?",
        },
      ],
      TEST_SESSION,
    );
    expect(html).toContain("Favourite colour?");
    expect(html).toContain("2 answers");
  });

  test("renders singular answer count for one answer", () => {
    const html = adminQuestionsPage(
      [
        {
          answers: [{ id: 10, question_id: 1, sort_order: 0, text: "Yes" }],
          display_type: "radio" as const,
          id: 1,
          text: "Yes or no?",
        },
      ],
      TEST_SESSION,
    );
    expect(html).toContain("1 answer)");
    expect(html).not.toContain("1 answers");
  });

  test("renders reorder controls: down on the first, up on the last", () => {
    const html = adminQuestionsPage(
      [
        {
          answers: [{ id: 10, question_id: 1, sort_order: 0, text: "A" }],
          display_type: "radio" as const,
          id: 1,
          text: "First Q",
        },
        {
          answers: [{ id: 20, question_id: 2, sort_order: 0, text: "B" }],
          display_type: "radio" as const,
          id: 2,
          text: "Second Q",
        },
      ],
      TEST_SESSION,
    );
    // First question: down button, but no up button.
    expect(html).toContain("/admin/questions/1/move-down");
    expect(html).not.toContain("/admin/questions/1/move-up");
    // Last question: up button, but no down button.
    expect(html).toContain("/admin/questions/2/move-up");
    expect(html).not.toContain("/admin/questions/2/move-down");
  });

  test("renders error message when provided", () => {
    const html = adminQuestionsPage([], TEST_SESSION, "Something went wrong");
    expect(html).toContain("Something went wrong");
  });
});

describe("adminQuestionPage", () => {
  const question = {
    answers: [
      { id: 10, question_id: 1, sort_order: 0, text: "Small" },
      { id: 11, question_id: 1, sort_order: 1, text: "Large" },
    ],
    display_type: "radio" as const,
    id: 1,
    text: "T-shirt size?",
  };

  test("renders question text and edit form", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain("T-shirt size?");
    expect(html).toContain('action="/admin/questions/1/edit"');
  });

  test("renders answer list with delete links", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain("Small");
    expect(html).toContain("Large");
    expect(html).toContain("/admin/questions/1/answers/10/delete");
    expect(html).toContain("/admin/questions/1/answers/11/delete");
  });

  test("renders delete question link", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain('href="/admin/questions/1/delete"');
  });

  test("renders error message when provided", () => {
    const html = adminQuestionPage(question, TEST_SESSION, "Error!");
    expect(html).toContain("Error!");
  });

  test("renders empty answers state", () => {
    const html = adminQuestionPage(
      { answers: [], display_type: "radio" as const, id: 1, text: "Q?" },
      TEST_SESSION,
    );
    expect(html).toContain("No answers yet");
  });

  test("renders answer counts when provided", () => {
    const counts = new Map([
      [10, 5],
      [11, 3],
    ]);
    const html = adminQuestionPage(question, TEST_SESSION, undefined, counts);
    expect(html).toContain("(5)");
    expect(html).toContain("(3)");
  });

  test("renders move-up and move-down buttons", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain("/answers/10/move-down");
    expect(html).not.toContain("/answers/10/move-up");
    expect(html).toContain("/answers/11/move-up");
    expect(html).not.toContain("/answers/11/move-down");
  });

  test("renders both move buttons for middle answer", () => {
    const q = {
      answers: [
        { id: 10, question_id: 1, sort_order: 0, text: "A" },
        { id: 11, question_id: 1, sort_order: 1, text: "B" },
        { id: 12, question_id: 1, sort_order: 2, text: "C" },
      ],
      display_type: "radio" as const,
      id: 1,
      text: "Q?",
    };
    const html = adminQuestionPage(q, TEST_SESSION);
    expect(html).toContain("/answers/11/move-up");
    expect(html).toContain("/answers/11/move-down");
  });

  test("renders empty state when no listings exist", () => {
    const html = adminQuestionPage(question, TEST_SESSION);
    expect(html).toContain("Assign to Listings");
    expect(html).toContain("No listings yet");
  });

  test("renders an listing checkbox for each listing", () => {
    const html = adminQuestionPage(
      question,
      TEST_SESSION,
      undefined,
      undefined,
      TEST_LISTINGS,
    );
    expect(html).toContain('action="/admin/questions/1/listings"');
    expect(html).toContain('name="listing_ids"');
    expect(html).toContain('value="1"');
    expect(html).toContain('value="2"');
    expect(html).toContain("Spring Gig");
    expect(html).toContain("Summer Gig");
  });

  test("checks listings the question is assigned to", () => {
    const html = adminQuestionPage(
      question,
      TEST_SESSION,
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

describe("adminQuestionDeletePage", () => {
  const question = {
    answers: [{ id: 10, question_id: 1, sort_order: 0, text: "Small" }],
    display_type: "radio" as const,
    id: 1,
    text: "T-shirt size?",
  };

  test("renders confirmation form with question text", () => {
    const html = adminQuestionDeletePage(question, TEST_SESSION);
    expect(html).toContain("Delete Question");
    expect(html).toContain("T-shirt size?");
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('action="/admin/questions/1/delete"');
  });

  test("warns about cascading deletes", () => {
    const html = adminQuestionDeletePage(question, TEST_SESSION);
    expect(html).toContain("all its answers");
    expect(html).toContain("attendee responses");
  });

  test("renders error message when provided", () => {
    const html = adminQuestionDeletePage(
      question,
      TEST_SESSION,
      "Text does not match",
    );
    expect(html).toContain("Text does not match");
  });
});

describe("adminAnswerDeletePage", () => {
  const question = {
    answers: [
      { id: 10, question_id: 1, sort_order: 0, text: "Small" },
      { id: 11, question_id: 1, sort_order: 1, text: "Large" },
    ],
    display_type: "radio" as const,
    id: 1,
    text: "T-shirt size?",
  };
  const answer = question.answers[0]!;

  test("renders confirmation form with answer text", () => {
    const html = adminAnswerDeletePage(question, answer, TEST_SESSION);
    expect(html).toContain("Delete Answer");
    expect(html).toContain("Small");
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('action="/admin/questions/1/answers/10/delete"');
  });

  test("shows question context", () => {
    const html = adminAnswerDeletePage(question, answer, TEST_SESSION);
    expect(html).toContain("T-shirt size?");
  });

  test("renders error message when provided", () => {
    const html = adminAnswerDeletePage(
      question,
      answer,
      TEST_SESSION,
      "Text does not match",
    );
    expect(html).toContain("Text does not match");
  });
});

describe("adminListingQuestionsPage", () => {
  test("shows empty state when no questions exist", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const html = adminListingQuestionsPage(
      listing,
      [],
      new Set(),
      TEST_SESSION,
    );
    expect(html).toContain("No questions created yet");
    expect(html).toContain('href="/admin/questions"');
    expect(html).toContain("Create questions");
  });

  test("shows singular option count for question with one answer", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      {
        answers: [{ id: 10, question_id: 1, sort_order: 0, text: "Yes" }],
        display_type: "radio" as const,
        id: 1,
        text: "Yes or no?",
      },
    ];
    const html = adminListingQuestionsPage(
      listing,
      questions,
      new Set(),
      TEST_SESSION,
    );
    expect(html).toContain("1 option: Yes)");
    expect(html).not.toContain("1 options");
  });

  test("shows Manage Questions link below form", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      {
        answers: [
          { id: 10, question_id: 1, sort_order: 0, text: "A" },
          { id: 11, question_id: 1, sort_order: 1, text: "B" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Q?",
      },
    ];
    const html = adminListingQuestionsPage(
      listing,
      questions,
      new Set(),
      TEST_SESSION,
    );
    expect(html).toContain('href="/admin/questions"');
    expect(html).toContain("Manage Questions");
  });

  test("lists option names in parentheses", () => {
    const listing = testListingWithCount({ id: 1, name: "My Listing" });
    const questions = [
      {
        answers: [
          { id: 10, question_id: 1, sort_order: 0, text: "S" },
          { id: 11, question_id: 1, sort_order: 1, text: "M" },
          { id: 12, question_id: 1, sort_order: 2, text: "L" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Size?",
      },
    ];
    const html = adminListingQuestionsPage(
      listing,
      questions,
      new Set(),
      TEST_SESSION,
    );
    expect(html).toContain("3 options: S, M, L)");
  });
});

describe("buildAnswerSummaryRows", () => {
  test("returns empty string when questionData is undefined", () => {
    expect(buildAnswerSummaryRows(undefined)).toBe("");
  });

  test("returns empty string when no questions", () => {
    expect(
      buildAnswerSummaryRows({ attendeeAnswerMap: new Map(), questions: [] }),
    ).toBe("");
  });

  test("renders question with answer counts", () => {
    const html = buildAnswerSummaryRows({
      attendeeAnswerMap: new Map([
        [1, [10]],
        [2, [10]],
        [3, [11]],
      ]),
      questions: [
        {
          answers: [
            { id: 10, question_id: 1, sort_order: 0, text: "Small" },
            { id: 11, question_id: 1, sort_order: 1, text: "Large" },
          ],
          display_type: "radio" as const,
          id: 1,
          text: "Size?",
        },
      ],
    });
    expect(html).toContain("<th>Size?</th>");
    expect(html).toContain("Small (2)");
    expect(html).toContain("Large (1)");
  });

  test("shows zero for answers with no selections", () => {
    const html = buildAnswerSummaryRows({
      attendeeAnswerMap: new Map(),
      questions: [
        {
          answers: [{ id: 10, question_id: 1, sort_order: 0, text: "A" }],
          display_type: "radio" as const,
          id: 1,
          text: "Q?",
        },
      ],
    });
    expect(html).toContain("A (0)");
  });
});

describe("adminListingPage with questionData", () => {
  test("renders answer summary rows in details table", () => {
    const html = adminListingPage({
      allowedDomain: "example.com",
      attendees: [],
      listing: testListingWithCount({ id: 1, name: "E" }),
      questionData: {
        attendeeAnswerMap: new Map(),
        questions: [
          {
            answers: [{ id: 10, question_id: 1, sort_order: 0, text: "S" }],
            display_type: "radio" as const,
            id: 1,
            text: "Size?",
          },
        ],
      },
      session: TEST_SESSION,
    });
    expect(html).toContain("<th>Size?</th>");
    expect(html).toContain("S (0)");
  });
});
