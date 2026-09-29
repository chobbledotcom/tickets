import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  BookedAnswer,
  QuestionWithAnswers,
  SelectedQuestionAnswers,
} from "#db/question-types.ts";
import {
  answerNote,
  answerRows,
  atBookingHints,
  noteLines,
} from "#templates/admin/answer-rows.ts";
import { AttendeeAnswersTable } from "#templates/admin/attendee-detail.tsx";

const questions: QuestionWithAnswers[] = [
  {
    answers: [
      { active: true, id: 10, question_id: 1, sort_order: 0, text: "Small" },
      { active: true, id: 11, question_id: 1, sort_order: 1, text: "Large" },
    ],
    display_type: "radio",
    id: 1,
    text: "Shirt size?",
  },
  {
    answers: [
      { active: true, id: 20, question_id: 2, sort_order: 0, text: "Vegan" },
    ],
    display_type: "radio",
    id: 2,
    text: "Meal?",
  },
  { answers: [], display_type: "free_text", id: 3, text: "Allergies?" },
];

const selected = (
  overrides: Partial<SelectedQuestionAnswers> = {},
): SelectedQuestionAnswers => ({
  atBooking: [],
  questions,
  selectedAnswerIds: [],
  selectedTextAnswers: new Map(),
  ...overrides,
});

const booked = (overrides: Partial<BookedAnswer> = {}): BookedAnswer => ({
  answer: "Large",
  answerAtBooking: "Large",
  askedAs: "Shirt size?",
  changed: false,
  changesPrice: false,
  question: "Shirt size?",
  questionId: 1,
  ...overrides,
});

describe("answerNote", () => {
  const cases: [
    string,
    Partial<BookedAnswer>,
    ReturnType<typeof answerNote>,
  ][] = [
    ["the same answer and wording", {}, { kind: "none" }],
    [
      "a changed answer",
      { answer: "Small", changed: true },
      { atBooking: "Large", changesPrice: false, kind: "changed" },
    ],
    [
      "an answer added to a blank question",
      { answerAtBooking: null, changed: true },
      { atBooking: null, changesPrice: false, kind: "changed" },
    ],
    [
      "a changed answer that moves the price",
      { answer: "Small", changed: true, changesPrice: true },
      { atBooking: "Large", changesPrice: true, kind: "changed" },
    ],
    [
      "an edited question",
      { question: "Your shirt size?" },
      { answer: null, kind: "reworded", question: "Shirt size?" },
    ],
    [
      "an edited answer",
      { answer: "Big" },
      { answer: "Large", kind: "reworded", question: null },
    ],
    [
      "a deleted question, even with a changed answer",
      { changed: true, question: null },
      { kind: "question-deleted" },
    ],
    [
      "a changed answer on an edited question",
      { answer: "Small", changed: true, question: "Your shirt size?" },
      { atBooking: "Large", changesPrice: false, kind: "changed" },
    ],
  ];
  for (const [name, row, expected] of cases) {
    test(`reads ${name}`, () => {
      expect(answerNote(booked(row))).toEqual(expected);
    });
  }
});

describe("noteLines", () => {
  test("names the answer at booking", () => {
    expect(
      noteLines({ atBooking: "Large", changesPrice: false, kind: "changed" }),
    ).toEqual(['Changed. At booking: "Large".']);
  });

  test("says the booking left the question blank", () => {
    expect(
      noteLines({ atBooking: null, changesPrice: false, kind: "changed" }),
    ).toEqual(["Changed. At booking: no answer."]);
  });

  test("warns that the price was not updated", () => {
    expect(
      noteLines({ atBooking: "Large", changesPrice: true, kind: "changed" }),
    ).toEqual([
      'Changed. At booking: "Large".',
      "Warning: This answer changes the price. The price was not updated.",
    ]);
  });

  test("quotes the old question and answer wording", () => {
    expect(
      noteLines({ answer: "Big", kind: "reworded", question: "Size?\nPick" }),
    ).toEqual([
      'When they booked, the question said: "Size? / Pick".',
      'When they booked, the answer said: "Big".',
    ]);
  });

  test("quotes only the old question wording when the answer kept its words", () => {
    expect(
      noteLines({ answer: null, kind: "reworded", question: "Size?" }),
    ).toEqual(['When they booked, the question said: "Size?".']);
  });

  test("quotes only the old answer wording when the question kept its words", () => {
    expect(
      noteLines({ answer: "Big", kind: "reworded", question: null }),
    ).toEqual(['When they booked, the answer said: "Big".']);
  });

  test("names a deleted question", () => {
    expect(noteLines({ kind: "question-deleted" })).toEqual([
      "This question was deleted.",
    ]);
  });

  test("adds nothing when the answer is unchanged", () => {
    expect(noteLines({ kind: "none" })).toEqual([]);
  });
});

