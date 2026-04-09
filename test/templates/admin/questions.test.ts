import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#lib/csrf.ts";
import {
  adminEventPage,
  buildAnswerSummaryRows,
} from "#templates/admin/events.tsx";
import {
  adminAnswerDeletePage,
  adminEventQuestionsPage,
  adminQuestionDeletePage,
  adminQuestionPage,
  adminQuestionsPage,
} from "#templates/admin/questions.tsx";
import { setupTestEncryptionKey, testEventWithCount } from "#test-utils";

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
          id: 1,
          text: "Favourite colour?",
          answers: [
            { id: 10, question_id: 1, text: "Red", sort_order: 0 },
            { id: 11, question_id: 1, text: "Blue", sort_order: 1 },
          ],
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
          id: 1,
          text: "Yes or no?",
          answers: [{ id: 10, question_id: 1, text: "Yes", sort_order: 0 }],
        },
      ],
      TEST_SESSION,
    );
    expect(html).toContain("1 answer)");
    expect(html).not.toContain("1 answers");
  });

  test("renders error message when provided", () => {
    const html = adminQuestionsPage([], TEST_SESSION, "Something went wrong");
    expect(html).toContain("Something went wrong");
  });
});

describe("adminQuestionPage", () => {
  const question = {
    id: 1,
    text: "T-shirt size?",
    answers: [
      { id: 10, question_id: 1, text: "Small", sort_order: 0 },
      { id: 11, question_id: 1, text: "Large", sort_order: 1 },
    ],
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
      { id: 1, text: "Q?", answers: [] },
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
      id: 1,
      text: "Q?",
      answers: [
        { id: 10, question_id: 1, text: "A", sort_order: 0 },
        { id: 11, question_id: 1, text: "B", sort_order: 1 },
        { id: 12, question_id: 1, text: "C", sort_order: 2 },
      ],
    };
    const html = adminQuestionPage(q, TEST_SESSION);
    expect(html).toContain("/answers/11/move-up");
    expect(html).toContain("/answers/11/move-down");
  });
});

describe("adminQuestionDeletePage", () => {
  const question = {
    id: 1,
    text: "T-shirt size?",
    answers: [{ id: 10, question_id: 1, text: "Small", sort_order: 0 }],
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
    id: 1,
    text: "T-shirt size?",
    answers: [
      { id: 10, question_id: 1, text: "Small", sort_order: 0 },
      { id: 11, question_id: 1, text: "Large", sort_order: 1 },
    ],
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

describe("adminEventQuestionsPage", () => {
  test("shows empty state when no questions exist", () => {
    const event = testEventWithCount({ id: 1, name: "My Event" });
    const html = adminEventQuestionsPage(event, [], new Set(), TEST_SESSION);
    expect(html).toContain("No questions created yet");
    expect(html).toContain('href="/admin/questions"');
    expect(html).toContain("Create questions");
  });

  test("shows singular option count for question with one answer", () => {
    const event = testEventWithCount({ id: 1, name: "My Event" });
    const questions = [
      {
        id: 1,
        text: "Yes or no?",
        answers: [{ id: 10, question_id: 1, text: "Yes", sort_order: 0 }],
      },
    ];
    const html = adminEventQuestionsPage(
      event,
      questions,
      new Set(),
      TEST_SESSION,
    );
    expect(html).toContain("1 option: Yes)");
    expect(html).not.toContain("1 options");
  });

  test("shows Manage Questions link below form", () => {
    const event = testEventWithCount({ id: 1, name: "My Event" });
    const questions = [
      {
        id: 1,
        text: "Q?",
        answers: [
          { id: 10, question_id: 1, text: "A", sort_order: 0 },
          { id: 11, question_id: 1, text: "B", sort_order: 1 },
        ],
      },
    ];
    const html = adminEventQuestionsPage(
      event,
      questions,
      new Set(),
      TEST_SESSION,
    );
    expect(html).toContain('href="/admin/questions"');
    expect(html).toContain("Manage Questions");
  });

  test("lists option names in parentheses", () => {
    const event = testEventWithCount({ id: 1, name: "My Event" });
    const questions = [
      {
        id: 1,
        text: "Size?",
        answers: [
          { id: 10, question_id: 1, text: "S", sort_order: 0 },
          { id: 11, question_id: 1, text: "M", sort_order: 1 },
          { id: 12, question_id: 1, text: "L", sort_order: 2 },
        ],
      },
    ];
    const html = adminEventQuestionsPage(
      event,
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
      buildAnswerSummaryRows({ questions: [], attendeeAnswerMap: new Map() }),
    ).toBe("");
  });

  test("renders question with answer counts", () => {
    const html = buildAnswerSummaryRows({
      questions: [
        {
          id: 1,
          text: "Size?",
          answers: [
            { id: 10, question_id: 1, text: "Small", sort_order: 0 },
            { id: 11, question_id: 1, text: "Large", sort_order: 1 },
          ],
        },
      ],
      attendeeAnswerMap: new Map([
        [1, [10]],
        [2, [10]],
        [3, [11]],
      ]),
    });
    expect(html).toContain("<th>Size?</th>");
    expect(html).toContain("Small (2)");
    expect(html).toContain("Large (1)");
  });

  test("shows zero for answers with no selections", () => {
    const html = buildAnswerSummaryRows({
      questions: [
        {
          id: 1,
          text: "Q?",
          answers: [{ id: 10, question_id: 1, text: "A", sort_order: 0 }],
        },
      ],
      attendeeAnswerMap: new Map(),
    });
    expect(html).toContain("A (0)");
  });
});

describe("adminEventPage with questionData", () => {
  test("renders answer summary rows in details table", () => {
    const html = adminEventPage({
      event: testEventWithCount({ id: 1, name: "E" }),
      attendees: [],
      allowedDomain: "example.com",
      session: TEST_SESSION,
      questionData: {
        questions: [
          {
            id: 1,
            text: "Size?",
            answers: [{ id: 10, question_id: 1, text: "S", sort_order: 0 }],
          },
        ],
        attendeeAnswerMap: new Map(),
      },
    });
    expect(html).toContain("<th>Size?</th>");
    expect(html).toContain("S (0)");
  });
});
