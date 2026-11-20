import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import {
  isListingLevel,
  lineAnswerFieldName,
  linesAskedBy,
  parseLineTextAnswers,
} from "#db/questions/line-answers.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { testQuestion } from "#test-utils/factories.ts";

const pupilName: QuestionWithAnswers = testQuestion({
  answerLevel: "listing",
  displayType: "free_text",
  id: 4,
  text: "Pupil name",
});

const discoA = { id: 10, name: "Disco A" };
const discoB = { id: 20, name: "Disco B" };

const form = (entries: Record<string, string>): URLSearchParams =>
  new URLSearchParams(entries);

describe("isListingLevel", () => {
  test("is true for a free-text question that asks once for each listing", () => {
    expect(isListingLevel(pupilName)).toBe(true);
  });

  test("is false for a booking-level free-text question", () => {
    expect(isListingLevel({ ...pupilName, answerLevel: "booking" })).toBe(
      false,
    );
  });

  test("is false for a choice question, whatever its level says", () => {
    expect(isListingLevel({ ...pupilName, displayType: "radio" })).toBe(false);
  });
});

describe("lineAnswerFieldName", () => {
  test("names the question and the listing", () => {
    expect(lineAnswerFieldName(4, 10)).toBe("question4_listing10");
  });
});

describe("linesAskedBy", () => {
  test("asks every booked listing when the question has no listing list", () => {
    expect(linesAskedBy([discoA, discoB], undefined)).toEqual([discoA, discoB]);
  });

  test("asks only the booked listings on the question's list", () => {
    expect(linesAskedBy([discoA, discoB], [20, 30])).toEqual([discoB]);
  });
});

/** Parse the answers to the pupil-name question for the given booked
 * listings. */
const parseFor = (
  entries: Record<string, string>,
  lines = [discoA],
  questionListingMap?: ReadonlyMap<number, number[]>,
  questions = [pupilName],
) =>
  parseLineTextAnswers(form(entries), {
    lines,
    questionListingMap,
    questions,
  });

describe("parseLineTextAnswers", () => {
  test("reads one answer for each booked listing", () => {
    expect(
      parseFor({ question4_listing10: "  Ava  ", question4_listing20: "Ben" }, [
        discoA,
        discoB,
      ]),
    ).toEqual({
      lineTextAnswers: [
        { listingId: 10, questionId: 4, text: "Ava" },
        { listingId: 20, questionId: 4, text: "Ben" },
      ],
      ok: true,
    });
  });

  test("owes no answer for a listing the question is not assigned to", () => {
    expect(
      parseFor(
        { question4_listing20: "Ben" },
        [discoA, discoB],
        new Map([[4, [20]]]),
      ),
    ).toEqual({
      lineTextAnswers: [{ listingId: 20, questionId: 4, text: "Ben" }],
      ok: true,
    });
  });

  test("refuses a missing answer and names the question and the listing", () => {
    expect(parseFor({ question4_listing10: "Ava" }, [discoA, discoB])).toEqual({
      error: "Please answer: Pupil name (Disco B)",
      ok: false,
    });
  });

  test("refuses a blank answer", () => {
    expect(parseFor({ question4_listing10: "   " })).toEqual({
      error: "Please answer: Pupil name (Disco A)",
      ok: false,
    });
  });

  test("refuses an answer over the length limit and accepts one at the limit", () => {
    const limit = "x".repeat(MAX_TEXTAREA_LENGTH);
    expect([
      parseFor({ question4_listing10: `${limit}x` }),
      parseFor({ question4_listing10: limit }),
    ]).toEqual([
      { error: "Answer is too long: Pupil name (Disco A)", ok: false },
      {
        lineTextAnswers: [{ listingId: 10, questionId: 4, text: limit }],
        ok: true,
      },
    ]);
  });

  test("ignores a field for a listing that is not booked", () => {
    expect(
      parseFor({ question4_listing10: "Ava", question4_listing20: "Ben" }),
    ).toEqual({
      lineTextAnswers: [{ listingId: 10, questionId: 4, text: "Ava" }],
      ok: true,
    });
  });

  test("skips a question that asks once for the booking", () => {
    expect(
      parseFor({}, [discoA], undefined, [
        { ...pupilName, answerLevel: "booking" },
      ]),
    ).toEqual({ lineTextAnswers: [], ok: true });
  });
});
