import { expect } from "@std/expect";
import type { Question, TextAnswer } from "#shared/db/question-types.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { assignNextQuestionSortOrder } from "#shared/db/questions/sort-order.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** Create a test attendee directly via the DB (bypasses routes). Shared by
 *  every questions test file that needs an attendee to hang answers off. */
export const createAttendee = (
  listingId: number,
  name = "Alice",
): Promise<Attendee> => bookTestAttendee([listingId], name);

/** Insert a radio question directly. `overrides` covers the rare non-radio
 *  or assign-all cases; every other question test wants the plain default. */
export const createQuestion = (
  text: string,
  overrides: Partial<Parameters<typeof questionsTable.insert>[0]> = {},
): Promise<Question> =>
  questionsTable.insert({ displayType: "radio", text, ...overrides });

/** Insert one answer at a given sort position — the shared shape behind
 *  every "add an answer option" line across the questions test suite.
 *  `overrides` (e.g. `{ active: false }`) covers the rare deactivated-answer
 *  case. */
export const addAnswer = (
  questionId: number,
  sortOrder: number,
  text: string,
  overrides: Partial<Parameters<typeof answersTable.insert>[0]> = {},
) => answersTable.insert({ questionId, sortOrder, text, ...overrides });

/** Create a question and its answer options in one call, in the order
 *  given (so `sortOrder` matches array position) — the single factory
 *  every "set up a question with N answers" test in this suite goes
 *  through instead of hand-rolling the insert pair. */
export const createQuestionWithAnswers = async (
  text: string,
  answerTexts: string[] = [],
  overrides: Partial<Parameters<typeof questionsTable.insert>[0]> = {},
): Promise<Question> => {
  const question = await createQuestion(text, overrides);
  for (const [sortOrder, answerText] of answerTexts.entries()) {
    await addAnswer(question.id, sortOrder, answerText);
  }
  return question;
};

/** Save one attendee's free-text answers — wraps the `{ answerIds: [],
 *  textAnswers }` shape every free-text test in this suite otherwise
 *  hand-rolls around `saveAttendeeAnswers`. */
export const saveTextAnswers = (
  attendeeId: number,
  textAnswers: TextAnswer[],
): Promise<void> =>
  saveAttendeeAnswers(new Map([[attendeeId, { answerIds: [], textAnswers }]]));

/** Assert a list of questions has exactly these texts, in this order — the
 *  shared shape behind every "these questions come back, in this order"
 *  check across the questions test suite. */
export const expectQuestionTexts = (
  questions: Array<{ text: string }>,
  texts: string[],
): void => {
  expect(questions.map((q) => q.text)).toEqual(texts);
};

/** Create "Q1" and "Q2", each assigned the next global sort_order and given
 *  one answer — the shared "two globally-ordered questions" fixture behind
 *  every question-ordering test in this suite. */
export const createOrderedQuestionPair = async (
  answerA: string,
  answerB: string,
): Promise<{ q1: Question; q2: Question }> => {
  const q1 = await createQuestion("Q1");
  await assignNextQuestionSortOrder(q1.id);
  const q2 = await createQuestion("Q2");
  await assignNextQuestionSortOrder(q2.id);
  await addAnswer(q1.id, 0, answerA);
  await addAnswer(q2.id, 0, answerB);
  return { q1, q2 };
};

/** A listing with two assigned questions, one answered and one not — the
 *  shared "skips questions with no answers" fixture, read one way by the
 *  per-listing lookup and another way by the batch lookup. */
export const seedQuestionWithAndWithoutAnswers = async (): Promise<{
  listing: Listing;
  qNoAnswers: Question;
  qWithAnswers: Question;
}> => {
  const qWithAnswers = await createQuestionWithAnswers("Has answers", ["Yes"]);
  const qNoAnswers = await createQuestion("No answers");
  const listing = await createTestListing();
  await setListingQuestions(listing.id, [qWithAnswers.id, qNoAnswers.id]);
  return { listing, qNoAnswers, qWithAnswers };
};

/** Create a "radio" question with one answer and assign it to `listingId` —
 *  the shared trio behind every parent-gate and booking-preserve question
 *  test. Composes {@link createQuestion} + {@link addAnswer} +
 *  {@link setListingQuestions} so the insert pair is declared once.
 *  `active` defaults true (pass false for the all-deactivated-choice-question
 *  case). */
export const assignQuestion = async (
  listingId: number,
  text: string,
  answerText: string,
  active = true,
) => {
  const question = await createQuestion(text);
  const answer = await addAnswer(
    question.id,
    0,
    answerText,
    active ? {} : { active: false },
  );
  await setListingQuestions(listingId, [question.id]);
  return { answer, question };
};
