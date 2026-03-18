import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import {
  answersTable,
  deleteAnswer,
  deleteQuestion,
  getAllQuestionsWithAnswers,
  getAttendeeAnswersBatch,
  getQuestion,
  getQuestionsForEvent,
  getQuestionsWithEventIds,
  getQuestionWithAnswers,
  questionsTable,
  saveAttendeeAnswers,
  saveAttendeeAnswersBatch,
  setEventQuestions,
} from "#lib/db/questions.ts";
import { createTestDbWithSetup, createTestEvent, resetDb } from "#test-utils";

/** Create a test attendee directly via the DB (bypasses routes) */
const createAttendee = async (eventId: number, name = "Alice") => {
  const result = await createAttendeeAtomic({
    eventId,
    name,
    email: `${name.toLowerCase()}@test.com`,
  });
  if (!result.success)
    throw new Error(`Failed to create attendee: ${result.reason}`);
  return result.attendee;
};

describe("custom questions", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("questions CRUD", () => {
    test("creates and retrieves a question", async () => {
      const q = await questionsTable.insert({ text: "Favourite colour?" });
      expect(q.id).toBeGreaterThan(0);

      const found = await getQuestion(q.id);
      expect(found).not.toBeNull();
      expect(found!.text).toBe("Favourite colour?");
    });

    test("updates a question", async () => {
      const q = await questionsTable.insert({ text: "Old text" });
      await questionsTable.update(q.id, { text: "New text" });
      const found = await getQuestion(q.id);
      expect(found!.text).toBe("New text");
    });

    test("deletes a question and cascades", async () => {
      const q = await questionsTable.insert({ text: "To delete" });
      const a = await answersTable.insert({
        questionId: q.id,
        text: "Opt A",
        sortOrder: 0,
      });

      const event = await createTestEvent();
      await setEventQuestions(event.id, [q.id]);

      const attendee = await createAttendee(event.id);
      await saveAttendeeAnswers(attendee.id, [a.id]);

      await deleteQuestion(q.id);

      expect(await getQuestion(q.id)).toBeNull();
      expect(await getQuestionsForEvent(event.id)).toEqual([]);
      const answers = await getAttendeeAnswersBatch([attendee.id]);
      expect(answers.get(attendee.id)).toBeUndefined();
    });
  });

  describe("answers CRUD", () => {
    test("creates answers for a question", async () => {
      const q = await questionsTable.insert({ text: "Size?" });
      await answersTable.insert({
        questionId: q.id,
        text: "Small",
        sortOrder: 0,
      });
      await answersTable.insert({
        questionId: q.id,
        text: "Large",
        sortOrder: 1,
      });

      const withAnswers = await getQuestionWithAnswers(q.id);
      expect(withAnswers).not.toBeNull();
      expect(withAnswers!.answers).toHaveLength(2);
      expect(withAnswers!.answers[0]!.text).toBe("Small");
      expect(withAnswers!.answers[1]!.text).toBe("Large");
    });

    test("deletes a single answer", async () => {
      const q = await questionsTable.insert({ text: "Size?" });
      const small = await answersTable.insert({
        questionId: q.id,
        text: "Small",
        sortOrder: 0,
      });
      await answersTable.insert({
        questionId: q.id,
        text: "Large",
        sortOrder: 1,
      });

      await deleteAnswer(small.id);

      const withAnswers = await getQuestionWithAnswers(q.id);
      expect(withAnswers!.answers).toHaveLength(1);
      expect(withAnswers!.answers[0]!.text).toBe("Large");
    });
  });

  describe("event-question mapping", () => {
    test("assigns questions to an event", async () => {
      const q1 = await questionsTable.insert({ text: "Q1" });
      const q2 = await questionsTable.insert({ text: "Q2" });
      await answersTable.insert({
        questionId: q1.id,
        text: "A1",
        sortOrder: 0,
      });
      await answersTable.insert({
        questionId: q2.id,
        text: "A2",
        sortOrder: 0,
      });

      const event = await createTestEvent();
      await setEventQuestions(event.id, [q2.id, q1.id]);

      const questions = await getQuestionsForEvent(event.id);
      expect(questions).toHaveLength(2);
      // Order should match the order provided
      expect(questions[0]!.text).toBe("Q2");
      expect(questions[1]!.text).toBe("Q1");
    });

    test("replaces event questions on re-assignment", async () => {
      const q1 = await questionsTable.insert({ text: "Q1" });
      const q2 = await questionsTable.insert({ text: "Q2" });
      await answersTable.insert({
        questionId: q1.id,
        text: "A1",
        sortOrder: 0,
      });
      await answersTable.insert({
        questionId: q2.id,
        text: "A2",
        sortOrder: 0,
      });

      const event = await createTestEvent();
      await setEventQuestions(event.id, [q1.id, q2.id]);
      await setEventQuestions(event.id, [q2.id]);

      const questions = await getQuestionsForEvent(event.id);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Q2");
    });

    test("returns empty array for event with no questions", async () => {
      const event = await createTestEvent();
      const questions = await getQuestionsForEvent(event.id);
      expect(questions).toEqual([]);
    });
  });

  describe("getQuestionsWithEventIds", () => {
    test("deduplicates questions across events", async () => {
      const q1 = await questionsTable.insert({ text: "Q1" });
      const q2 = await questionsTable.insert({ text: "Q2" });
      await answersTable.insert({
        questionId: q1.id,
        text: "A1",
        sortOrder: 0,
      });
      await answersTable.insert({
        questionId: q2.id,
        text: "A2",
        sortOrder: 0,
      });

      const event1 = await createTestEvent();
      const event2 = await createTestEvent({ name: "Event 2" });
      await setEventQuestions(event1.id, [q1.id, q2.id]);
      await setEventQuestions(event2.id, [q2.id]);

      const { questions } = await getQuestionsWithEventIds([
        event1.id,
        event2.id,
      ]);
      expect(questions).toHaveLength(2);
      expect(questions[0]!.text).toBe("Q1");
      expect(questions[1]!.text).toBe("Q2");
    });

    test("returns event-ID mapping for each question", async () => {
      const q1 = await questionsTable.insert({ text: "Q1" });
      const q2 = await questionsTable.insert({ text: "Q2" });
      await answersTable.insert({
        questionId: q1.id,
        text: "A1",
        sortOrder: 0,
      });
      await answersTable.insert({
        questionId: q2.id,
        text: "A2",
        sortOrder: 0,
      });

      const event1 = await createTestEvent();
      const event2 = await createTestEvent({ name: "Event 2" });
      await setEventQuestions(event1.id, [q1.id, q2.id]);
      await setEventQuestions(event2.id, [q2.id]);

      const { questionEventMap } = await getQuestionsWithEventIds([
        event1.id,
        event2.id,
      ]);
      expect(questionEventMap.get(q1.id)).toEqual([event1.id]);
      const q2Events = questionEventMap.get(q2.id)!;
      expect(q2Events.sort()).toEqual([event1.id, event2.id].sort());
    });

    test("returns empty for no events", async () => {
      const { questions, questionEventMap } = await getQuestionsWithEventIds(
        [],
      );
      expect(questions).toEqual([]);
      expect(questionEventMap.size).toBe(0);
    });
  });

  describe("attendee answers", () => {
    test("saves and retrieves attendee answers", async () => {
      const q = await questionsTable.insert({ text: "Size?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        text: "Small",
        sortOrder: 0,
      });
      await answersTable.insert({
        questionId: q.id,
        text: "Large",
        sortOrder: 1,
      });

      const event = await createTestEvent();
      const attendee = await createAttendee(event.id);

      await saveAttendeeAnswers(attendee.id, [a1.id]);

      const batch = await getAttendeeAnswersBatch([attendee.id]);
      expect(batch.get(attendee.id)).toEqual([a1.id]);
    });

    test("batch retrieval for multiple attendees", async () => {
      const q = await questionsTable.insert({ text: "Size?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        text: "Small",
        sortOrder: 0,
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        text: "Large",
        sortOrder: 1,
      });

      const event = await createTestEvent();
      const att1 = await createAttendee(event.id, "Alice");
      const att2 = await createAttendee(event.id, "Bob");

      await saveAttendeeAnswers(att1.id, [a1.id]);
      await saveAttendeeAnswers(att2.id, [a2.id]);

      const batch = await getAttendeeAnswersBatch([att1.id, att2.id]);
      expect(batch.get(att1.id)).toEqual([a1.id]);
      expect(batch.get(att2.id)).toEqual([a2.id]);
    });

    test("empty batch for no attendees", async () => {
      const batch = await getAttendeeAnswersBatch([]);
      expect(batch.size).toBe(0);
    });

    test("saveAttendeeAnswersBatch does nothing for empty attendeeIds", async () => {
      await saveAttendeeAnswersBatch([], [1]);
      // No error thrown, no rows inserted
    });

    test("saveAttendeeAnswersBatch does nothing for empty answerIds", async () => {
      await saveAttendeeAnswersBatch([1], []);
      // No error thrown, no rows inserted
    });


  });

  describe("getAllQuestionsWithAnswers", () => {
    test("returns all questions with their answers", async () => {
      const q1 = await questionsTable.insert({ text: "Q1" });
      const q2 = await questionsTable.insert({ text: "Q2" });
      await answersTable.insert({
        questionId: q1.id,
        text: "A1",
        sortOrder: 0,
      });
      await answersTable.insert({
        questionId: q1.id,
        text: "A2",
        sortOrder: 1,
      });
      await answersTable.insert({
        questionId: q2.id,
        text: "B1",
        sortOrder: 0,
      });

      const all = await getAllQuestionsWithAnswers();
      expect(all).toHaveLength(2);

      const qWithA1 = all.find((q) => q.text === "Q1")!;
      expect(qWithA1.answers).toHaveLength(2);

      const qWithA2 = all.find((q) => q.text === "Q2")!;
      expect(qWithA2.answers).toHaveLength(1);
    });
  });
});
