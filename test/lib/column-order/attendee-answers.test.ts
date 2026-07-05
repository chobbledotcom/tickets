import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE_TABLE_COLUMNS,
  formatAddressInline,
} from "#shared/columns/attendee-columns.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import type { AttendeeColumnOpts } from "#templates/attendee-table.tsx";
import { setupTestEncryptionKey, testAttendee } from "#test-utils";
import {
  makeAttendeeRow as makeRow,
  attendeeColumnOpts as opts,
} from "./attendee-column-fixtures.ts";

setupTestEncryptionKey();

/** Render the answers cell for attendee id 1 with the given opts overrides */
const answersCell = (overrides: Partial<AttendeeColumnOpts>): string =>
  ATTENDEE_TABLE_COLUMNS.answers!.cell(
    makeRow({ attendee: testAttendee({ id: 1 }) }),
    { ...opts, ...overrides },
  );

/** A question fixture for the given display type */
const question = (
  id: number,
  text: string,
  display_type: QuestionWithAnswers["display_type"],
): QuestionWithAnswers => ({ answers: [], display_type, id, text });

/** attendee id 1's answer to a single chosen (radio/select) question, id 10 */
const oneAnswerQuestionData = {
  attendeeAnswerMap: new Map([[1, [10]]]),
  questions: [],
};

/** The opts fragment for a resolved chosen answer of "Red" to "Favorite color" */
const chosenAnswerOpts: Partial<AttendeeColumnOpts> = {
  answerQuestionMap: new Map([[10, "Favorite color"]]),
  answerTextMap: new Map([[10, "Red"]]),
};

/** The opts fragment for a free-text "Access needs?" answer of `answer` */
const accessNeedsFreeText = (answer: string) => ({
  questions: [question(5, "Access needs?", "free_text" as const)],
  textAnswerMap: new Map([[1, new Map([[5, answer]])]]),
});

describe("ATTENDEE_TABLE_COLUMNS.answers cell", () => {
  test("renders a normal answer with its resolved question text as the tooltip", () => {
    const html = answersCell({
      ...chosenAnswerOpts,
      questionData: oneAnswerQuestionData,
    });
    expect(html).toBe('<span title="Favorite color: Red">Red</span>');
  });

  test("joins multiple resolved answers and tooltip parts with a comma separator", () => {
    const html = answersCell({
      answerQuestionMap: new Map([
        [10, "Favorite color"],
        [11, "Second color"],
      ]),
      answerTextMap: new Map([
        [10, "Red"],
        [11, "Blue"],
      ]),
      questionData: {
        attendeeAnswerMap: new Map([[1, [10, 11]]]),
        questions: [],
      },
    });
    expect(html).toBe(
      '<span title="Favorite color: Red, Second color: Blue">Red, Blue</span>',
    );
  });

  test("shows a radio answer with no tooltip part when its question text is unknown", () => {
    // The answer id resolves to text but not to a question, so the tooltip part
    // (which needs both) is skipped while the short value still renders.
    const html = answersCell({
      answerTextMap: new Map([[10, "Red"]]),
      questionData: oneAnswerQuestionData,
    });
    expect(html).toBe('<span title="">Red</span>');
  });

  test("includes a free-text answer and its Question: Answer tooltip", () => {
    const html = answersCell({
      questionData: {
        attendeeAnswerMap: new Map(),
        ...accessNeedsFreeText("Wheelchair ramp"),
      },
    });
    expect(html).toBe(
      '<span title="Access needs?: Wheelchair ramp">Wheelchair ramp</span>',
    );
  });

  test("skips non-free-text questions when collecting free-text answers", () => {
    // A radio question's text lives at the same map key as a free-text
    // question would use, but its display_type isn't "free_text" so it must
    // be ignored regardless of what the text map holds for its id.
    const html = answersCell({
      questionData: {
        attendeeAnswerMap: new Map(),
        questions: [
          question(5, "Access needs?", "free_text"),
          question(6, "T-shirt size", "radio"),
        ],
        textAnswerMap: new Map([
          [
            1,
            new Map([
              [5, "Wheelchair ramp"],
              [6, "Large"],
            ]),
          ],
        ]),
      },
    });
    expect(html).toBe(
      '<span title="Access needs?: Wheelchair ramp">Wheelchair ramp</span>',
    );
  });

  test("skips a free-text question with no recorded answer text", () => {
    const html = answersCell({
      questionData: {
        attendeeAnswerMap: new Map(),
        questions: [question(5, "Access needs?", "free_text")],
        textAnswerMap: new Map([[1, new Map()]]),
      },
    });
    expect(html).toBe('<span title=""></span>');
  });

  test("combines a chosen answer and a free-text answer, comma-joined in order", () => {
    const html = answersCell({
      ...chosenAnswerOpts,
      questionData: {
        ...oneAnswerQuestionData,
        ...accessNeedsFreeText("Wheelchair ramp"),
      },
    });
    expect(html).toBe(
      '<span title="Favorite color: Red, Access needs?: Wheelchair ramp">Red, Wheelchair ramp</span>',
    );
  });
});

describe("formatAddressInline", () => {
  test("separates a line already ending in a comma with a space instead of an extra comma", () => {
    expect(formatAddressInline("123 Main St,\nApt 4\nNew York")).toBe(
      "123 Main St, Apt 4, New York",
    );
  });

  test("joins plain lines with a comma and space", () => {
    expect(formatAddressInline("123 Main St\nApt 4\nNew York")).toBe(
      "123 Main St, Apt 4, New York",
    );
  });
});

describe("special_instructions cell (formatInstructionsInline)", () => {
  test("collapses a run of consecutive newlines into a single space", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({
          attendee: testAttendee({ special_instructions: "Line1\n\n\nLine2" }),
        }),
        opts,
      ),
    ).toBe("Line1 Line2");
  });

  test("trims leading and trailing newlines after collapsing", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({
          attendee: testAttendee({ special_instructions: "\nLine1\n" }),
        }),
        opts,
      ),
    ).toBe("Line1");
  });
});
