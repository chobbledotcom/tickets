import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { FormParams } from "#shared/form-data.ts";
import { clearSavedFormData, setSavedFormData } from "#shared/forms.tsx";
import { renderQuestions } from "#templates/public.tsx";
import { testAnswer, testQuestion, testRadioQuestion } from "#test-utils";

/** Two single-answer radio questions — the shared fixture for the
 *  "multiple questions" and "data-listing-ids" tests. */
const twoRadioQuestions = (): QuestionWithAnswers[] => [
  testRadioQuestion(1, "Q1", [[10, "A1"]]),
  testRadioQuestion(2, "Q2", [[20, "A2"]]),
];

/** The "Favourite colour?" question with Red/Blue radio answers — the
 *  canonical single-question fixture reused across radio, select, and
 *  saved-form-data tests. Override `display_type` for the select variant. */
const colourQuestion = (
  displayType: "radio" | "select" = "radio",
): QuestionWithAnswers[] => [
  testQuestion({
    answers: [
      testAnswer({ id: 10, sort_order: 0, text: "Red" }),
      testAnswer({ id: 11, sort_order: 1, text: "Blue" }),
    ],
    display_type: displayType,
    id: 1,
    text: "Favourite colour?",
  }),
];

describe("renderQuestions", () => {
  test("returns empty string for no questions", () => {
    expect(renderQuestions([]).toString()).toBe("");
  });

  test("renders radio buttons for each answer", () => {
    const html = renderQuestions(colourQuestion()).toString();

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
    const html = renderQuestions(colourQuestion("select")).toString();

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
    const html = renderQuestions(colourQuestion("select")).toString();
    clearSavedFormData();

    expect(html).toContain('<option selected value="11">Blue</option>');
    expect(html).not.toContain('<option selected value="10">Red</option>');
  });

  test("renders multiple questions", () => {
    const html = renderQuestions(twoRadioQuestions()).toString();

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
    const listingMap = new Map([
      [1, [100, 200]],
      [2, [200]],
    ]);

    const html = renderQuestions(twoRadioQuestions(), listingMap).toString();

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

  test("wraps simple question text in a label for free-text questions", () => {
    const html = renderQuestions([
      {
        answers: [],
        display_type: "free_text" as const,
        id: 1,
        text: "Your name?",
      },
    ]).toString();

    expect(html).toContain('<label class="custom-question">');
    expect(html).toContain("Your name?");
    expect(html).not.toContain('<div class="prose">');
  });

  test("renders complex markdown as a prose div for free-text questions", () => {
    const html = renderQuestions([
      {
        answers: [],
        display_type: "free_text" as const,
        id: 1,
        text: "Tell us **more** about yourself",
      },
    ]).toString();

    expect(html).toContain('<div class="custom-question">');
    expect(html).toContain('<div class="prose">');
    expect(html).toContain("<strong>more</strong>");
    expect(html).not.toContain("**more**");
  });

  test("wraps simple question text in a label for select questions", () => {
    const html = renderQuestions(colourQuestion("select")).toString();

    expect(html).toContain('<label class="custom-question">');
    expect(html).not.toContain('<div class="prose">');
  });

  test("renders complex markdown as a prose div for select questions", () => {
    const html = renderQuestions([
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "Red" },
        ],
        display_type: "select" as const,
        id: 1,
        text: "Choose [a colour](https://example.com)",
      },
    ]).toString();

    expect(html).toContain('<div class="custom-question">');
    expect(html).toContain('<div class="prose">');
    expect(html).toContain('<a href="https://example.com">a colour</a>');
  });

  test("wraps simple question text in a legend for radio questions", () => {
    const html = renderQuestions(colourQuestion()).toString();

    expect(html).toContain("<legend>Favourite colour?</legend>");
    expect(html).not.toContain('<div class="prose">');
  });

  test("renders complex markdown as a prose div for radio questions", () => {
    const html = renderQuestions([
      {
        answers: [
          { active: true, id: 10, question_id: 1, sort_order: 0, text: "Red" },
        ],
        display_type: "radio" as const,
        id: 1,
        text: "# Heading\n\nPick a colour",
      },
    ]).toString();

    expect(html).toContain('<div class="prose">');
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).not.toContain("<legend>");
  });
});
