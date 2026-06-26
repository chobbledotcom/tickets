import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseQuestionAnswers,
  type QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";

const freeText = (
  id: number,
  text = `Question ${id}`,
): QuestionWithAnswers => ({
  answers: [],
  display_type: "free_text",
  id,
  text,
});

const radio = (id: number): QuestionWithAnswers => ({
  answers: [
    {
      active: true,
      id: id * 10,
      question_id: id,
      sort_order: 0,
      text: "Answer",
    },
  ],
  display_type: "radio",
  id,
  text: `Question ${id}`,
});

describe("parseQuestionAnswers free-text handling", () => {
  const expectOptionalFreeTextEmpty = (form: URLSearchParams) => {
    const result = parseQuestionAnswers({ optional: true })(form, [
      freeText(1),
    ]);
    expect(result).toEqual({ answerIds: [], ok: true, textAnswers: [] });
  };

  test("collects a trimmed free-text answer", () => {
    const form = new URLSearchParams({ question_1: "  Front row  " });

    const result = parseQuestionAnswers({ optional: false })(form, [
      freeText(1),
    ]);

    expect(result).toEqual({
      answerIds: [],
      ok: true,
      textAnswers: [{ questionId: 1, text: "Front row" }],
    });
  });

  test("rejects a blank required free-text answer", () => {
    const form = new URLSearchParams({ question_1: "   " });

    const result = parseQuestionAnswers({ optional: false })(form, [
      freeText(1, "Notes?"),
    ]);

    expect(result).toEqual({ error: "Please answer: Notes?", ok: false });
  });

  test("allows a blank optional free-text answer", () => {
    expectOptionalFreeTextEmpty(new URLSearchParams());
  });

  test("rejects an over-length required free-text answer", () => {
    const form = new URLSearchParams({
      question_1: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
    });

    const result = parseQuestionAnswers({ optional: false })(form, [
      freeText(1, "Notes?"),
    ]);

    expect(result).toEqual({ error: "Answer is too long: Notes?", ok: false });
  });

  test("skips an over-length optional free-text answer", () => {
    expectOptionalFreeTextEmpty(
      new URLSearchParams({
        question_1: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
      }),
    );
  });

  test("parses choice and free-text questions side by side", () => {
    const form = new URLSearchParams({
      question_1: "10",
      question_2: "Window seat",
    });

    const result = parseQuestionAnswers({ optional: false })(form, [
      radio(1),
      freeText(2),
    ]);

    expect(result).toEqual({
      answerIds: [10],
      ok: true,
      textAnswers: [{ questionId: 2, text: "Window seat" }],
    });
  });
});

describe("parseQuestionAnswers deactivated answers", () => {
  const withInactive = (id: number): QuestionWithAnswers => ({
    answers: [
      { active: true, id: 10, question_id: id, sort_order: 0, text: "Active" },
      {
        active: false,
        id: 11,
        question_id: id,
        sort_order: 1,
        text: "Retired",
      },
    ],
    display_type: "radio",
    id,
    text: `Question ${id}`,
  });

  const allInactive = (id: number): QuestionWithAnswers => ({
    answers: [
      {
        active: false,
        id: 20,
        question_id: id,
        sort_order: 0,
        text: "Retired",
      },
    ],
    display_type: "radio",
    id,
    text: `Question ${id}`,
  });

  test("rejects a deactivated answer on the public path", () => {
    const form = new URLSearchParams({ question_1: "11" });
    const result = parseQuestionAnswers({ optional: false })(form, [
      withInactive(1),
    ]);
    expect(result).toEqual({
      error: "Invalid answer for: Question 1",
      ok: false,
    });
  });

  test("keeps a deactivated answer the attendee already chose on admin edit", () => {
    const form = new URLSearchParams({ question_1: "11" });
    const result = parseQuestionAnswers({ optional: true })(form, [
      withInactive(1),
    ]);
    expect(result).toEqual({ answerIds: [11], ok: true, textAnswers: [] });
  });

  test("does not require a choice question with no active answers", () => {
    const form = new URLSearchParams();
    const result = parseQuestionAnswers({ optional: false })(form, [
      allInactive(1),
    ]);
    expect(result).toEqual({ answerIds: [], ok: true, textAnswers: [] });
  });
});
