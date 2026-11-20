/** Questions that ask once for each booked listing. */

import type {
  LineTextAnswer,
  ParsedLineAnswers,
  Question,
  QuestionWithAnswers,
} from "#db/question-types.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";

/** A booked listing a line answer belongs to. */
export type AnswerLine = { id: number; name: string };

/** Whether the question keeps one answer for each booked listing. */
export const isListingLevel = (
  question: Pick<Question, "answerLevel" | "displayType">,
): boolean =>
  question.displayType === "free_text" && question.answerLevel === "listing";

/** The form field that holds the answer to a question for one listing. */
export const lineAnswerFieldName = (questionId: number, listingId: number) =>
  `question${questionId}_listing${listingId}`;

/** The booked listings a question asks: all, or the ones on its list. */
export const linesAskedBy = (
  lines: readonly AnswerLine[],
  askedListingIds: readonly number[] | undefined,
): AnswerLine[] =>
  lines.filter(
    (line) =>
      askedListingIds === undefined || askedListingIds.includes(line.id),
  );

/** The words a refusal names the answer by: the question and its listing. */
const answerName = (question: Pick<Question, "text">, line: AnswerLine) =>
  `${question.text} (${line.name})`;

type LineAnswerRead =
  | { ok: true; answer: LineTextAnswer }
  | { ok: false; error: string };

/** Read one question's answer for one listing: present, and within the limit. */
const readLineAnswer = (
  form: URLSearchParams,
  question: QuestionWithAnswers,
  line: AnswerLine,
): LineAnswerRead => {
  const text = (
    form.get(lineAnswerFieldName(question.id, line.id)) ?? ""
  ).trim();
  const name = answerName(question, line);
  if (text.length > MAX_TEXTAREA_LENGTH) {
    return { error: `Answer is too long: ${name}`, ok: false };
  }
  if (text === "") return { error: `Please answer: ${name}`, ok: false };
  return {
    answer: { listingId: line.id, questionId: question.id, text },
    ok: true,
  };
};

/** What an order is asked: its questions, the listings it books, and which
 * listings each question is assigned to. */
export type OrderQuestions = {
  lines: readonly AnswerLine[];
  questionListingMap: ReadonlyMap<number, number[]> | undefined;
  questions: readonly QuestionWithAnswers[];
};

/** The listing-level question and the booked listing of every answer owed. */
const answersOwed = ({
  lines,
  questionListingMap,
  questions,
}: OrderQuestions): { question: QuestionWithAnswers; line: AnswerLine }[] =>
  questions.filter(isListingLevel).flatMap((question) =>
    linesAskedBy(lines, questionListingMap?.get(question.id)).map((line) => ({
      line,
      question,
    })),
  );

/** Read every answer the listing-level questions owe. The first missing or too
 * long answer stops the booking. */
export const parseLineTextAnswers = (
  form: URLSearchParams,
  asked: OrderQuestions,
): ParsedLineAnswers => {
  const lineTextAnswers: LineTextAnswer[] = [];
  for (const { line, question } of answersOwed(asked)) {
    const read = readLineAnswer(form, question, line);
    if (!read.ok) return read;
    lineTextAnswers.push(read.answer);
  }
  return { lineTextAnswers, ok: true };
};
