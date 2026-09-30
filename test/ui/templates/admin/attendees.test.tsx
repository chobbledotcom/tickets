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
    expect(html).toContain("Red");
    expect(html).not.toContain("Blue");
  });

  test("keeps a deactivated radio answer the attendee already selected", () => {
    const html = withDeactivated("radio", [11]);
    expect(html).toContain("Blue");
  });

  test("hides a deactivated select answer the attendee has not selected", () => {
    const html = withDeactivated("select", [10]);
    expect(html).toContain("Red");
    expect(html).not.toContain("Blue");
  });

  test("keeps a deactivated select answer the attendee already selected", () => {
    const html = withDeactivated("select", [11]);
    // Asserting the full option markup (not just the label) proves the
    // `selected` attribute is preserved — without it the edit form would
    // silently drop the attendee's existing answer on save.
    expect(html).toContain('<option selected value="11">Blue</option>');
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

    expect(html).toContain('type="radio"');
    expect(html).toContain("checked");
    expect(html).toContain("Small");
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

    expect(html).toContain('<select name="question_1">');
    expect(html).toContain('<option value="">No answer</option>');
    expect(html).toContain('<option selected value="11">Large</option>');
    expect(html).not.toContain('type="radio"');
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

    expect(html).toContain('name="question_1" type="text"');
    expect(html).toContain('value="Allergic to nuts"');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("<select");
  });

  test("renders an empty text input when no free-text answer is saved", () => {
    const html = render([
      { answers: [], display_type: "free_text", id: 7, text: "Anything else?" },
    ]);

    expect(html).toContain('name="question_7" type="text" value=""');
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

    expect(html).toContain('<div class="prose" id="question-1-prose">');
    expect(html).toContain('aria-labelledby="question-1-prose"');
    expect(html).toContain("<strong>more</strong>");
    expect(html).not.toContain('<label class="custom-question">');
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

    expect(html).toContain('<div class="prose" id="question-1-prose">');
    expect(html).toContain('aria-labelledby="question-1-prose"');
    expect(html).toContain('<a href="https://example.com">a colour</a>');
    expect(html).not.toContain('<label class="custom-question">');
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

    expect(html).toContain(
      '<fieldset aria-labelledby="question-1-prose" class="custom-question">',
    );
    expect(html).toContain('<div class="prose" id="question-1-prose">');
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).not.toContain("<legend>");
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
    expect(html).toContain(
      "<small>Changed. At booking: &quot;Then&quot;.</small>",
    );
    expect(html.match(/<small>/g)?.length).toBe(1);
  });
});