describe("answerRows without a record of the booking", () => {
  test("lists only the answered questions, free text included", () => {
    expect(
      answerRows(
        selected({
          selectedAnswerIds: [11],
          selectedTextAnswers: new Map([[3, "Peanuts"]]),
        }),
      ),
    ).toEqual([
      { answer: "Large", notes: [], question: "Shirt size?" },
      { answer: "Peanuts", notes: [], question: "Allergies?" },
    ]);
  });

  test("joins every chosen answer of one question with a comma", () => {
    expect(answerRows(selected({ selectedAnswerIds: [10, 11] }))).toEqual([
      { answer: "Small, Large", notes: [], question: "Shirt size?" },
    ]);
  });
});

describe("answerRows with a record of the booking", () => {
  test("puts the note under a changed answer", () => {
    expect(
      answerRows(
        selected({ atBooking: [booked({ answer: "Small", changed: true })] }),
      ),
    ).toEqual([
      {
        answer: "Small",
        notes: ['Changed. At booking: "Large".'],
        question: "Shirt size?",
      },
    ]);
  });

  test("shows an answer an admin cleared as no answer", () => {
    expect(
      answerRows(
        selected({ atBooking: [booked({ answer: null, changed: true })] }),
      ),
    ).toEqual([
      {
        answer: "No answer",
        notes: ['Changed. At booking: "Large".'],
        question: "Shirt size?",
      },
    ]);
  });

  test("shows a deleted question with its wording and answer at booking", () => {
    expect(
      answerRows(
        selected({
          atBooking: [booked({ answer: null, changed: true, question: null })],
        }),
      ),
    ).toEqual([
      {
        answer: "Large",
        notes: ["This question was deleted."],
        question: "Shirt size?",
      },
    ]);
  });

  test("leaves out a question blank at booking and blank now", () => {
    expect(
      answerRows(
        selected({
          atBooking: [booked({ answer: null, answerAtBooking: null })],
        }),
      ),
    ).toEqual([]);
  });

  test("leaves out a deleted question the booking left blank", () => {
    expect(
      answerRows(
        selected({
          atBooking: [
            booked({ answer: null, answerAtBooking: null, question: null }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("throws when a row has no wording at all", () => {
    expect(() =>
      answerRows(
        selected({
          atBooking: [booked({ askedAs: null, changed: true, question: null })],
        }),
      ),
    ).toThrow("Question 1 has no wording now or at booking");
  });
});

describe("atBookingHints", () => {
  test("gives a hint for each changed question only", () => {
    expect(
      atBookingHints([
        booked({ answer: "Small", changed: true }),
        booked({ answerAtBooking: null, changed: true, questionId: 3 }),
        booked({ questionId: 2 }),
        booked({ changed: true, question: null, questionId: 4 }),
      ]),
    ).toEqual(
      new Map([
        [1, 'Changed. At booking: "Large".'],
        [3, "Changed. At booking: no answer."],
      ]),
    );
  });
});

describe("AttendeeAnswersTable", () => {
  test("renders each answer and its notes", () => {
    const html = String(
      AttendeeAnswersTable(
        selected({
          atBooking: [
            booked({ answer: "Small", changed: true, changesPrice: true }),
          ],
        }),
      ),
    );
    expect(html).toContain("Answers");
    expect(html).toContain("Shirt size?");
    expect(html).toContain(">Small<br>");
    expect(html).toContain(
      "<small>Changed. At booking: &quot;Large&quot;.</small>",
    );
    expect(html).toContain(
      "<small>Warning: This answer changes the price. The price was not updated.</small>",
    );
  });

  test("returns null when the attendee answered no questions", () => {
    // Null lets the caller drop the section entirely (JSX renders it as empty).
    expect(AttendeeAnswersTable(selected())).toBeNull();
  });
});
