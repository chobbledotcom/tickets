import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import {
  answersTable,
  deleteAnswer,
  deleteQuestion,
  getAllQuestionsWithAnswers,
  getAnswerCountsForQuestion,
  getAttendeeAnswersBatch,
  getEventQuestionIds,
  getNextAnswerSortOrder,
  getQuestionEventIds,
  getQuestionsForEvent,
  getQuestionsWithEventIds,
  getQuestionWithAnswers,
  questionsTable,
  saveAttendeeAnswers,
  setEventQuestions,
  setQuestionEvents,
  swapAnswerOrder,
} from "#shared/db/questions.ts";
import { createTestEvent, describeWithEnv } from "#test-utils";

/** Create a test attendee directly via the DB (bypasses routes) */
const createAttendee = async (eventId: number, name = "Alice") => {
  const result = await createAttendeeAtomic({
    bookings: [{ eventId }],
    email: `${name.toLowerCase()}@test.com`,
    name,
  });
  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }
  return result.attendees[0]!;
};

describeWithEnv("custom questions", { db: true }, () => {
  describe("questions CRUD", () => {
    test("creates and retrieves a question", async () => {
      const q = await questionsTable.insert({ text: "Favourite colour?" });
      expect(q.id).toBeGreaterThan(0);

      const found = await questionsTable.findById(q.id);
      expect(found).not.toBeNull();
      expect(found!.text).toBe("Favourite colour?");
    });

    test("updates a question", async () => {
      const q = await questionsTable.insert({ text: "Old text" });
      await questionsTable.update(q.id, { text: "New text" });
      const found = await questionsTable.findById(q.id);
      expect(found!.text).toBe("New text");
    });

    test("deletes a question and cascades", async () => {
      const q = await questionsTable.insert({ text: "To delete" });
      const a = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Opt A",
      });

      const event = await createTestEvent();
      await setEventQuestions(event.id, [q.id]);

      const attendee = await createAttendee(event.id);
      await saveAttendeeAnswers(new Map([[attendee.id, [a.id]]]));

      await deleteQuestion(q.id);

      expect(await questionsTable.findById(q.id)).toBeNull();
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
        sortOrder: 0,
        text: "Small",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
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
        sortOrder: 0,
        text: "Small",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
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
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
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
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
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

    test("skips questions with no answers", async () => {
      const qWithAnswers = await questionsTable.insert({ text: "Has answers" });
      const qNoAnswers = await questionsTable.insert({ text: "No answers" });
      await answersTable.insert({
        questionId: qWithAnswers.id,
        sortOrder: 0,
        text: "Yes",
      });

      const event = await createTestEvent();
      await setEventQuestions(event.id, [qWithAnswers.id, qNoAnswers.id]);

      const questions = await getQuestionsForEvent(event.id);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Has answers");
    });
  });

  describe("getEventQuestionIds", () => {
    test("returns assigned question IDs", async () => {
      const q1 = await questionsTable.insert({ text: "Q1" });
      const q2 = await questionsTable.insert({ text: "Q2" });

      const event = await createTestEvent();
      await setEventQuestions(event.id, [q2.id, q1.id]);

      const ids = await getEventQuestionIds(event.id);
      expect(ids).toEqual([q2.id, q1.id]);
    });

    test("returns empty array for event with no questions", async () => {
      const event = await createTestEvent();
      expect(await getEventQuestionIds(event.id)).toEqual([]);
    });
  });

  describe("getQuestionEventIds", () => {
    test("returns the events a question is assigned to", async () => {
      const q = await questionsTable.insert({ text: "Q" });
      const event1 = await createTestEvent();
      const event2 = await createTestEvent({ name: "Event 2" });
      await setEventQuestions(event1.id, [q.id]);
      await setEventQuestions(event2.id, [q.id]);

      const ids = await getQuestionEventIds(q.id);
      expect(ids.sort()).toEqual([event1.id, event2.id].sort());
    });

    test("returns empty array when assigned to no events", async () => {
      const q = await questionsTable.insert({ text: "Lonely Q" });
      expect(await getQuestionEventIds(q.id)).toEqual([]);
    });
  });

  describe("setQuestionEvents", () => {
    test("assigns a question to the selected events", async () => {
      const q = await questionsTable.insert({ text: "Q" });
      const event1 = await createTestEvent();
      const event2 = await createTestEvent({ name: "Event 2" });

      await setQuestionEvents(q.id, [event1.id, event2.id]);

      expect((await getQuestionEventIds(q.id)).sort()).toEqual(
        [event1.id, event2.id].sort(),
      );
    });

    test("removes the question from unchecked events", async () => {
      const q = await questionsTable.insert({ text: "Q" });
      const event1 = await createTestEvent();
      const event2 = await createTestEvent({ name: "Event 2" });
      await setQuestionEvents(q.id, [event1.id, event2.id]);

      await setQuestionEvents(q.id, [event1.id]);

      expect(await getQuestionEventIds(q.id)).toEqual([event1.id]);
    });

    test("appends after an event's existing questions without reordering", async () => {
      const existing = await questionsTable.insert({ text: "Existing" });
      const added = await questionsTable.insert({ text: "Added" });
      await answersTable.insert({
        questionId: existing.id,
        sortOrder: 0,
        text: "A",
      });
      await answersTable.insert({
        questionId: added.id,
        sortOrder: 0,
        text: "B",
      });

      const event = await createTestEvent();
      await setEventQuestions(event.id, [existing.id]);

      await setQuestionEvents(added.id, [event.id]);

      const ids = await getEventQuestionIds(event.id);
      expect(ids).toEqual([existing.id, added.id]);
    });

    test("does nothing when the assignment is unchanged", async () => {
      const q = await questionsTable.insert({ text: "Q" });
      const event = await createTestEvent();
      await setQuestionEvents(q.id, [event.id]);

      await setQuestionEvents(q.id, [event.id]);

      expect(await getQuestionEventIds(q.id)).toEqual([event.id]);
    });

    test("clears all events when given an empty list", async () => {
      const q = await questionsTable.insert({ text: "Q" });
      const event = await createTestEvent();
      await setQuestionEvents(q.id, [event.id]);

      await setQuestionEvents(q.id, []);

      expect(await getQuestionEventIds(q.id)).toEqual([]);
    });
  });

  describe("getQuestionsWithEventIds", () => {
    test("deduplicates questions across events", async () => {
      const q1 = await questionsTable.insert({ text: "Q1" });
      const q2 = await questionsTable.insert({ text: "Q2" });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
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
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
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

    test("skips questions with no answers", async () => {
      const qWithAnswers = await questionsTable.insert({ text: "Has answers" });
      const qNoAnswers = await questionsTable.insert({ text: "No answers" });
      await answersTable.insert({
        questionId: qWithAnswers.id,
        sortOrder: 0,
        text: "Yes",
      });

      const event = await createTestEvent();
      await setEventQuestions(event.id, [qWithAnswers.id, qNoAnswers.id]);

      const { questions } = await getQuestionsWithEventIds([event.id]);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Has answers");
    });
  });

  describe("attendee answers", () => {
    test("saves and retrieves attendee answers", async () => {
      const q = await questionsTable.insert({ text: "Size?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });

      const event = await createTestEvent();
      const attendee = await createAttendee(event.id);

      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const batch = await getAttendeeAnswersBatch([attendee.id]);
      expect(batch.get(attendee.id)).toEqual([a1.id]);
    });

    test("batch retrieval for multiple attendees", async () => {
      const q = await questionsTable.insert({ text: "Size?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });

      const event = await createTestEvent();
      const att1 = await createAttendee(event.id, "Alice");
      const att2 = await createAttendee(event.id, "Bob");

      await saveAttendeeAnswers(new Map([[att1.id, [a1.id]]]));
      await saveAttendeeAnswers(new Map([[att2.id, [a2.id]]]));

      const batch = await getAttendeeAnswersBatch([att1.id, att2.id]);
      expect(batch.get(att1.id)).toEqual([a1.id]);
      expect(batch.get(att2.id)).toEqual([a2.id]);
    });

    test("empty batch for no attendees", async () => {
      const batch = await getAttendeeAnswersBatch([]);
      expect(batch.size).toBe(0);
    });

    test("saveAttendeeAnswers does nothing for an empty map", async () => {
      await saveAttendeeAnswers(new Map());
      // No error thrown, no batch executed
    });

    test("saveAttendeeAnswers skips inserts for an answerless attendee", async () => {
      await saveAttendeeAnswers(new Map([[1, []]]));
      // No error thrown, no rows inserted (delete-only path)
    });

    test("saveAttendeeAnswers replaces existing answers atomically", async () => {
      const q = await questionsTable.insert({ text: "Colour?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Blue",
      });

      const event = await createTestEvent();
      const att = await createAttendee(event.id);
      await saveAttendeeAnswers(new Map([[att.id, [a1.id]]]));

      const before = await getAttendeeAnswersBatch([att.id]);
      expect(before.get(att.id)).toEqual([a1.id]);

      await saveAttendeeAnswers(new Map([[att.id, [a2.id]]]));

      const after = await getAttendeeAnswersBatch([att.id]);
      expect(after.get(att.id)).toEqual([a2.id]);
    });

    test("saveAttendeeAnswers with empty answerIds clears answers", async () => {
      const q = await questionsTable.insert({ text: "Colour?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });

      const event = await createTestEvent();
      const att = await createAttendee(event.id);
      await saveAttendeeAnswers(new Map([[att.id, [a1.id]]]));

      await saveAttendeeAnswers(new Map([[att.id, []]]));

      const after = await getAttendeeAnswersBatch([att.id]);
      expect(after.get(att.id)).toBeUndefined();
    });
  });

  describe("getAllQuestionsWithAnswers", () => {
    test("returns all questions with their answers", async () => {
      const q1 = await questionsTable.insert({ text: "Q1" });
      const q2 = await questionsTable.insert({ text: "Q2" });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 1,
        text: "A2",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "B1",
      });

      const all = await getAllQuestionsWithAnswers();
      expect(all).toHaveLength(2);

      const qWithA1 = all.find((q) => q.text === "Q1")!;
      expect(qWithA1.answers).toHaveLength(2);

      const qWithA2 = all.find((q) => q.text === "Q2")!;
      expect(qWithA2.answers).toHaveLength(1);
    });
  });

  describe("getNextAnswerSortOrder", () => {
    test("returns 0 for a question with no answers", async () => {
      const q = await questionsTable.insert({ text: "Empty Q" });
      expect(await getNextAnswerSortOrder(q.id)).toBe(0);
    });

    test("returns max sort_order + 1 when answers exist", async () => {
      const q = await questionsTable.insert({ text: "Q" });
      await answersTable.insert({ questionId: q.id, sortOrder: 0, text: "A1" });
      await answersTable.insert({ questionId: q.id, sortOrder: 1, text: "A2" });
      expect(await getNextAnswerSortOrder(q.id)).toBe(2);
    });
  });

  describe("getAnswerCountsForQuestion", () => {
    test("returns zero counts when no attendees have answered", async () => {
      const q = await questionsTable.insert({ text: "Color?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Blue",
      });
      const counts = await getAnswerCountsForQuestion(q.id);
      expect(counts.get(a1.id)).toBe(0);
      expect(counts.get(a2.id)).toBe(0);
    });

    test("counts attendee answers correctly", async () => {
      const event = await createTestEvent();
      const q = await questionsTable.insert({ text: "Size?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "S",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "M",
      });
      const att1 = await createAttendee(event.id, "Alice");
      const att2 = await createAttendee(event.id, "Bob");
      await saveAttendeeAnswers(new Map([[att1.id, [a1.id]]]));
      await saveAttendeeAnswers(new Map([[att2.id, [a1.id]]]));
      const counts = await getAnswerCountsForQuestion(q.id);
      expect(counts.get(a1.id)).toBe(2);
      expect(counts.get(a2.id)).toBe(0);
    });
  });

  describe("swapAnswerOrder", () => {
    test("swaps sort_order of two answers", async () => {
      const q = await questionsTable.insert({ text: "Q" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "First",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Second",
      });
      await swapAnswerOrder(a1.id, 0, a2.id, 1);
      const updated = await getQuestionWithAnswers(q.id);
      // After swap, "Second" should come first (sort_order 0) and "First" second (sort_order 1)
      expect(updated!.answers[0]!.text).toBe("Second");
      expect(updated!.answers[1]!.text).toBe("First");
    });
  });
});
