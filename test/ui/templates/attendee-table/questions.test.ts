import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { TableQuestionData } from "#templates/attendee-table.tsx";
import { testAttendee, testRadioQuestion } from "#test-utils/factories.ts";
import { attendeeTableSuite, makeOpts, makeRow, render } from "./shared.ts";

attendeeTableSuite(() => {
  const questionData: TableQuestionData = {
    attendeeAnswerMap: new Map([
      [1, [10, 20]],
      [2, [11]],
    ]),
    questions: [
      testRadioQuestion(1, "Size?", [
        [10, "Small"],
        [11, "Large"],
      ]),
      testRadioQuestion(2, "Color?", [
        [20, "Red"],
        [21, "Blue"],
      ]),
    ],
  };

  const renderAnswers = (attendeeId: number): string =>
    render(
      makeOpts({
        questionData,
        rows: [makeRow({ attendee: testAttendee({ id: attendeeId }) })],
      }),
    );

  test("renders the Answers header when question data is provided", () => {
    expect(renderAnswers(1)).toContain("<th>Answers</th>");
  });

  test("renders answer text in the answer cell", () => {
    const html = renderAnswers(1);
    expect(html).toContain('class="answers-cell"');
    expect(html).toContain("Small, Red");
  });

  test("puts questions and answers in the tooltip", () => {
    expect(renderAnswers(1)).toContain('title="Size?: Small, Color?: Red"');
  });

  test("renders an empty answer for an attendee with no answers", () => {
    const html = renderAnswers(999);
    expect(html).toContain('class="answers-cell"');
    expect(html).toContain('title=""');
  });

  test("renders only the answers saved for an attendee", () => {
    const html = renderAnswers(2);
    expect(html).toContain("Large");
    expect(html).not.toContain("Small");
  });

  test("omits Answers when question data is absent", () => {
    const html = render(makeOpts());
    expect(html).not.toContain("<th>Answers</th>");
    expect(html).not.toContain("answers-cell");
  });

  test("omits Answers when the question list is empty", () => {
    const html = render(
      makeOpts({
        questionData: { attendeeAnswerMap: new Map(), questions: [] },
      }),
    );
    expect(html).not.toContain("<th>Answers</th>");
  });

  test("counts Answers in an empty table layout", () => {
    const html = render(makeOpts({ questionData, rows: [] }));
    expect(html).toContain("<th>Answers</th>");
    expect(html).toContain("No attendees yet");
    expect(html).toContain('colspan="6"');
  });
});
