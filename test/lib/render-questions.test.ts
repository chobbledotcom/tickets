import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { FormParams } from "#shared/form-data.ts";
import { clearSavedFormData, setSavedFormData } from "#shared/forms.tsx";
import { renderQuestions } from "#templates/public.tsx";

describe("renderQuestions", () => {
  test("returns empty string for no questions", () => {
    expect(renderQuestions([]).toString()).toBe("");
  });

  test("renders radio buttons for each answer", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "Red" },
          { active: true, id: 11, question_id: 1, sort_order: 1, text: "Blue" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Favourite colour?",
      },
    ];

    const html = renderQuestions(questions).toString();

    expect(html).toContain("Favourite colour?");
    expect(html).toContain('name="question_1"');
    expect(html).toContain('value="10"');
    expect(html).toContain("Red");
    expect(html).toContain('value="11"');
    expect(html).toContain("Blue");
    expect(html).toContain("required");
    expect(html).toContain("<fieldset");
  });

  test("omits a choice question whose answers are all deactivated", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: false, id: 10, question_id: 1, sort_order: 0, text: "Red" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Favourite colour?",
      },
    ];

    expect(renderQuestions(questions).toString()).toBe("");
  });

  test("omits deactivated answers from the public form", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "Red" },
          {
            active: false,
            id: 11,
            question_id: 1,
            sort_order: 1,
            text: "Blue",
          },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Favourite colour?",
      },
    ];

    const html = renderQuestions(questions).toString();

    expect(html).toContain("Red");
    expect(html).not.toContain("Blue");
    expect(html).not.toContain('value="11"');
  });

  test("renders select boxes when configured", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "Red" },
          { active: true, id: 11, question_id: 1, sort_order: 1, text: "Blue" },
        ],
        display_type: "select" as const,
        id: 1,
        text: "Favourite colour?",
      },
    ];

    const html = renderQuestions(questions).toString();

    // The question text labels the <select> via a wrapping <label>, so the
    // control has an accessible name without a separate screen-reader element.
    expect(html).toContain(
      '<label class="custom-question">Favourite colour?<select',
    );
    expect(html).toContain('<select name="question_1" required>');
    expect(html).toContain('<option value="">Select an answer</option>');
    expect(html).toContain('<option value="10">Red</option>');
    expect(html).not.toContain('type="radio"');
  });

  test("renders a free-text input when configured", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [],
        display_type: "free_text" as const,
        id: 1,
        text: "Your name?",
      },
    ];

    const html = renderQuestions(questions).toString();

    // The question text labels the text input via a wrapping <label>, matching
    // the select case, so the control has an accessible name on its own.
    expect(html).toContain('<label class="custom-question">Your name?<input');
    expect(html).toContain('name="question_1"');
    expect(html).toContain('type="text"');
    expect(html).toContain("required");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('type="radio"');
  });

  test("restores a saved free-text answer from saved form data", () => {
    setSavedFormData(new FormParams({ question_1: "Ada Lovelace" }));
    const questions: QuestionWithAnswers[] = [
      {
        answers: [],
        display_type: "free_text" as const,
        id: 1,
        text: "Your name?",
      },
    ];

    const html = renderQuestions(questions).toString();
    clearSavedFormData();

    expect(html).toContain('value="Ada Lovelace"');
  });

  test("restores selected select answers from saved form data", () => {
    setSavedFormData(new FormParams({ question_1: "11" }));
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "Red" },
          { active: true, id: 11, question_id: 1, sort_order: 1, text: "Blue" },
        ],
        display_type: "select" as const,
        id: 1,
        text: "Favourite colour?",
      },
    ];

    const html = renderQuestions(questions).toString();
    clearSavedFormData();

    expect(html).toContain('<option selected value="11">Blue</option>');
    expect(html).not.toContain('<option selected value="10">Red</option>');
  });

  test("renders multiple questions", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "A1" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Q1",
      },
      {
        answers: [
          { active: true, id: 20, question_id: 2, sort_order: 0, text: "A2" },
        ],
        display_type: "radio" as const,
        id: 2,
        text: "Q2",
      },
    ];

    const html = renderQuestions(questions).toString();

    expect(html).toContain('name="question_1"');
    expect(html).toContain('name="question_2"');
  });

  test("escapes HTML in question and answer text", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "S&M" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "What <b>size</b>?",
      },
    ];

    const html = renderQuestions(questions).toString();

    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("S&amp;M");
    expect(html).not.toContain("<b>size</b>");
  });

  test("adds data-listing-ids when questionListingMap is provided", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "A1" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Q1",
      },
      {
        answers: [
          { active: true, id: 20, question_id: 2, sort_order: 0, text: "A2" },
        ],
        display_type: "radio" as const,
        id: 2,
        text: "Q2",
      },
    ];
    const listingMap = new Map([
      [1, [100, 200]],
      [2, [200]],
    ]);

    const html = renderQuestions(questions, listingMap).toString();

    expect(html).toContain('data-listing-ids="100 200"');
    expect(html).toContain('data-listing-ids="200"');
  });

  test("omits data-listing-ids when no map provided", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "A1" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "Q1",
      },
    ];

    const html = renderQuestions(questions).toString();

    expect(html).not.toContain("data-listing-ids");
  });
});
