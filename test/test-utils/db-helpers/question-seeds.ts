/** One question row with its answers and the listings that ask it. */

import type {
  Answer,
  Question,
  QuestionAnswerLevel,
  QuestionDisplayType,
} from "#db/question-types.ts";
import { questionListings } from "#db/questions/queries.ts";
import { records } from "#db/record-table.ts";

/** What a seeded question asks, how, and on which listings. */
export interface QuestionSeed<Texts extends readonly string[]> {
  answerLevel?: QuestionAnswerLevel;
  answers?: Texts;
  displayType?: QuestionDisplayType;
  listingIds?: readonly number[];
  text: string;
}

/** The question row and one answer row for each answer text, in order. */
export interface SeededQuestion<Texts extends readonly string[]> {
  answers: { -readonly [Index in keyof Texts]: Answer };
  question: Question;
}

/** A question with one answer for each text, in the order given, asked on
 *  each listing given. A radio question unless the seed says otherwise. */
export const seedQuestion = async <const Texts extends readonly string[] = []>({
  answerLevel = "booking",
  answers,
  displayType = "radio",
  listingIds = [],
  text,
}: QuestionSeed<Texts>): Promise<SeededQuestion<Texts>> => {
  const question = await records.questions.insert({
    answerLevel,
    displayType: displayType,
    text,
  });
  const rows: Answer[] = [];
  for (const [sortOrder, answerText] of (answers ?? []).entries()) {
    rows.push(
      await records.answers.insert({
        questionId: question.id,
        sortOrder: sortOrder,
        text: answerText,
      }),
    );
  }
  if (listingIds.length > 0) {
    await questionListings.setIds(question.id, [...listingIds]);
  }
  return {
    answers: rows as SeededQuestion<Texts>["answers"],
    question,
  };
};

/** One free-text question for each text, in the order given, all asked on
 *  one listing. */
export const freeTextQuestionsOn = async <
  const Texts extends readonly string[],
>(
  listingId: number,
  texts: Texts,
): Promise<{ -readonly [Index in keyof Texts]: Question }> => {
  const questions: Question[] = [];
  for (const text of texts) {
    const { question } = await seedQuestion({
      displayType: "free_text",
      listingIds: [listingId],
      text,
    });
    questions.push(question);
  }
  return questions as { -readonly [Index in keyof Texts]: Question };
};

/** A free-text question that asks once for each listing a buyer books, asked
 *  on each listing given. */
export const seedListingLevelQuestion = (
  listingIds: readonly number[] = [],
  text = "Pupil name",
) =>
  seedQuestion({
    answerLevel: "listing",
    displayType: "free_text",
    listingIds,
    text,
  });
