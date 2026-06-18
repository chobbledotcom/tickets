import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { FormParams } from "#shared/form-data.ts";
import { clearSavedFormData, setSavedFormData } from "#shared/forms.tsx";
import { renderQuestions } from "#templates/public.tsx";

describe("renderQuestions", () => {
  test("returns empty string for no questions", () => {
    expect(renderQuestions([])).toBe("");
  });

  test("renders radio buttons for each answer", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { id: 10, question_id: 1, sort_order: 0, text: "Red" },
          { id: 11, question_id: 1, sort_order: 1, text: "Blue" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Favourite colour?",
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

  test("renders select boxes when configured", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { id: 10, question_id: 1, sort_order: 0, text: "Red" },
          { id: 11, question_id: 1, sort_order: 1, text: "Blue" },
        ],
        display_type: "select" as const,
        id: 1,
        text: "Favourite colour?",
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain('<select name="question_1" required>');
    expect(html).toContain('<option value="">Select an answer</option>');
    expect(html).toContain('<option value="10">Red</option>');
    expect(html).not.toContain('type="radio"');
  });

  test("restores selected select answers from saved form data", () => {
    setSavedFormData(new FormParams({ question_1: "11" }));
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { id: 10, question_id: 1, sort_order: 0, text: "Red" },
          { id: 11, question_id: 1, sort_order: 1, text: "Blue" },
        ],
        display_type: "select" as const,
        id: 1,
        text: "Favourite colour?",
      },
    ];

    const html = renderQuestions(questions);
    clearSavedFormData();

    expect(html).toContain('<option value="11" selected>Blue</option>');
    expect(html).not.toContain('<option value="10" selected>Red</option>');
  });

  test("renders multiple questions", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [{ id: 10, question_id: 1, sort_order: 0, text: "A1" }],
        display_type: "radio" as const,
        id: 1,
        text: "Q1",
      },
      {
        answers: [{ id: 20, question_id: 2, sort_order: 0, text: "A2" }],
        display_type: "radio" as const,
        id: 2,
        text: "Q2",
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain('name="question_1"');
    expect(html).toContain('name="question_2"');
  });

  test("renders answer price modifier labels", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          {
            calc_kind: "fixed",
            calc_value: 2.5,
            direction: "charge",
            id: 10,
            question_id: 1,
            sort_order: 0,
            text: "Premium",
          },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Meal?",
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain("Premium");
    expect(html).toContain("+£2.50");
  });

  test("renders answer price modifier labels in select options", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          {
            calc_kind: "fixed",
            calc_value: 2.5,
            direction: "charge",
            id: 10,
            question_id: 1,
            sort_order: 0,
            text: "Premium",
          },
        ],
        display_type: "select" as const,
        id: 1,
        text: "Meal?",
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain('<option value="10">Premium (+£2.50)</option>');
  });

  test("escapes HTML in question and answer text", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [{ id: 10, question_id: 1, sort_order: 0, text: "S&M" }],
        display_type: "radio" as const,
        id: 1,
        text: "What <b>size</b>?",
      },
    ];

    const html = renderQuestions(questions);

    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("S&amp;M");
    expect(html).not.toContain("<b>size</b>");
  });

  test("adds data-listing-ids when questionListingMap is provided", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [{ id: 10, question_id: 1, sort_order: 0, text: "A1" }],
        display_type: "radio" as const,
        id: 1,
        text: "Q1",
      },
      {
        answers: [{ id: 20, question_id: 2, sort_order: 0, text: "A2" }],
        display_type: "radio" as const,
        id: 2,
        text: "Q2",
      },
    ];
    const listingMap = new Map([
      [1, [100, 200]],
      [2, [200]],
    ]);

    const html = renderQuestions(questions, listingMap);

    expect(html).toContain('data-listing-ids="100 200"');
    expect(html).toContain('data-listing-ids="200"');
  });

  test("omits data-listing-ids when no map provided", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [{ id: 10, question_id: 1, sort_order: 0, text: "A1" }],
        display_type: "radio" as const,
        id: 1,
        text: "Q1",
      },
    ];

    const html = renderQuestions(questions);

    expect(html).not.toContain("data-listing-ids");
  });
});
