/**
 * Pure parsing of submitted question answers from form data.
 *
 * This module has no IO — it turns a `URLSearchParams` payload plus the
 * question schema into a validated set of answer ids and free-text values.
 * The public and admin flows share one curried parser; the only policy
 * difference between them is the `optional` flag.
 */

import type {
  Answer,
  ParsedQuestionAnswers,
  QuestionWithAnswers,
  TextAnswer,
} from "#db/question-types.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { parsePositiveInt as parsePositiveIntId } from "#shared/validation/number.ts";

export const findAnswerById = (
  question: QuestionWithAnswers,
  answerId: number,
): Answer | undefined => question.answers.find((a) => a.id === answerId);

/** Read and validate one question's submitted answer from form data.
 * `"missing"` = no value; `"invalid"` = the value isn't one of the question's
 * options (or, when `activeOnly`, is a deactivated option); otherwise the
 * matched answer id. Shared by the public (required, active-only) and admin
 * (optional, allows a pre-selected deactivated answer) parsers. */
export const readQuestionAnswer = (
  form: URLSearchParams,
  question: QuestionWithAnswers,
  activeOnly = false,
):
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ok"; answerId: number } => {
  const raw = form.get(`question_${question.id}`);
  if (!raw) return { status: "missing" };
  // Parse a strict positive-integer id: `Number.parseInt("12xyz", 10)` would
  // return `12` and silently match answer id 12, so a malformed submission
  // could select a real answer by accident. `parsePositiveIntId` rejects any
  // non-digit input (the repo's shared Valibot helper) before coercing.
  const answerId = parsePositiveIntId(raw);
  if (answerId === null) return { status: "invalid" };
  const answer = findAnswerById(question, answerId);
  if (!answer || (activeOnly && !answer.active)) {
    return { status: "invalid" };
  }
  return { answerId, status: "ok" };
};

/**
 * Curried answer parser shared by the public and admin flows. The loop and
 * per-answer lookup/validation live here once (over `readQuestionAnswer`);
 * the `optional` flag is the only policy difference between the two callers:
 *
 * - `{ optional: false }` (public booking) — every question must be answered
 *   with a valid option; the first missing/invalid one returns `ok: false`.
 * - `{ optional: true }` (admin edit) — unanswered or invalid questions are
 *   skipped. Supplied free text is still validated and can return `ok: false`.
 */
type MutableParsedQuestionAnswers = {
  answerIds: number[];
  textAnswers: TextAnswer[];
};

/** Validate one question's submitted answer, recording any valid answer into
 * `parsed` and returning an error message (or null when valid, or skippable
 * because `optional`). */
type AnswerParser = (
  form: URLSearchParams,
  question: QuestionWithAnswers,
  parsed: MutableParsedQuestionAnswers,
  optional: boolean,
) => string | null;

const parseFreeTextAnswer: AnswerParser = (
  form,
  question,
  parsed,
  optional,
) => {
  const text = (form.get(`question_${question.id}`) ?? "").trim();
  // Cap free-text length so an unauthenticated booking cannot submit an
  // arbitrarily large value (expensive to encrypt, large blob to retain). The
  // public input mirrors this with a maxlength. Optional means a blank answer
  // may be omitted; it never makes supplied invalid text acceptable.
  if (text.length > MAX_TEXTAREA_LENGTH) {
    return `Answer is too long: ${question.text}`;
  }
  if (text) {
    parsed.textAnswers.push({ questionId: question.id, text });
    return null;
  }
  return optional ? null : `Please answer: ${question.text}`;
};

const parseChoiceAnswer: AnswerParser = (form, question, parsed, optional) => {
  // Public submissions may only pick an active answer; the admin edit form may
  // re-save a deactivated answer the attendee had already chosen.
  const answer = readQuestionAnswer(form, question, !optional);
  if (answer.status === "ok") {
    parsed.answerIds.push(answer.answerId);
    return null;
  }
  if (optional) return null;
  // A choice question with no active answers has nothing selectable (it is
  // hidden on the form), so it can't block the booking.
  if (!question.answers.some((a) => a.active)) return null;
  const lead =
    answer.status === "missing" ? "Please answer" : "Invalid answer for";
  return `${lead}: ${question.text}`;
};

const parseQuestionAnswer: AnswerParser = (form, question, parsed, optional) =>
  question.display_type === "free_text"
    ? parseFreeTextAnswer(form, question, parsed, optional)
    : parseChoiceAnswer(form, question, parsed, optional);

type QuestionAnswersParser = (
  form: URLSearchParams,
  questions: QuestionWithAnswers[],
) => ParsedQuestionAnswers;

export const parseQuestionAnswers =
  (opts: { optional: boolean }): QuestionAnswersParser =>
  (
    form: URLSearchParams,
    questions: QuestionWithAnswers[],
  ): ParsedQuestionAnswers => {
    const parsed: MutableParsedQuestionAnswers = {
      answerIds: [],
      textAnswers: [],
    };
    for (const question of questions) {
      const error = parseQuestionAnswer(form, question, parsed, opts.optional);
      if (error) return { error, ok: false };
    }
    return { ok: true, ...parsed };
  };
