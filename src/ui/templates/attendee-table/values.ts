import { sort } from "#fp";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import { nonBlankLines } from "#shared/lines.ts";
import type { AttendeeColumnKey } from "#shared/tables/configurable.ts";
import type { AttendeeTableRow } from "#shared/types.ts";
import type {
  AttendeeColumnOpts,
  AttendeeTableOptions,
  TableQuestionData,
} from "#templates/attendee-table/types.ts";

/** Format a multi-line address for inline display. */
export const formatAddressInline = (address: string): string => {
  if (!address) return "";
  return nonBlankLines(address).reduce((result, line) => {
    if (!result) return line;
    return result.endsWith(",") ? `${result} ${line}` : `${result}, ${line}`;
  }, "");
};

/** Format multi-line instructions as single-line text. */
export const formatInstructionsInline = (instructions: string): string => {
  if (!instructions) return "";
  return instructions.replace(/\r?\n+/g, " ").trim();
};

type AnswerParts = { texts: string[]; tooltips: string[] };
type AnswerDisplay = { short: string; tooltip: string };

const freeTextAnswerParts = (
  attendeeId: number,
  questionData: TableQuestionData,
): AnswerParts => {
  const textByQuestion = questionData.textAnswerMap?.get(attendeeId);
  const texts: string[] = [];
  const tooltips: string[] = [];
  for (const question of questionData.questions) {
    if (question.display_type !== "free_text") continue;
    const text = textByQuestion?.get(question.id);
    if (!text) continue;
    texts.push(text);
    tooltips.push(`${question.text}: ${text}`);
  }
  return { texts, tooltips };
};

/** Build the answer text and tooltip shown for one attendee. */
export const getAnswerDisplay = (
  attendeeId: number,
  questionData: TableQuestionData,
  answerTextMap: Map<number, string>,
  answerQuestionMap: Map<number, string>,
): AnswerDisplay => {
  const answerIds = questionData.attendeeAnswerMap.get(attendeeId) ?? [];
  const answerTexts: string[] = [];
  const tooltipParts: string[] = [];
  for (const answerId of answerIds) {
    const text = answerTextMap.get(answerId);
    const questionText = answerQuestionMap.get(answerId);
    if (text) answerTexts.push(text);
    if (text && questionText) tooltipParts.push(`${questionText}: ${text}`);
  }
  const freeText = freeTextAnswerParts(attendeeId, questionData);
  return {
    short: [...answerTexts, ...freeText.texts].join(", "),
    tooltip: [...tooltipParts, ...freeText.tooltips].join(", "),
  };
};

/** Build answer-id lookups in one pass over the questions. */
export const buildAnswerMaps = (
  questions: QuestionWithAnswers[],
): Pick<AttendeeColumnOpts, "answerTextMap" | "answerQuestionMap"> => {
  const answerTextMap = new Map<number, string>();
  const answerQuestionMap = new Map<number, string>();
  for (const question of questions) {
    for (const answer of question.answers) {
      answerTextMap.set(answer.id, answer.text);
      answerQuestionMap.set(answer.id, question.text);
    }
  }
  return { answerQuestionMap, answerTextMap };
};

type AttendeeRowComparator = (
  first: AttendeeTableRow,
  second: AttendeeTableRow,
) => number;

const compareAttendeeDates: AttendeeRowComparator = (first, second) => {
  const firstDate = first.attendee.date ?? "";
  const secondDate = second.attendee.date ?? "";
  if (firstDate === secondDate) return 0;
  if (firstDate === "") return 1;
  if (secondDate === "") return -1;
  return firstDate.localeCompare(secondDate);
};

const compareTextBy =
  (getText: (row: AttendeeTableRow) => string): AttendeeRowComparator =>
  (first, second) =>
    getText(first).localeCompare(getText(second));

const ATTENDEE_ROW_ORDER: AttendeeRowComparator[] = [
  compareAttendeeDates,
  compareTextBy((row) => row.listings[0]?.name ?? ""),
  compareTextBy((row) => row.attendee.name),
  (first, second) => first.attendee.id - second.attendee.id,
];

const compareAttendeeRows: AttendeeRowComparator = (first, second) => {
  for (const compare of ATTENDEE_ROW_ORDER) {
    const result = compare(first, second);
    if (result !== 0) return result;
  }
  return 0;
};

/** Sort attendee rows by date, listing name, attendee name, then id. */
export const sortAttendeeRows: (
  rows: AttendeeTableRow[],
) => AttendeeTableRow[] = sort(compareAttendeeRows);

/** Find columns that do not apply to the current rows and options. */
export const hiddenAttendeeColumnKeys = (
  rows: readonly AttendeeTableRow[],
  options: AttendeeTableOptions,
): Set<AttendeeColumnKey> => {
  const hidden = new Set<AttendeeColumnKey>();
  if (options.showCheckin === false) hidden.add("status");
  if (!options.showListing) hidden.add("listings");
  if (!options.showDate) hidden.add("date");
  for (const columnKey of [
    "address",
    "email",
    "phone",
    "special_instructions",
  ] as const) {
    if (!rows.some((row) => !!row.attendee[columnKey])) hidden.add(columnKey);
  }
  if (!options.questionData || options.questionData.questions.length === 0) {
    hidden.add("answers");
  }
  return hidden;
};
