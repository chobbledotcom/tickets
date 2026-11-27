// effects: pure
/**
 * Shared types and validation for the custom questions tables.
 *
 * Questions and answers are encrypted at rest using symmetric encryption
 * (DB_ENCRYPTION_KEY). Listing-question and attendee-answer mappings use
 * integer foreign keys.
 */

import * as v from "valibot";
import type { DecodedRowOf } from "#db/select/tables.ts";
import { guardFor } from "#shared/validation/guard.ts";

/** A custom multiple-choice question */
export const QUESTION_DISPLAY_TYPES = ["radio", "select", "free_text"] as const;
export const QuestionDisplayTypeSchema = v.picklist(QUESTION_DISPLAY_TYPES);
export type QuestionDisplayType = v.InferOutput<
  typeof QuestionDisplayTypeSchema
>;

export const isQuestionDisplayType = guardFor(QuestionDisplayTypeSchema);

/** How often a free-text question asks. `booking` asks once for the order.
 *  `listing` asks once for each booking line, and `quantity` once for each
 *  ticket of a line. A choice question always asks once for the order,
 *  because its answer can change the price. */
export const QUESTION_ANSWER_LEVELS = [
  "booking",
  "listing",
  "quantity",
] as const;
export const QuestionAnswerLevelSchema = v.picklist(QUESTION_ANSWER_LEVELS);
export type QuestionAnswerLevel = v.InferOutput<
  typeof QuestionAnswerLevelSchema
>;

export const questionAnswerLevelError =
  "Ask once per must be booking or listing";

export const questionDisplayTypeError =
  "Display as must be radio buttons, a select box, or free text";

export const requireQuestionDisplayType = (
  value: string,
): QuestionDisplayType => {
  if (isQuestionDisplayType(value)) return value;
  throw new Error(questionDisplayTypeError);
};

const isQuestionAnswerLevel = guardFor(QuestionAnswerLevelSchema);

export const requireQuestionAnswerLevel = (
  value: string,
): QuestionAnswerLevel => {
  if (isQuestionAnswerLevel(value)) return value;
  throw new Error(questionAnswerLevelError);
};

export type Question = Pick<
  DecodedRowOf<"questions">,
  "answerLevel" | "assignAll" | "displayType" | "id" | "text"
>;

/** An answer option for a question. The public booking form hides an answer
 *  that is not active. The admin edit form still shows one that an attendee
 *  already selected, so the next save keeps it. */
export type Answer = Pick<
  DecodedRowOf<"answers">,
  "active" | "id" | "questionId" | "sortOrder" | "text"
>;

/** Question with its answer options (decrypted). Every read carries
 *  `assignAll`; a hand-built row says which switch state it stands for. */
export type QuestionWithAnswers = Question & {
  answers: Answer[];
};

/** One question on one attendee: its wording and answer now and at booking.
 * `question` is null when the question was deleted. `askedAs` is null when
 * the booking did not ask it. */
export type BookedAnswer = {
  questionId: number;
  question: string | null;
  askedAs: string | null;
  answer: string | null;
  answerAtBooking: string | null;
  changed: boolean;
  changesPrice: boolean;
};

/** A set of custom questions plus which answers the attendee has picked: the
 *  chosen option ids, and any free-text answers keyed by question id. Produced
 *  by the attendee page loader and consumed by the admin edit form.
 *  `atBooking` is empty for an attendee with no record of its booking. */
export type SelectedQuestionAnswers = {
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
  selectedTextAnswers: Map<number, string>;
  atBooking: BookedAnswer[];
};

/** A free-text answer submitted for a question (plaintext, pre-string-interning). */
export type TextAnswer = { questionId: number; text: string };

/** Where one booking line rests inside one order. A line under a parent is
 *  named by its listing and parent, and its package is 0. Any other line is
 *  named by its listing and package, and its parent is 0. */
export type LineSlot = {
  listingId: number;
  packageGroupId: number;
  parentListingId: number;
};

/** One ticket of one booking line. The first ticket is unit 0. A question for
 *  each line asks unit 0 only. */
export type LineTicket = LineSlot & { unit: number };

/** The date of the booking row that holds an answer. Two rows of one slot
 *  differ by date, so a stored answer names its row's date (null for a row
 *  with none). An answer typed at checkout names none: its order holds one
 *  row for each slot. */
export type AnswerRowDate = { startAt?: string | null };

/** A free-text answer for one ticket of one booking line. */
export type LineTextAnswer = TextAnswer & LineTicket & AnswerRowDate;

export type LineTextAnswerId = TextAnswerId & LineTicket & AnswerRowDate;

/** A free-text answer resolved to its interned string id. */
export type TextAnswerId = { questionId: number; stringId: number };

/** Outcome of parsing a form's submitted answers. */
export type ParsedQuestionAnswers =
  | { ok: true; answerIds: number[]; textAnswers: TextAnswer[] }
  | { ok: false; error: string };
