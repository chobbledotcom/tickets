/**
 * Shared types and validation for the custom questions tables.
 *
 * Questions and answers are encrypted at rest using symmetric encryption
 * (DB_ENCRYPTION_KEY). Listing-question and attendee-answer mappings use
 * integer foreign keys.
 */

import * as v from "valibot";
import { guardFor } from "#shared/validation/guard.ts";

/** A custom multiple-choice question */
export const QUESTION_DISPLAY_TYPES = ["radio", "select", "free_text"] as const;
export const QuestionDisplayTypeSchema = v.picklist(QUESTION_DISPLAY_TYPES);
export type QuestionDisplayType = v.InferOutput<
  typeof QuestionDisplayTypeSchema
>;

export const isQuestionDisplayType = guardFor(QuestionDisplayTypeSchema);

export const questionDisplayTypeError =
  "Display as must be radio buttons, a select box, or free text";

export const requireQuestionDisplayType = (
  value: string,
): QuestionDisplayType => {
  if (isQuestionDisplayType(value)) return value;
  throw new Error(questionDisplayTypeError);
};

export interface Question {
  assign_all: boolean;
  display_type: QuestionDisplayType;
  id: number;
  text: string; // encrypted
}

/** An answer option for a question */
export interface Answer {
  id: number;
  question_id: number;
  sort_order: number;
  text: string; // encrypted
  /** Deactivated answers are hidden on the public booking form; the admin edit
   * form still shows one an attendee already selected so it isn't silently
   * dropped on the next save. */
  active: boolean;
}

/** Question with its answer options (decrypted) */
export type QuestionWithAnswers = Omit<Question, "assign_all"> & {
  answers: Answer[];
  assign_all?: boolean;
};

/** A free-text answer submitted for a question (plaintext, pre-string-interning). */
export type TextAnswer = { questionId: number; text: string };

/** A free-text answer resolved to its interned string id. */
export type TextAnswerId = { questionId: number; stringId: number };

/** Outcome of parsing a form's submitted answers. */
export type ParsedQuestionAnswers =
  | { ok: true; answerIds: number[]; textAnswers: TextAnswer[] }
  | { ok: false; error: string };
