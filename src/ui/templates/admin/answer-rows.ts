/**
 * An attendee's answers as the admin reads them, with a note wherever an
 * answer or its wording differs from the booking.
 */

import type {
  BookedAnswer,
  QuestionWithAnswers,
  SelectedQuestionAnswers,
} from "#db/question-types.ts";
import { t } from "#i18n";
import { questionTextFlat } from "#templates/admin/questions.tsx";

/** How one answer differs from the booking. */
export type AnswerNote =
  | { kind: "none" }
  | { kind: "question-deleted" }
  | { kind: "changed"; atBooking: string | null; changesPrice: boolean }
  | { kind: "reworded"; question: string | null; answer: string | null };

/** A deleted question outranks a changed answer, and a changed answer
 * outranks new wording. */
export const answerNote = (row: BookedAnswer): AnswerNote => {
  if (row.question === null) return { kind: "question-deleted" };
  if (row.changed) {
    return {
      atBooking: row.answerAtBooking,
      changesPrice: row.changesPrice,
      kind: "changed",
    };
  }
  const question = row.askedAs === row.question ? null : row.askedAs;
  const answer =
    row.answerAtBooking === row.answer ? null : row.answerAtBooking;
  return question === null && answer === null
    ? { kind: "none" }
    : { answer, kind: "reworded", question };
};

type NoteOf<K extends AnswerNote["kind"]> = Extract<AnswerNote, { kind: K }>;

const atBookingLine = (atBooking: string | null): string =>
  atBooking === null
    ? t("attendee_detail.answer_changed_from_blank")
    : t("attendee_detail.answer_changed", { answer: atBooking });

const NOTE_LINES: {
  [K in AnswerNote["kind"]]: (note: NoteOf<K>) => string[];
} = {
  changed: (note) => [
    atBookingLine(note.atBooking),
    ...(note.changesPrice ? [t("attendee_detail.answer_changes_price")] : []),
  ],
  none: () => [],
  "question-deleted": () => [t("attendee_detail.question_deleted")],
  reworded: (note) => [
    ...(note.question === null
      ? []
      : [
          t("attendee_detail.question_reworded", {
            question: questionTextFlat(note.question),
          }),
        ]),
    ...(note.answer === null
      ? []
      : [t("attendee_detail.answer_reworded", { answer: note.answer })]),
  ],
};

/** The sentences the admin reads under an answer. */
export const noteLines = (note: AnswerNote): string[] =>
  (NOTE_LINES[note.kind] as (note: AnswerNote) => string[])(note);

/** One row of the attendee page's answers table. */
export type AnswerRow = { question: string; answer: string; notes: string[] };

const bookedLabel = (row: BookedAnswer): string => {
  const wording = row.question ?? row.askedAs;
  if (wording === null) {
    throw new Error(
      `Question ${row.questionId} has no wording now or at booking`,
    );
  }
  return questionTextFlat(wording);
};

/** A deleted question shows the booked answer. A question that was blank at
 * booking and is still blank shows nothing. */
const bookedRow = (row: BookedAnswer): AnswerRow[] => {
  const note = answerNote(row);
  const answer =
    note.kind === "question-deleted" ? row.answerAtBooking : row.answer;
  if (answer === null && note.kind !== "changed") return [];
  return [
    {
      answer: answer ?? t("attendee_form.no_answer"),
      notes: noteLines(note),
      question: bookedLabel(row),
    },
  ];
};

/** The answer an attendee with no record gives now, or null for none. */
const currentAnswer = (
  question: QuestionWithAnswers,
  selected: SelectedQuestionAnswers,
): string | null => {
  if (question.display_type === "free_text") {
    // A free-text question the attendee left blank has no entry.
    return selected.selectedTextAnswers.get(question.id) ?? null;
  }
  const picks = question.answers.filter((answer) =>
    selected.selectedAnswerIds.includes(answer.id),
  );
  return picks.length === 0 ? null : picks.map((a) => a.text).join(", ");
};

const currentRow =
  (selected: SelectedQuestionAnswers) =>
  (question: QuestionWithAnswers): AnswerRow[] => {
    const answer = currentAnswer(question, selected);
    return answer === null
      ? []
      : [{ answer, notes: [], question: questionTextFlat(question.text) }];
  };

/** Every answered question, and every answer that differs from the booking.
 * An attendee with no record of its booking shows its answers with no notes. */
export const answerRows = (selected: SelectedQuestionAnswers): AnswerRow[] =>
  selected.atBooking.length > 0
    ? selected.atBooking.flatMap(bookedRow)
    : selected.questions.flatMap(currentRow(selected));

/** The line the edit form shows under each changed question, by question id. */
export const atBookingHints = (
  atBooking: readonly BookedAnswer[],
): Map<number, string> =>
  new Map(
    atBooking.flatMap((row) => {
      const note = answerNote(row);
      return note.kind === "changed"
        ? [[row.questionId, atBookingLine(note.atBooking)] as const]
        : [];
    }),
  );
