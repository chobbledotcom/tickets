import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import { renderQuestions } from "#templates/public.tsx";

describe("renderQuestions", () => {
  test("returns empty string for no questions", () => {
    expect(renderQuestions([])).toBe("");
  });

  test("renders radio buttons for each answer", () => {
    const questions: QuestionWithAnswers[] = [
      {
        id: 1,
        text: "Favourite colour?",
        answers: [
          { id: 10, question_id: 1, text: "Red", sort_order: 0 },
          { id: 11, question_id: 1, text: "Blue", sort_order: 1 },
        ],
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain("Favourite colour?");
    expect(html).toContain('name="question_1"');
    expect(html).toContain('value="10"');
    expect(html).toContain("Red");
    expect(html).toContain('value="11"');
    expect(html).toContain("Blue");
    expect(html).toContain("required");
    expect(html).toContain("<fieldset");
  });

  test("renders multiple questions", () => {
    const questions: QuestionWithAnswers[] = [
      {
        id: 1,
        text: "Q1",
        answers: [{ id: 10, question_id: 1, text: "A1", sort_order: 0 }],
      },
      {
        id: 2,
        text: "Q2",
        answers: [{ id: 20, question_id: 2, text: "A2", sort_order: 0 }],
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain('name="question_1"');
    expect(html).toContain('name="question_2"');
  });

  test("escapes HTML in question and answer text", () => {
    const questions: QuestionWithAnswers[] = [
      {
        id: 1,
        text: "What <b>size</b>?",
        answers: [{ id: 10, question_id: 1, text: "S&M", sort_order: 0 }],
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("S&amp;M");
    expect(html).not.toContain("<b>size</b>");
  });

  test("adds data-event-ids when questionEventMap is provided", () => {
    const questions: QuestionWithAnswers[] = [
      {
        id: 1,
        text: "Q1",
        answers: [{ id: 10, question_id: 1, text: "A1", sort_order: 0 }],
      },
      {
        id: 2,
        text: "Q2",
        answers: [{ id: 20, question_id: 2, text: "A2", sort_order: 0 }],
      },
    ];
    const eventMap = new Map([
      [1, [100, 200]],
      [2, [200]],
    ]);

    const html = renderQuestions(questions, eventMap);

    expect(html).toContain('data-event-ids="100 200"');
    expect(html).toContain('data-event-ids="200"');
  });

  test("omits data-event-ids when no map provided", () => {
    const questions: QuestionWithAnswers[] = [
      {
        id: 1,
        text: "Q1",
        answers: [{ id: 10, question_id: 1, text: "A1", sort_order: 0 }],
      },
    ];

    const html = renderQuestions(questions);

    expect(html).not.toContain("data-event-ids");
  });
});
