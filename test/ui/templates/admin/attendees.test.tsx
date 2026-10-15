import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BookedAnswer, QuestionWithAnswers } from "#db/question-types.ts";
import { EditQuestions } from "#templates/admin/attendees.tsx";

const render = (
  questions: QuestionWithAnswers[],
  selected: {
    answerIds?: number[];
    atBooking?: BookedAnswer[];
    textAnswers?: Map<number, string>;
  } = {},
): string =>
  String(
    <EditQuestions
      atBooking={selected.atBooking ?? []}
      questions={questions}
      selectedAnswerIds={selected.answerIds ?? []}
      selectedTextAnswers={selected.textAnswers ?? new Map()}
    />,
  );

describe("EditQuestions", () => {
  const withDeactivated = (
    displayType: "radio" | "select",
    selectedAnswerIds: number[],
  ) =>
    render(
      [
        {
          answers: [
            {
              active: true,
              id: 10,
              question_id: 1,
              sort_order: 0,
              text: "Red",
            },
            {
              active: false,
              id: 11,
              question_id: 1,
              sort_order: 1,
              text: "Blue",
            },
          ],
          display_type: displayType,
          id: 1,
          text: "Colour?",
        },
      ],
      { answerIds: selectedAnswerIds },
    );

  test("hides a deactivated radio answer the attendee has not selected", () => {
    const html = withDeactivated("radio", [10]);
    assertStringIncludes(html, "Red");
    assert(
      !html.includes("Blue"),
      "the value should not contain the searched item",
    );
  });

  test("keeps a deactivated radio answer the attendee already selected", () => {
    const html = withDeactivated("radio", [11]);
    assertStringIncludes(html, "Blue");
  });

  test("hides a deactivated select answer the attendee has not selected", () => {
    const html = withDeactivated("select", [10]);
    assertStringIncludes(html, "Red");
    assert(
      !html.includes("Blue"),
      "the value should not contain the searched item",
    );
  });

  test("keeps a deactivated select answer the attendee already selected", () => {
    const html = withDeactivated("select", [11]);
    // Asserting the full option markup (not just the label) proves the
    // `selected` attribute is preserved — without it the edit form would
    // silently drop the attendee's existing answer on save.
    assertStringIncludes(html, '<option selected value="11">Blue</option>');
  });

  test("renders radio inputs by default", () => {
    const html = render(
      [
        {
          answers: [
            {
              active: true,
              id: 10,
              question_id: 1,
              sort_order: 0,
              text: "Small",
            },
          ],
          display_type: "radio",
          id: 1,
          text: "Size?",
        },
      ],
      { answerIds: [10] },
    );

    assertStringIncludes(html, 'type="radio"');
    assertStringIncludes(html, "checked");
    assertStringIncludes(html, "Small");
  });

  test("renders select inputs when configured", () => {
    const html = render(
      [
        {
          answers: [
            {
              active: true,
              id: 10,
              question_id: 1,
              sort_order: 0,
              text: "Small",
            },
            {
              active: true,
              id: 11,
              question_id: 1,
              sort_order: 1,
              text: "Large",
            },
          ],
          display_type: "select",
          id: 1,
          text: "Size?",
        },
      ],
      { answerIds: [11] },
    );

    assertStringIncludes(html, '<select name="question_1">');
    assertStringIncludes(html, '<option value="">No answer</option>');
    assertStringIncludes(html, '<option selected value="11">Large</option>');
    assert(
      !html.includes('type="radio"'),
      "the value should not contain the searched item",
    );
  });

  test("renders a text input pre-filled with the saved free-text answer", () => {
    const html = render(
      [
        {
          answers: [],
          display_type: "free_text",
          id: 1,
          text: "Anything else?",
        },
      ],
      { textAnswers: new Map([[1, "Allergic to nuts"]]) },
    );

    assertStringIncludes(html, 'name="question_1" type="text"');
    assertStringIncludes(html, 'value="Allergic to nuts"');
    assert(
      !html.includes('type="radio"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("<select"),
      "the value should not contain the searched item",
    );
  });

  test("renders an empty text input when no free-text answer is saved", () => {
    const html = render([
      { answers: [], display_type: "free_text", id: 7, text: "Anything else?" },
    ]);

    assertStringIncludes(html, 'name="question_7" type="text" value=""');
  });

  test("renders complex markdown in a prose div for free-text questions", () => {
    const html = render(
      [
        {
          answers: [],
          display_type: "free_text",
          id: 1,
          text: "Tell us **more**",
        },
      ],
      { textAnswers: new Map([[1, "done"]]) },
    );

    assertStringIncludes(html, '<div class="prose" id="question-1-prose">');
    assertStringIncludes(html, 'aria-labelledby="question-1-prose"');
    assertStringIncludes(html, "<strong>more</strong>");
    assert(
      !html.includes('<label class="custom-question">'),
      "the value should not contain the searched item",
    );
  });

  test("renders complex markdown in a prose div for select questions", () => {
    const html = render(
      [
        {
          answers: [
            {
              active: true,
              id: 10,
              question_id: 1,
              sort_order: 0,
              text: "Red",
            },
          ],
          display_type: "select",
          id: 1,
          text: "Pick [a colour](https://example.com)",
        },
      ],
      { answerIds: [10] },
    );

    assertStringIncludes(html, '<div class="prose" id="question-1-prose">');
    assertStringIncludes(html, 'aria-labelledby="question-1-prose"');
    assertStringIncludes(html, '<a href="https://example.com">a colour</a>');
    assert(
      !html.includes('<label class="custom-question">'),
      "the value should not contain the searched item",
    );
  });

  test("renders complex markdown in a prose div for radio questions", () => {
    const html = render(
      [
        {
          answers: [
            {
              active: true,
              id: 10,
              question_id: 1,
              sort_order: 0,
              text: "Red",
            },
          ],
          display_type: "radio",
          id: 1,
          text: "# Heading\n\nPick a colour",
        },
      ],
      { answerIds: [10] },
    );

    assertStringIncludes(
      html,
      '<fieldset aria-labelledby="question-1-prose" class="custom-question">',
    );
    assertStringIncludes(html, '<div class="prose" id="question-1-prose">');
    assertStringIncludes(html, "<h1>Heading</h1>");
    assert(
      !html.includes("<legend>"),
      "the value should not contain the searched item",
    );
  });

  test("shows the answer at booking under a changed question only", () => {
    const question = (id: number): QuestionWithAnswers => ({
      answers: [],
      display_type: "free_text",
      id,
      text: `Question ${id}`,
    });
    const html = render([question(1), question(2)], {
      atBooking: [
        {
          answer: "Now",
          answerAtBooking: "Then",
          askedAs: "Question 1",
          changed: true,
          changesPrice: false,
          question: "Question 1",
          questionId: 1,
        },
        {
          answer: "Same",
          answerAtBooking: "Same",
          askedAs: "Question 2",
          changed: false,
          changesPrice: false,
          question: "Question 2",
          questionId: 2,
        },
      ],
      textAnswers: new Map([
        [1, "Now"],
        [2, "Same"],
      ]),
    });
    assertStringIncludes(
      html,
      "<small>Changed. At booking: &quot;Then&quot;.</small>",
    );
    expect(html.match(/<small>/g)?.length).toBe(1);
  });
});
