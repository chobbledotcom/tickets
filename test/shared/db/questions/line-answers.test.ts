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

describe("parseLineTextAnswers", () => {
  test("reads one answer for each booked listing", () => {
    const result = parseLineTextAnswers(
      form({
        question4_listing10: "  Ava  ",
        question4_listing20: "Ben",
      }),
      [pupilName],
      [discoA, discoB],
      undefined,
    );
    expect(result).toEqual({
      lineTextAnswers: [
        { listingId: 10, questionId: 4, text: "Ava" },
        { listingId: 20, questionId: 4, text: "Ben" },
      ],
      ok: true,
    });
  });

  test("owes no answer for a listing the question is not assigned to", () => {
    const result = parseLineTextAnswers(
      form({ question4_listing20: "Ben" }),
      [pupilName],
      [discoA, discoB],
      new Map([[4, [20]]]),
    );
    expect(result).toEqual({
      lineTextAnswers: [{ listingId: 20, questionId: 4, text: "Ben" }],
      ok: true,
    });
  });

  test("refuses a missing answer and names the question and the listing", () => {
    const result = parseLineTextAnswers(
      form({ question4_listing10: "Ava" }),
      [pupilName],
      [discoA, discoB],
      undefined,
    );
    expect(result).toEqual({
      error: "Please answer: Pupil name (Disco B)",
      ok: false,
    });
  });

  test("refuses a blank answer", () => {
    const result = parseLineTextAnswers(
      form({ question4_listing10: "   " }),
      [pupilName],
      [discoA],
      undefined,
    );
    expect(result).toEqual({
      error: "Please answer: Pupil name (Disco A)",
      ok: false,
    });
  });

  test("refuses an answer over the length limit", () => {
    const result = parseLineTextAnswers(
      form({ question4_listing10: "x".repeat(MAX_TEXTAREA_LENGTH + 1) }),
      [pupilName],
      [discoA],
      undefined,
    );
    expect(result).toEqual({
      error: "Answer is too long: Pupil name (Disco A)",
      ok: false,
    });
  });

  test("accepts an answer at the length limit", () => {
    const text = "x".repeat(MAX_TEXTAREA_LENGTH);
    const result = parseLineTextAnswers(
      form({ question4_listing10: text }),
      [pupilName],
      [discoA],
      undefined,
    );
    expect(result).toEqual({
      lineTextAnswers: [{ listingId: 10, questionId: 4, text }],
      ok: true,
    });
  });

  test("ignores a field for a listing that is not booked", () => {
    const result = parseLineTextAnswers(
      form({ question4_listing10: "Ava", question4_listing20: "Ben" }),
      [pupilName],
      [discoA],
      undefined,
    );
    expect(result).toEqual({
      lineTextAnswers: [{ listingId: 10, questionId: 4, text: "Ava" }],
      ok: true,
    });
  });

  test("skips a question that asks once for the booking", () => {
    const result = parseLineTextAnswers(
      form({}),
      [{ ...pupilName, answerLevel: "booking" }],
      [discoA],
      undefined,
    );
    expect(result).toEqual({ lineTextAnswers: [], ok: true });
  });
});
