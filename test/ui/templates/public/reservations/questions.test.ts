import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import { renderQuestions } from "#templates/public/reservations/questions.tsx";
import {
  testAnswer,
  testQuestion,
  testRadioQuestion,
} from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

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

    assertStringIncludes(html, "Favourite colour?");
    assertStringIncludes(html, 'name="question_1"');
    assertStringIncludes(html, 'value="10"');
    assertStringIncludes(html, "Red");
    assertStringIncludes(html, 'value="11"');
    assertStringIncludes(html, "Blue");
    assertStringIncludes(html, "required");
    assertStringIncludes(html, "<fieldset");
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

    assertStringIncludes(html, "Red");
    assert(!html.includes("Blue</label>"));
    assert(!html.includes('value="11"'));
  });

  test("renders select boxes when configured", () => {
    const html = renderQuestions(colourQuestion("select")).toString();

    // The question text labels the <select> via a wrapping <label>, so the
    // control has an accessible name without a separate screen-reader element.
    assertStringIncludes(
      html,
      '<label class="custom-question">Favourite colour?<select',
    );
    assertStringIncludes(html, '<select name="question_1" required>');
    assertStringIncludes(html, '<option value="">Select an answer</option>');
    assertStringIncludes(html, '<option value="10">Red</option>');
    assert(!html.includes('type="radio"'));
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
    assertStringIncludes(
      html,
      '<label class="custom-question">Your name?<input',
    );
    assertStringIncludes(html, 'name="question_1"');
    assertStringIncludes(html, 'type="text"');
    assertStringIncludes(html, "required");
    assert(!html.includes("<select"));
    assert(!html.includes('type="radio"'));
  });

  test("restores a saved free-text answer from saved form data", async () => {
    const html = await withRequestContext(() => {
      setSavedFormData(new FormParams({ question_1: "Ada Lovelace" }));
      return renderQuestions([
        {
          answers: [],
          display_type: "free_text" as const,
          id: 1,
          text: "Your name?",
        },
      ]).toString();
    });

    assertStringIncludes(html, 'value="Ada Lovelace"');
  });

  test("restores selected select answers from saved form data", async () => {
    const html = await withRequestContext(() => {
      setSavedFormData(new FormParams({ question_1: "11" }));
      return renderQuestions(colourQuestion("select")).toString();
    });

    assertStringIncludes(html, '<option selected value="11">Blue</option>');
    assert(!html.includes('<option selected value="10">Red</option>'));
  });

  test("renders multiple questions", () => {
    const html = renderQuestions(twoRadioQuestions()).toString();

    assertStringIncludes(html, 'name="question_1"');
    assertStringIncludes(html, 'name="question_2"');
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

    assertStringIncludes(html, "&lt;b&gt;");
    assertStringIncludes(html, "S&amp;M");
    assert(!html.includes("<b>size</b>"));
  });

  test("adds data-listing-ids when questionListingMap is provided", () => {
    const listingMap = new Map([
      [1, [100, 200]],
      [2, [200]],
    ]);

    const html = renderQuestions(twoRadioQuestions(), listingMap).toString();

    assertStringIncludes(html, 'data-listing-ids="100 200"');
    assertStringIncludes(html, 'data-listing-ids="200"');
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

    assert(!html.includes("data-listing-ids"));
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

    assertStringIncludes(html, '<label class="custom-question">');
    assertStringIncludes(html, "Your name?");
    assert(!html.includes('<div class="prose">'));
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

    assertStringIncludes(html, '<div class="custom-question">');
    assertStringIncludes(html, '<div class="prose" id="question-1-prose">');
    assertStringIncludes(html, 'aria-labelledby="question-1-prose"');
    assertStringIncludes(html, "<strong>more</strong>");
    assert(!html.includes("**more**"));
  });

  test("wraps simple question text in a label for select questions", () => {
    const html = renderQuestions(colourQuestion("select")).toString();

    assertStringIncludes(html, '<label class="custom-question">');
    assert(!html.includes('<div class="prose">'));
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

    assertStringIncludes(html, '<div class="custom-question">');
    assertStringIncludes(html, '<div class="prose" id="question-1-prose">');
    assertStringIncludes(html, 'aria-labelledby="question-1-prose"');
    assertStringIncludes(html, '<a href="https://example.com">a colour</a>');
  });

  test("wraps simple question text in a legend for radio questions", () => {
    const html = renderQuestions(colourQuestion()).toString();

    assertStringIncludes(html, "<legend>Favourite colour?</legend>");
    assert(!html.includes('<div class="prose">'));
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

    assertStringIncludes(
      html,
      '<fieldset aria-labelledby="question-1-prose" class="custom-question">',
    );
    assertStringIncludes(html, '<div class="prose" id="question-1-prose">');
    assertStringIncludes(html, "<h1>Heading</h1>");
    assert(!html.includes("<legend>"));
  });
});
