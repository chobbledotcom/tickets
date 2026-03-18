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
          { id: 10, question_id: 1, text: "Red" },
          { id: 11, question_id: 1, text: "Blue" },
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
        answers: [{ id: 10, question_id: 1, text: "A1" }],
      },
      {
        id: 2,
        text: "Q2",
        answers: [{ id: 20, question_id: 2, text: "A2" }],
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
        answers: [{ id: 10, question_id: 1, text: "S&M" }],
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("S&amp;M");
    expect(html).not.toContain("<b>size</b>");
  });
});
