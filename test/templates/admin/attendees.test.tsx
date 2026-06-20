import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { EditQuestions } from "#templates/admin/attendees.tsx";

const render = (
  questions: QuestionWithAnswers[],
  selected: { answerIds?: number[]; textAnswers?: Map<number, string> } = {},
): string =>
  String(
    <EditQuestions
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
});
