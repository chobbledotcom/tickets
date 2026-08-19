/** Answer and identity behavior for attendee merges. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import {
  getAttendeeAnswersByQuestion,
  getAttendeeTextAnswers,
} from "#db/questions/attendee-answers/reads.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createAttendee,
  createFreeTextQuestion,
  createMergePair,
  createQuestionWithAnswers,
  oneQuestion,
  runMerge,
  saveChoice,
  saveTextAnswer,
} from "./helpers.ts";

type MergePair = Awaited<ReturnType<typeof createMergePair>>;
type QuestionSetup = Awaited<ReturnType<typeof createQuestionWithAnswers>>;

const expectMergedTextAnswer = async (
  source: MergePair["source"],
  target: MergePair["target"],
  questionId: number,
  expected: string,
) => {
  const { result } = await runMerge({ source, target });
  expect(result.success).toBe(true);
  const textAnswers = await getAttendeeTextAnswers(
    target.id,
    await getTestPrivateKey(),
  );
  expect(textAnswers.get(questionId)).toBe(expected);
};

const expectKeptTargetAnswer = async (
  result: {
    success: boolean;
    summary: {
      answersKept: number;
      answersCleared: number;
      answersTakenFromSource: number;
    };
  },
  targetId: number,
  questionId: number,
  expectedAnswerId: number,
) => {
  expect(result.success).toBe(true);
  expect(result.summary.answersKept).toBe(1);
  expect(result.summary.answersCleared).toBe(0);
  expect(result.summary.answersTakenFromSource).toBe(0);
  const finalAnswers = await getAttendeeAnswersByQuestion(targetId);
  expect(finalAnswers.get(questionId)?.answerId).toBe(expectedAnswerId);
};

const saveConflictAnswerChoice = async (
  target: MergePair["target"],
  source: MergePair["source"],
  answers: QuestionSetup["answers"],
) => {
  await saveChoice(target.id, answers[0]!.id);
  await saveChoice(source.id, answers[1]!.id);
};

const expectMergeKeepsTargetAnswer = async (
  source: MergePair["source"],
  target: MergePair["target"],
  question: QuestionSetup["question"],
  answers: QuestionSetup["answers"],
  expectedAnswerId: number,
) => {
  const { result } = await runMerge({
    questions: oneQuestion(question, answers),
    source,
    target,
  });
  await expectKeptTargetAnswer(
    result,
    target.id,
    question.id,
    expectedAnswerId,
  );
};

describeWithEnv("attendee merge service", { db: true }, () => {
  describe("applyAttendeeMerge answers and identity", () => {
    test("applies PII and answer decisions correctly", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing1.id,
        "Colour?",
        ["Red", "Blue"],
      );
      const target = await createAttendee(
        listing1.id,
        "Alice",
        "alice@test.com",
      );
      const source = await createAttendee(listing2.id, "Bob", "bob@test.com");
      await saveConflictAnswerChoice(target, source, answers);

      const { result } = await runMerge({
        decide: () => ({
          answers: { [String(question.id)]: "source" },
          bookings: {},
          money: {},
          pii: { email: "target", name: "source" },
        }),
        questions: oneQuestion(question, answers),
        source,
        target,
      });

      expect(result).toEqual({
        success: true,
        summary: {
          answersCleared: 0,
          answersKept: 0,
          answersTakenFromSource: 1,
          bookingsCredited: 0,
          bookingsMoved: 1,
          bookingsReplacedTarget: 0,
          bookingsSkipped: 0,
          bookingsWrittenOff: 0,
          piiFieldsFromSource: ["name"],
        },
      });
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);
      expect(
        await queryAll<{ id: number }>(
          "SELECT id FROM attendees WHERE id = ?",
          [source.id],
        ),
      ).toEqual([]);
      const listingLinks = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ? ORDER BY listing_id",
        [target.id],
      );
      expect(listingLinks).toEqual(
        [listing1.id, listing2.id]
          .sort((a, b) => a - b)
          .map((listing_id) => ({ listing_id })),
      );
    });

    test("preserves the target's free-text answers through a merge", async () => {
      const { target, source } = await createMergePair();
      const textQuestion = await createFreeTextQuestion();
      await saveTextAnswer(target.id, textQuestion.id, "Coeliac");

      await expectMergedTextAnswer(source, target, textQuestion.id, "Coeliac");
    });

    test("adopts a source-only free-text answer in a merge", async () => {
      const { target, source } = await createMergePair();
      const textQuestion = await createFreeTextQuestion();
      await saveTextAnswer(source.id, textQuestion.id, "Vegan");

      await expectMergedTextAnswer(source, target, textQuestion.id, "Vegan");
    });

    test("clears answers when decision is clear", async () => {
      const { listing, target, source } = await createMergePair();
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Size?",
        ["S", "L"],
      );
      await saveConflictAnswerChoice(target, source, answers);

      const { result } = await runMerge({
        decide: () => ({
          answers: { [String(question.id)]: "clear" },
          bookings: {},
          money: {},
          pii: {},
        }),
        questions: oneQuestion(question, answers),
        source,
        target,
      });

      expect(result.summary.answersCleared).toBe(1);
      expect(result.summary.answersKept).toBe(0);
      expect(result.summary.answersTakenFromSource).toBe(0);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.has(question.id)).toBe(false);
    });

    test("adopts source answers when target has none", async () => {
      const { listing, target, source } = await createMergePair();
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Meal?",
        ["Chicken", "Fish"],
      );
      await saveChoice(source.id, answers[1]!.id);

      const { result } = await runMerge({
        questions: oneQuestion(question, answers),
        source,
        target,
      });

      expect(result.summary.answersTakenFromSource).toBe(1);
      expect(result.summary.answersCleared).toBe(0);
      expect(result.summary.answersKept).toBe(0);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);
    });

    test("returns accurate summary counts", async () => {
      const listing1 = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({ maxAttendees: 10 });
      const target = await createAttendee(listing1.id, "Alice");
      const source = await createAttendee(listing2.id, "Bob");

      const { diff, result } = await runMerge({
        decide: () => ({
          answers: {},
          bookings: {},
          money: {},
          pii: { name: "source" },
        }),
        source,
        target,
      });

      expect(
        diff.bookingItems.map(({ conflictClass }) => conflictClass),
      ).toEqual(["moveable"]);
      expect(result).toEqual({
        success: true,
        summary: {
          answersCleared: 0,
          answersKept: 0,
          answersTakenFromSource: 0,
          bookingsCredited: 0,
          bookingsMoved: 1,
          bookingsReplacedTarget: 0,
          bookingsSkipped: 0,
          bookingsWrittenOff: 0,
          piiFieldsFromSource: ["name"],
        },
      });
    });

    test("keeps the target's answer when the conflict decision is target", async () => {
      const { listing, target, source } = await createMergePair({
        sameListing: true,
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Colour?",
        ["Red", "Blue"],
      );
      await saveConflictAnswerChoice(target, source, answers);

      const { result } = await runMerge({
        decide: () => ({
          answers: { [String(question.id)]: "target" },
          bookings: {},
          money: {},
          pii: {},
        }),
        questions: oneQuestion(question, answers),
        source,
        target,
      });

      await expectKeptTargetAnswer(
        result,
        target.id,
        question.id,
        answers[0]!.id,
      );
    });

    test("keeps the target's answer when the source has none", async () => {
      const { listing, target, source } = await createMergePair();
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Snack?",
        ["Crisps", "Fruit"],
      );
      await saveChoice(target.id, answers[0]!.id);

      await expectMergeKeepsTargetAnswer(
        source,
        target,
        question,
        answers,
        answers[0]!.id,
      );
    });

    test("keeps an agreed-upon answer the same on both sides", async () => {
      const { listing, target, source } = await createMergePair({
        sameListing: true,
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Tea?",
        ["Yes", "No"],
      );
      await saveChoice(target.id, answers[0]!.id);
      await saveChoice(source.id, answers[0]!.id);

      await expectMergeKeepsTargetAnswer(
        source,
        target,
        question,
        answers,
        answers[0]!.id,
      );
    });
  });
});
