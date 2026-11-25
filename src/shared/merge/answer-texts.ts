/** The free-text answers of two attendees, merged onto the target. They are
 * read before the merge batch deletes the source's rows. */

import type { LineTextAnswer, TextAnswer } from "#db/question-types.ts";
import {
  getAttendeeLineAnswers,
  getAttendeeTextAnswers,
  type LineAnswer,
  textAnswersOf,
} from "#db/questions/attendee-answers/reads.ts";
import { lineKey } from "#db/questions/line-answers.ts";
import { type SqlStatement, sql } from "#db/sql.ts";

/** The line answers of both attendees, one for each question, line and
 * ticket. Two answers for one key join into one comma-separated text, the
 * target's first. A text that both give is not repeated. */
export const joinedLineAnswers = (
  target: readonly LineAnswer[],
  source: readonly LineAnswer[],
): LineTextAnswer[] =>
  [
    ...Map.groupBy(
      [...target, ...source],
      (answer) => `${answer.questionId}:${lineKey(answer)}:${answer.unit}`,
    ).values(),
  ].map((same) => {
    const { quantity: _quantity, ...first } = same[0]!;
    return {
      ...first,
      text: [...new Set(same.map(({ text }) => text))].join(", "),
    };
  });

/** Both attendees' free-text answers as the target keeps them. A booking
 * answer keeps the target's text, and a source-only one is adopted. The line
 * answers join by key (see {@link joinedLineAnswers}). */
export const mergedFreeTexts = async (
  targetId: number,
  sourceId: number,
  privateKey: CryptoKey,
): Promise<{ lineAnswers: LineTextAnswer[]; textAnswers: TextAnswer[] }> => {
  const ownerKey = () => Promise.resolve(privateKey);
  const [targetTexts, sourceTexts, targetLines, sourceLines] =
    await Promise.all([
      getAttendeeTextAnswers(targetId, privateKey),
      getAttendeeTextAnswers(sourceId, privateKey),
      getAttendeeLineAnswers(targetId, ownerKey, "all"),
      getAttendeeLineAnswers(sourceId, ownerKey, "all"),
    ]);
  return {
    lineAnswers: joinedLineAnswers(targetLines, sourceLines),
    textAnswers: textAnswersOf(new Map([...sourceTexts, ...targetTexts])),
  };
};

/** Clear the target's line answers, so the merged set replaces them. */
export const targetLineAnswersDelete = (targetId: number): SqlStatement =>
  sql`DELETE FROM attendee_answers
       WHERE attendee_id = ${targetId} AND booking_row_id IS NOT NULL`;
