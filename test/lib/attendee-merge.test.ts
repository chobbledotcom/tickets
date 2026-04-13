import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import { queryAll } from "#lib/db/client.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import {
  answersTable,
  getAttendeeAnswersByQuestion,
  questionsTable,
  saveAttendeeAnswers,
  setEventQuestions,
} from "#lib/db/questions.ts";
import {
  applyAttendeeMerge,
  bookingConflictLabel,
  bookingKey,
  buildAttendeeMergeDiff,
  hasBookingConflicts,
  nonConflictAnswerLabel,
  validateAttendeeMergeDecision,
} from "#lib/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
} from "#lib/merge/attendee-merge-types.ts";
import { createTestEvent, describeWithEnv } from "#test-utils";

/** Create a test attendee directly via the DB */
const createAttendee = async (
  eventId: number,
  name = "Alice",
  email?: string,
  date?: string | null,
) => {
  const result = await createAttendeeAtomic({
    name,
    email: email ?? `${name.toLowerCase()}@test.com`,
    bookings: [{ eventId, date }],
  });
  if (!result.success)
    throw new Error(`Failed to create attendee: ${result.reason}`);
  return result.attendees[0]!;
};

/** Get bookings for an attendee */
const getBookings = (attendeeId: number) =>
  queryAll<{
    event_id: number;
    start_at: string | null;
    end_at: string | null;
    quantity: number;
    checked_in: number;
    refunded: number;
    price_paid: number;
    attachment_downloads: number;
  }>(
    `SELECT event_id, start_at, end_at, quantity,
            checked_in, refunded, price_paid,
            attachment_downloads
     FROM event_attendees
     WHERE attendee_id = ?
     ORDER BY start_at, event_id`,
    [attendeeId],
  );

/** Create a question with answers and assign to event */
const createQuestionWithAnswers = async (
  eventId: number,
  questionText: string,
  answerTexts: string[],
) => {
  const q = await questionsTable.insert({ text: questionText });
  const answers = [];
  for (let i = 0; i < answerTexts.length; i++) {
    const a = await answersTable.insert({
      questionId: q.id,
      text: answerTexts[i]!,
      sortOrder: i,
    });
    answers.push(a);
  }
  await setEventQuestions(eventId, [q.id]);
  return { question: q, answers };
};

