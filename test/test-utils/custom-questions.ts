import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";

type QuestionOptions = {
  assignAll?: boolean;
  displayType?: "free_text" | "radio";
};

/**
 * Adds a custom question together with its answer options, in the order given.
 * Defaults to a multiple-choice ("radio") question; pass `displayType` for a
 * free-text one. Returns the saved question and its saved answers.
 */
export const addQuestion = async (
  text: string,
  answerTexts: string[] = [],
  options: QuestionOptions = {},
) => {
  const question = await questionsTable.insert({
    displayType: "radio",
    text,
    ...options,
  });
  const answers: Awaited<ReturnType<typeof answersTable.insert>>[] = [];
  for (const answerText of answerTexts) {
    answers.push(
      await answersTable.insert({
        questionId: question.id,
        sortOrder: answers.length,
        text: answerText,
      }),
    );
  }
  return { answers, question };
};

/**
 * Adds a question with its answers and assigns it to a single listing — the
 * common "this listing asks this question" setup.
 */
export const addListingQuestion = async (
  listingId: number,
  text: string,
  answerTexts: string[] = [],
  options: QuestionOptions = {},
) => {
  const seeded = await addQuestion(text, answerTexts, options);
  await setListingQuestions(listingId, [seeded.question.id]);
  return seeded;
};
