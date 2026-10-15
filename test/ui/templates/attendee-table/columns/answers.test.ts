import { assert } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import type { AttendeeQuestionData } from "#templates/attendee-table/types.ts";
import {
  attendeeTableSuite,
  makeOpts,
  makeRow,
  render,
} from "#test/ui/templates/attendee-table/shared.ts";
import { testAttendee, testRadioQuestion } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

attendeeTableSuite(() => {
  const questionData: AttendeeQuestionData = {
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
    says(renderAnswers(1), "<th>Answers</th>");
  });

  test("renders answer text in the answer cell", () => {
    const html = renderAnswers(1);
    says(html, 'class="answers-cell"');
    says(html, "Small, Red");
  });

  test("puts questions and answers in the tooltip", () => {
    says(renderAnswers(1), 'title="Size?: Small, Color?: Red"');
  });

  test("renders an empty answer for an attendee with no answers", () => {
    const html = renderAnswers(999);
    says(html, 'class="answers-cell"');
    says(html, 'title=""');
  });

  test("renders only the answers saved for an attendee", () => {
    const html = renderAnswers(2);
    says(html, "Large");
    assert(!html.includes('title="Size?: Small'));
  });

  test("omits Answers when question data is absent", () => {
    const html = render(makeOpts());
    assert(!html.includes("<th>Answers</th>"));
    assert(!html.includes("answers-cell"));
  });

  test("omits Answers when the question list is empty", () => {
    const html = render(
      makeOpts({
        questionData: { attendeeAnswerMap: new Map(), questions: [] },
      }),
    );
    assert(!html.includes("<th>Answers</th>"));
  });

  test("counts Answers in an empty table layout", () => {
    const html = render(makeOpts({ questionData, rows: [] }));
    says(html, "<th>Answers</th>");
    says(html, "No attendees yet");
    says(html, 'colspan="6"');
  });
});