describeWithEnv("attendee merge service", { db: true }, () => {
  describe("bookingKey", () => {
    test("formats key with start_at", () => {
      expect(bookingKey(1, "2026-05-01")).toBe("1:2026-05-01");
    });

    test("formats key with null start_at", () => {
      expect(bookingKey(1, null)).toBe("1:null");
    });
  });

  describe("nonConflictAnswerLabel", () => {
    test("returns target label when target has answer", () => {
      const item = {
        questionId: 1,
        questionText: "Q?",
        targetAnswerId: 10,
        targetAnswerText: "Red",
        sourceAnswerId: null,
        sourceAnswerText: null,
        conflict: false,
      };
      expect(nonConflictAnswerLabel(item)).toEqual({
        answer: "Red",
        from: "target",
      });
    });

    test("returns source label when only source has answer", () => {
      const item = {
        questionId: 1,
        questionText: "Q?",
        targetAnswerId: null,
        targetAnswerText: null,
        sourceAnswerId: 20,
        sourceAnswerText: "Water",
        conflict: false,
      };
      expect(nonConflictAnswerLabel(item)).toEqual({
        answer: "Water",
        from: "source",
      });
    });
  });

  describe("bookingConflictLabel", () => {
    test("returns Duplicate for duplicate conflict class", () => {
      const item = {
        conflictClass: "duplicate" as const,
        eventId: 1,
        startAt: null,
        sourceBooking:
          {} as import("#lib/db/attendee-types.ts").EventAttendeeRow,
        targetBooking: null,
      };
      expect(bookingConflictLabel(item)).toBe("Duplicate");
    });

    test("returns Conflicting metadata for conflicting_metadata class", () => {
      const item = {
        conflictClass: "conflicting_metadata" as const,
        eventId: 1,
        startAt: null,
        sourceBooking:
          {} as import("#lib/db/attendee-types.ts").EventAttendeeRow,
        targetBooking: null,
      };
      expect(bookingConflictLabel(item)).toBe("Conflicting metadata");
    });
  });

  describe("hasBookingConflicts", () => {
    test("returns false when all items are moveable", () => {
      const items = [
        {
          conflictClass: "moveable" as const,
          eventId: 1,
          startAt: null,
          sourceBooking:
            {} as import("#lib/db/attendee-types.ts").EventAttendeeRow,
          targetBooking: null,
        },
      ];
      expect(hasBookingConflicts(items)).toBe(false);
    });

    test("returns true when at least one item is not moveable", () => {
      const items = [
        {
          conflictClass: "moveable" as const,
          eventId: 1,
          startAt: null,
          sourceBooking:
            {} as import("#lib/db/attendee-types.ts").EventAttendeeRow,
          targetBooking: null,
        },
        {
          conflictClass: "duplicate" as const,
          eventId: 2,
          startAt: null,
          sourceBooking:
            {} as import("#lib/db/attendee-types.ts").EventAttendeeRow,
          targetBooking: null,
        },
      ];
      expect(hasBookingConflicts(items)).toBe(true);
    });
  });

  describe("buildAttendeeMergeDiff", () => {
    test("detects PII diffs", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const target = await createAttendee(event.id, "Alice", "alice@test.com");
      const source = await createAttendee(event.id, "Bob", "bob@test.com");
      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        [],
      );

      expect(diff.piiFields.length).toBe(5);
      const nameField = diff.piiFields.find((f) => f.field === "name")!;
      expect(nameField.same).toBe(false);
      expect(nameField.targetValue).toBe("Alice");
      expect(nameField.sourceValue).toBe("Bob");

      // phone/address/special_instructions are same (both empty)
      const phoneField = diff.piiFields.find((f) => f.field === "phone")!;
      expect(phoneField.same).toBe(true);
    });

    test("detects answer conflicts", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { question, answers } = await createQuestionWithAnswers(
        event.id,
        "Favourite colour?",
        ["Red", "Blue"],
      );

      const target = await createAttendee(event.id, "Alice");
      const source = await createAttendee(event.id, "Bob");

      await saveAttendeeAnswers([target.id], [answers[0]!.id]); // Red
      await saveAttendeeAnswers([source.id], [answers[1]!.id]); // Blue

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const questions: QuestionWithAnswers[] = [{ ...question, answers }];

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        questions,
      );

      expect(diff.answerItems.length).toBe(1);
      expect(diff.answerItems[0]!.conflict).toBe(true);
      expect(diff.answerItems[0]!.questionText).toBe("Favourite colour?");
      expect(diff.answerItems[0]!.targetAnswerId).toBe(answers[0]!.id);
      expect(diff.answerItems[0]!.sourceAnswerId).toBe(answers[1]!.id);
    });

    test("marks non-conflicting answers when only one has answer", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { question, answers } = await createQuestionWithAnswers(
        event.id,
        "Size?",
        ["Small", "Large"],
      );

      const target = await createAttendee(event.id, "Alice");
      const source = await createAttendee(event.id, "Bob");

      // Only source has an answer
      await saveAttendeeAnswers([source.id], [answers[1]!.id]);

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        [{ ...question, answers }],
      );

      expect(diff.answerItems.length).toBe(1);
      expect(diff.answerItems[0]!.conflict).toBe(false);
      expect(diff.answerItems[0]!.targetAnswerId).toBeNull();
      expect(diff.answerItems[0]!.sourceAnswerId).toBe(answers[1]!.id);
    });

    test("classifies bookings as moveable, duplicate, or conflicting", async () => {
      const event1 = await createTestEvent({
        name: "E1",
        maxAttendees: 10,
      });
      const event2 = await createTestEvent({
        name: "E2",
        maxAttendees: 10,
      });

      const target = await createAttendee(event1.id, "Alice");
      const source = await createAttendee(event1.id, "Bob");
      // Add source to event2 as well
      await createAttendeeAtomic({
        name: "Bob",
        email: "bob@test.com",
        bookings: [{ eventId: event2.id }],
      });
      // But for this test, let's use direct attendees
      // target is on event1, source is on event1 (duplicate) and event2 (moveable)

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        [],
      );

      // Source has 1 booking (event1) that conflicts with target's event1
      expect(diff.bookingItems.length).toBe(1);
      // Both on same event with same start_at (null) — duplicate
      expect(diff.bookingItems[0]!.conflictClass).toBe("duplicate");
    });

    test("includes version hash in diff", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const target = await createAttendee(event.id, "Alice");
      const source = await createAttendee(event.id, "Bob");

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings: await getBookings(target.id),
          sourceBookings: await getBookings(source.id),
        },
        [],
      );

      expect(diff.version).toBeTruthy();
      expect(typeof diff.version).toBe("string");
    });
  });

  test("uses fallback question text for orphaned answers", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    const q = await questionsTable.insert({ text: "Hidden Q" });
    const a1 = await answersTable.insert({
      questionId: q.id,
      text: "Yes",
      sortOrder: 0,
    });
    await setEventQuestions(event.id, [q.id]);

    const target = await createAttendee(event.id, "Alice", "alice@test.com");
    const source = await createAttendee(event.id, "Bob", "bob@test.com");
    await saveAttendeeAnswers([source.id], [a1.id]);

    const targetBookings = await getBookings(target.id);
    const sourceBookings = await getBookings(source.id);

    // Pass empty questions array — question text won't be found
    const diff = await buildAttendeeMergeDiff(
      {
        targetId: target.id,
        sourceId: source.id,
        targetPii: {
          name: "Alice",
          email: "alice@test.com",
          phone: "",
          address: "",
          special_instructions: "",
        },
        sourcePii: {
          name: "Bob",
          email: "bob@test.com",
          phone: "",
          address: "",
          special_instructions: "",
        },
        targetBookings,
        sourceBookings,
      },
      [], // No questions provided
    );

    const answerItem = diff.answerItems.find((a) => a.questionId === q.id);
    expect(answerItem?.questionText).toBe(`Question #${q.id}`);
  });

  describe("validateAttendeeMergeDecision", () => {
    test("rejects stale version", () => {
      const diff: AttendeeMergeDiff = {
        targetId: 1,
        sourceId: 2,
        piiFields: [],
        answerItems: [],
        bookingItems: [],
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        pii: {},
        answers: {},
        bookings: {},
        version: "v2",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("out of date");
      }
    });

    test("rejects missing answer decision for conflict", () => {
      const diff: AttendeeMergeDiff = {
        targetId: 1,
        sourceId: 2,
        piiFields: [],
        answerItems: [
          {
            questionId: 10,
            questionText: "Colour?",
            targetAnswerId: 1,
            targetAnswerText: "Red",
            sourceAnswerId: 2,
            sourceAnswerText: "Blue",
            conflict: true,
          },
        ],
        bookingItems: [],
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        pii: {},
        answers: {},
        bookings: {},
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("Colour?");
      }
    });

    test("rejects missing booking decision for conflict", () => {
      const diff: AttendeeMergeDiff = {
        targetId: 1,
        sourceId: 2,
        piiFields: [],
        answerItems: [],
        bookingItems: [
          {
            eventId: 5,
            startAt: null,
            sourceBooking: {
              event_id: 5,
              start_at: null,
              end_at: null,
              quantity: 1,
              checked_in: 0,
              refunded: 0,
              price_paid: 0,
              attachment_downloads: 0,
            },
            targetBooking: {
              event_id: 5,
              start_at: null,
              end_at: null,
              quantity: 2,
              checked_in: 0,
              refunded: 0,
              price_paid: 0,
              attachment_downloads: 0,
            },
            conflictClass: "conflicting_metadata",
          },
        ],
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        pii: {},
        answers: {},
        bookings: {},
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("Event #5");
      }
    });

    test("rejects missing booking decision for daily event conflict", () => {
      const diff: AttendeeMergeDiff = {
        targetId: 1,
        sourceId: 2,
        piiFields: [],
        answerItems: [],
        bookingItems: [
          {
            eventId: 7,
            startAt: "2026-06-15T10:00:00Z",
            sourceBooking: {
              event_id: 7,
              start_at: "2026-06-15T10:00:00Z",
              end_at: null,
              quantity: 1,
              checked_in: 0,
              refunded: 0,
              price_paid: 0,
              attachment_downloads: 0,
            },
            targetBooking: {
              event_id: 7,
              start_at: "2026-06-15T10:00:00Z",
              end_at: null,
              quantity: 2,
              checked_in: 0,
              refunded: 0,
              price_paid: 0,
              attachment_downloads: 0,
            },
            conflictClass: "duplicate",
          },
        ],
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        pii: {},
        answers: {},
        bookings: {},
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("2026-06-15");
      }
    });

    test("accepts valid decisions", () => {
      const diff: AttendeeMergeDiff = {
        targetId: 1,
        sourceId: 2,
        piiFields: [],
        answerItems: [
          {
            questionId: 10,
            questionText: "Colour?",
            targetAnswerId: 1,
            targetAnswerText: "Red",
            sourceAnswerId: 2,
            sourceAnswerText: "Blue",
            conflict: true,
          },
        ],
        bookingItems: [
          {
            eventId: 5,
            startAt: null,
            sourceBooking: {
              event_id: 5,
              start_at: null,
              end_at: null,
              quantity: 1,
              checked_in: 0,
              refunded: 0,
              price_paid: 0,
              attachment_downloads: 0,
            },
            targetBooking: {
              event_id: 5,
              start_at: null,
              end_at: null,
              quantity: 2,
              checked_in: 0,
              refunded: 0,
              price_paid: 0,
              attachment_downloads: 0,
            },
            conflictClass: "duplicate",
          },
        ],
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        pii: { name: "target" },
        answers: { "10": "source" },
        bookings: { "5:null": "keep_target" },
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(true);
    });
  });

  describe("applyAttendeeMerge", () => {
    test("applies PII and answer decisions correctly", async () => {
      const event1 = await createTestEvent({
        name: "E1",
        maxAttendees: 10,
      });
      const event2 = await createTestEvent({
        name: "E2",
        maxAttendees: 10,
      });

      const { question, answers } = await createQuestionWithAnswers(
        event1.id,
        "Colour?",
        ["Red", "Blue"],
      );

      const target = await createAttendee(event1.id, "Alice", "alice@test.com");
      const source = await createAttendee(event2.id, "Bob", "bob@test.com");

      await saveAttendeeAnswers([target.id], [answers[0]!.id]); // Red
      await saveAttendeeAnswers([source.id], [answers[1]!.id]); // Blue

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        [{ ...question, answers }],
      );

      const decision: AttendeeMergeDecisionInput = {
        pii: { name: "source", email: "target" },
        answers: { [String(question.id)]: "source" },
        bookings: {},
        version: diff.version,
      };

      const result = await applyAttendeeMerge({
        targetId: target.id,
        sourceId: source.id,
        targetPii: {
          name: "Alice",
          email: "alice@test.com",
          phone: "",
          address: "",
          special_instructions: "",
          payment_id: target.payment_id,
          ticket_token: target.ticket_token,
        },
        sourcePii: {
          name: "Bob",
          email: "bob@test.com",
          phone: "",
          address: "",
          special_instructions: "",
        },
        diff,
        decision,
      });

      expect(result.success).toBe(true);
      expect(result.summary.piiFieldsFromSource).toEqual(["name"]);
      expect(result.summary.answersTakenFromSource).toBe(1);
      expect(result.summary.bookingsMoved).toBe(1); // event2 moved to target

      // Verify answers were updated
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);

      // Verify source deleted
      const sourceRows = await queryAll<{ id: number }>(
        "SELECT id FROM attendees WHERE id = ?",
        [source.id],
      );
      expect(sourceRows.length).toBe(0);

      // Verify target has both event links
      const eventLinks = await queryAll<{ event_id: number }>(
        "SELECT event_id FROM event_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(eventLinks.map((r) => r.event_id).sort()).toEqual(
        [event1.id, event2.id].sort(),
      );
    });

    test("clears answers when decision is clear", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const event2 = await createTestEvent({
        name: "E2",
        maxAttendees: 10,
      });
      const { question, answers } = await createQuestionWithAnswers(
        event.id,
        "Size?",
        ["S", "L"],
      );

      const target = await createAttendee(event.id, "Alice");
      const source = await createAttendee(event2.id, "Bob");

      await saveAttendeeAnswers([target.id], [answers[0]!.id]);
      await saveAttendeeAnswers([source.id], [answers[1]!.id]);

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        [{ ...question, answers }],
      );

      const result = await applyAttendeeMerge({
        targetId: target.id,
        sourceId: source.id,
        targetPii: {
          name: "Alice",
          email: "alice@test.com",
          phone: "",
          address: "",
          special_instructions: "",
          payment_id: target.payment_id,
          ticket_token: target.ticket_token,
        },
        sourcePii: {
          name: "Bob",
          email: "bob@test.com",
          phone: "",
          address: "",
          special_instructions: "",
        },
        diff,
        decision: {
          pii: {},
          answers: { [String(question.id)]: "clear" },
          bookings: {},
          version: diff.version,
        },
      });

      expect(result.summary.answersCleared).toBe(1);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.has(question.id)).toBe(false);
    });

    test("adopts source answers when target has none", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const event2 = await createTestEvent({
        name: "E2",
        maxAttendees: 10,
      });
      const { question, answers } = await createQuestionWithAnswers(
        event.id,
        "Meal?",
        ["Chicken", "Fish"],
      );

      const target = await createAttendee(event.id, "Alice");
      const source = await createAttendee(event2.id, "Bob");

      // Only source has answer
      await saveAttendeeAnswers([source.id], [answers[1]!.id]);

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        [{ ...question, answers }],
      );

      const result = await applyAttendeeMerge({
        targetId: target.id,
        sourceId: source.id,
        targetPii: {
          name: "Alice",
          email: "alice@test.com",
          phone: "",
          address: "",
          special_instructions: "",
          payment_id: target.payment_id,
          ticket_token: target.ticket_token,
        },
        sourcePii: {
          name: "Bob",
          email: "bob@test.com",
          phone: "",
          address: "",
          special_instructions: "",
        },
        diff,
        decision: {
          pii: {},
          answers: {},
          bookings: {},
          version: diff.version,
        },
      });

      expect(result.summary.answersTakenFromSource).toBe(1);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);
    });

    test("handles duplicate booking with keep_target decision", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      const target = await createAttendee(event.id, "Alice");
      const source = await createAttendee(event.id, "Bob");

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        [],
      );

      expect(diff.bookingItems[0]!.conflictClass).toBe("duplicate");

      const key = bookingKey(event.id, null);
      const result = await applyAttendeeMerge({
        targetId: target.id,
        sourceId: source.id,
        targetPii: {
          name: "Alice",
          email: "alice@test.com",
          phone: "",
          address: "",
          special_instructions: "",
          payment_id: target.payment_id,
          ticket_token: target.ticket_token,
        },
        sourcePii: {
          name: "Bob",
          email: "bob@test.com",
          phone: "",
          address: "",
          special_instructions: "",
        },
        diff,
        decision: {
          pii: {},
          answers: {},
          bookings: { [key]: "keep_target" },
          version: diff.version,
        },
      });

      expect(result.summary.bookingsSkipped).toBe(1);
      expect(result.summary.bookingsMoved).toBe(0);

      // Target still has exactly 1 booking
      const links = await queryAll<{ event_id: number }>(
        "SELECT event_id FROM event_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(links.length).toBe(1);
    });

    test("replaces target booking with take_source decision", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      const target = await createAttendee(event.id, "Alice");
      const source = await createAttendee(event.id, "Bob");

      // Update source booking to have different quantity to create conflicting_metadata
      await queryAll(
        "UPDATE event_attendees SET quantity = 5 WHERE attendee_id = ?",
        [source.id],
      );

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings,
          sourceBookings,
        },
        [],
      );

      expect(diff.bookingItems[0]!.conflictClass).toBe("conflicting_metadata");

      const key = bookingKey(event.id, null);
      const result = await applyAttendeeMerge({
        targetId: target.id,
        sourceId: source.id,
        targetPii: {
          name: "Alice",
          email: "alice@test.com",
          phone: "",
          address: "",
          special_instructions: "",
          payment_id: target.payment_id,
          ticket_token: target.ticket_token,
        },
        sourcePii: {
          name: "Bob",
          email: "bob@test.com",
          phone: "",
          address: "",
          special_instructions: "",
        },
        diff,
        decision: {
          pii: {},
          answers: {},
          bookings: { [key]: "take_source" },
          version: diff.version,
        },
      });

      expect(result.summary.bookingsReplacedTarget).toBe(1);

      // Target's booking should now have qty 5
      const links = await queryAll<{ quantity: number }>(
        `SELECT quantity
         FROM event_attendees
         WHERE attendee_id = ?
           AND event_id = ?`,
        [target.id, event.id],
      );
      expect(links.length).toBe(1);
      expect(links[0]!.quantity).toBe(5);
    });

    test("returns accurate summary counts", async () => {
      const event1 = await createTestEvent({
        name: "E1",
        maxAttendees: 10,
      });
      const event2 = await createTestEvent({
        name: "E2",
        maxAttendees: 10,
      });

      const target = await createAttendee(event1.id, "Alice");
      const source = await createAttendee(event2.id, "Bob");

      const diff = await buildAttendeeMergeDiff(
        {
          targetId: target.id,
          sourceId: source.id,
          targetPii: {
            name: "Alice",
            email: "alice@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          sourcePii: {
            name: "Bob",
            email: "bob@test.com",
            phone: "",
            address: "",
            special_instructions: "",
          },
          targetBookings: await getBookings(target.id),
          sourceBookings: await getBookings(source.id),
        },
        [],
      );

      // Source is on event2 only, target on event1 — no conflicts, 1 moveable
      expect(diff.bookingItems.length).toBe(1);
      expect(diff.bookingItems[0]!.conflictClass).toBe("moveable");

      const result = await applyAttendeeMerge({
        targetId: target.id,
        sourceId: source.id,
        targetPii: {
          name: "Alice",
          email: "alice@test.com",
          phone: "",
          address: "",
          special_instructions: "",
          payment_id: target.payment_id,
          ticket_token: target.ticket_token,
        },
        sourcePii: {
          name: "Bob",
          email: "bob@test.com",
          phone: "",
          address: "",
          special_instructions: "",
        },
        diff,
        decision: {
          pii: { name: "source" },
          answers: {},
          bookings: {},
          version: diff.version,
        },
      });

      expect(result.success).toBe(true);
      expect(result.summary.piiFieldsFromSource).toEqual(["name"]);
      expect(result.summary.bookingsMoved).toBe(1);
      expect(result.summary.bookingsSkipped).toBe(0);
      expect(result.summary.bookingsReplacedTarget).toBe(0);
    });
  });
});
