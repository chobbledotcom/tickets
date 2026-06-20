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
    const form = new URLSearchParams();

    const result = parseQuestionAnswers({ optional: true })(form, [
      freeText(1),
    ]);

    expect(result).toEqual({ answerIds: [], ok: true, textAnswers: [] });
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
    const form = new URLSearchParams({
      question_1: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
    });

    const result = parseQuestionAnswers({ optional: true })(form, [
      freeText(1),
    ]);

    expect(result).toEqual({ answerIds: [], ok: true, textAnswers: [] });
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
