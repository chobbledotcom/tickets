import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { EditQuestions } from "#templates/admin/attendees.tsx";

describe("EditQuestions", () => {
  test("renders radio inputs by default", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [{ id: 10, question_id: 1, sort_order: 0, text: "Small" }],
        display_type: "radio" as const,
        id: 1,
        text: "Size?",
      },
    ];

    const html = String(
      <EditQuestions questions={questions} selectedAnswerIds={[10]} />,
    );

    expect(html).toContain('type="radio"');
    expect(html).toContain("checked");
    expect(html).toContain("Small");
  });

  test("renders select inputs when configured", () => {
    const questions: QuestionWithAnswers[] = [
      {
        answers: [
          { id: 10, question_id: 1, sort_order: 0, text: "Small" },
          { id: 11, question_id: 1, sort_order: 1, text: "Large" },
        ],
        display_type: "select" as const,
        id: 1,
        text: "Size?",
      },
    ];

    const html = String(
      <EditQuestions questions={questions} selectedAnswerIds={[11]} />,
    );

    expect(html).toContain('<select name="question_1">');
    expect(html).toContain('<option value="">No answer</option>');
    expect(html).toContain('<option selected value="11">Large</option>');
    expect(html).not.toContain('type="radio"');
  });
});
