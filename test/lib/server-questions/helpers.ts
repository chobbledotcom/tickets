import { expect } from "@std/expect";
import { adminFormPost, expectFlash } from "#test-utils";

/** Helper: create a question via the admin form */
export const createQuestion = async (text: string): Promise<number> => {
  const { response } = await adminFormPost("/admin/questions", {
    display_type: "radio" as const,
    text,
  });
  expect(response.status).toBe(302);
  expectFlash(response, "Question created");
  // Get the ID from the DB
  const { getAllQuestionsWithAnswers } = await import(
    "#shared/db/questions/queries.ts"
  );
  const questions = await getAllQuestionsWithAnswers();
  const found = questions.find((q) => q.text === text);
  expect(found).toBeTruthy();
  return found!.id;
};

/** Helper: add an answer to a question via the admin form */
export const addAnswer = async (
  questionId: number,
  text: string,
): Promise<number> => {
  const { response } = await adminFormPost(
    `/admin/questions/${questionId}/answers`,
    { text },
  );
  expect(response.status).toBe(302);
  expectFlash(response, "Answer added");
  // Get the answer ID from the DB
  const { getQuestionWithAnswers } = await import(
    "#shared/db/questions/queries.ts"
  );
  const question = await getQuestionWithAnswers(questionId);
  const found = question!.answers.find((a) => a.text === text);
  expect(found).toBeTruthy();
  return found!.id;
};
