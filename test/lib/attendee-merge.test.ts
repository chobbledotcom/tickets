import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import {
  createAttendeeAtomic,
  LISTING_ATTENDEE_ROW_COLS,
} from "#shared/db/attendees.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import {
  answersTable,
  getAttendeeAnswersByQuestion,
  getAttendeeTextAnswers,
  questionsTable,
  saveAttendeeAnswers,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  applyAttendeeMerge,
  bookingConflictLabel,
  bookingKey,
  buildAttendeeMergeDiff,
  hasBookingConflicts,
  nonConflictAnswerLabel,
  validateAttendeeMergeDecision,
} from "#shared/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
} from "#shared/merge/attendee-merge-types.ts";
import { bookAttendee, createTestListing, describeWithEnv } from "#test-utils";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

/** Create a test attendee directly via the DB */
const createAttendee = async (
  listingId: number,
  name = "Alice",
  email?: string,
  date?: string | null,
) => {
  const result = await createAttendeeAtomic({
    bookings: [{ date, listingId }],
    email: email ?? `${name.toLowerCase()}@test.com`,
    name,
  });
  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }
  return result.attendees[0]!;
};

/** Get bookings for an attendee — `refunded` is projected from the ledger, the
 *  same shape production's merge loader returns. */
const getBookings = (attendeeId: number) =>
  queryAll<{
    listing_id: number;
    start_at: string | null;
    end_at: string | null;
    quantity: number;
    checked_in: number;
    refunded: number;
    price_paid: number;
    ledger_event_group: string;
    attachment_downloads: number;
  }>(
    `SELECT ${LISTING_ATTENDEE_ROW_COLS}
     FROM listing_attendees
     WHERE attendee_id = ?
     ORDER BY start_at, listing_id`,
    [attendeeId],
  );

/** Create a question with answers and assign to listing */
const createQuestionWithAnswers = async (
  listingId: number,
  questionText: string,
  answerTexts: string[],
) => {
  const q = await questionsTable.insert({
    displayType: "radio",
    text: questionText,
  });
  const answers = [];
  for (let i = 0; i < answerTexts.length; i++) {
    const a = await answersTable.insert({
      questionId: q.id,
      sortOrder: i,
      text: answerTexts[i]!,
    });
    answers.push(a);
  }
  await setListingQuestions(listingId, [q.id]);
  return { answers, question: q };
};

describeWithEnv("attendee merge service", { db: true }, () => {
  test("repoints the source's ledger rows onto the target", async () => {
    const listing1 = await createTestListing({ maxAttendees: 10 });
    const listing2 = await createTestListing({ maxAttendees: 10 });
    const target = await createAttendee(listing1.id, "Alice", "alice@test.com");
    const source = await createAttendee(listing2.id, "Bob", "bob@test.com");

    // A paid booking on the source attendee, recorded in the ledger.
    await postTransfers([
      {
        amount: 5000,
        destination: revenueAccount(listing2.id),
        eventGroup: "evt",
        kind: "sale",
        occurredAt: "2026-06-21T00:00:00.000Z",
        reference: "sale",
        source: attendeeAccount(source.id),
      },
      {
        amount: 5000,
        destination: attendeeAccount(source.id),
        eventGroup: "evt",
        kind: "payment",
        occurredAt: "2026-06-21T00:00:00.000Z",
        reference: "pay",
        source: WORLD,
      },
    ]);

    const diff = await buildAttendeeMergeDiff(
      {
        sourceBookings: await getBookings(source.id),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetBookings: await getBookings(target.id),
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          phone: "",
          special_instructions: "",
        },
      },
      [],
    );

    const result = await applyAttendeeMerge({
      decision: { answers: {}, bookings: {}, pii: {}, version: diff.version },
      diff,
      privateKey: await getTestPrivateKey(),
      sourceId: source.id,
      sourcePii: {
        address: "",
        email: "bob@test.com",
        name: "Bob",
        phone: "",
        special_instructions: "",
      },
      targetId: target.id,
      targetPii: {
        address: "",
        email: "alice@test.com",
        name: "Alice",
        payment_id: target.payment_id,
        phone: "",
        special_instructions: "",
        ticket_token: target.ticket_token,
      },
    });

    expect(result.success).toBe(true);
    // The source's legs now belong to the target; nothing strands on the
    // deleted source attendee.
    expect((await transfersByAccount(attendeeAccount(source.id))).length).toBe(
      0,
    );
    expect((await transfersByAccount(attendeeAccount(target.id))).length).toBe(
      2,
    );
  });

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
        conflict: false,
        questionId: 1,
        questionText: "Q?",
        sourceAnswerId: null,
        sourceAnswerText: null,
        targetAnswerId: 10,
        targetAnswerText: "Red",
      };
      expect(nonConflictAnswerLabel(item)).toEqual({
        answer: "Red",
        from: "target",
      });
    });

    test("returns source label when only source has answer", () => {
      const item = {
        conflict: false,
        questionId: 1,
        questionText: "Q?",
        sourceAnswerId: 20,
        sourceAnswerText: "Water",
        targetAnswerId: null,
        targetAnswerText: null,
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
        listingId: 1,
        sourceBooking:
          {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
        startAt: null,
        targetBooking: null,
      };
      expect(bookingConflictLabel(item)).toBe("Duplicate");
    });

    test("returns Conflicting metadata for conflicting_metadata class", () => {
      const item = {
        conflictClass: "conflicting_metadata" as const,
        listingId: 1,
        sourceBooking:
          {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
        startAt: null,
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
          listingId: 1,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
      ];
      expect(hasBookingConflicts(items)).toBe(false);
    });

    test("returns true when at least one item is not moveable", () => {
      const items = [
        {
          conflictClass: "moveable" as const,
          listingId: 1,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
        {
          conflictClass: "duplicate" as const,
          listingId: 2,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
      ];
      expect(hasBookingConflicts(items)).toBe(true);
    });
  });

  describe("buildAttendeeMergeDiff", () => {
    test("detects PII diffs", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const target = await createAttendee(
        listing.id,
        "Alice",
        "alice@test.com",
      );
      const source = await createAttendee(listing.id, "Bob", "bob@test.com");
      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
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
      const listing = await createTestListing({ maxAttendees: 10 });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Favourite colour?",
        ["Red", "Blue"],
      );

      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing.id, "Bob");

      await saveAttendeeAnswers(new Map([[target.id, [answers[0]!.id]]])); // Red
      await saveAttendeeAnswers(new Map([[source.id, [answers[1]!.id]]])); // Blue

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const questions: QuestionWithAnswers[] = [{ ...question, answers }];

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
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
      const listing = await createTestListing({ maxAttendees: 10 });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Size?",
        ["Small", "Large"],
      );

      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing.id, "Bob");

      // Only source has an answer
      await saveAttendeeAnswers(new Map([[source.id, [answers[1]!.id]]]));

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [{ ...question, answers }],
      );

      expect(diff.answerItems.length).toBe(1);
      expect(diff.answerItems[0]!.conflict).toBe(false);
      expect(diff.answerItems[0]!.targetAnswerId).toBeNull();
      expect(diff.answerItems[0]!.sourceAnswerId).toBe(answers[1]!.id);
    });

    test("classifies bookings as moveable, duplicate, or conflicting", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });

      const target = await createAttendee(listing1.id, "Alice");
      const source = await createAttendee(listing1.id, "Bob");
      // Add source to listing2 as well
      await bookAttendee(listing2, { email: "bob@test.com", name: "Bob" });
      // But for this test, let's use direct attendees
      // target is on listing1, source is on listing1 (duplicate) and listing2 (moveable)

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [],
      );

      // Source has 1 booking (listing1) that conflicts with target's listing1
      expect(diff.bookingItems.length).toBe(1);
      // Both on same listing with same start_at (null) — duplicate
      expect(diff.bookingItems[0]!.conflictClass).toBe("duplicate");
    });

    test("includes version hash in diff", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing.id, "Bob");

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings: await getBookings(source.id),
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings: await getBookings(target.id),
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [],
      );

      expect(diff.version).toBeTruthy();
      expect(typeof diff.version).toBe("string");
    });
  });

  test("uses fallback question text for orphaned answers", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const q = await questionsTable.insert({
      displayType: "radio",
      text: "Hidden Q",
    });
    const a1 = await answersTable.insert({
      questionId: q.id,
      sortOrder: 0,
      text: "Yes",
    });
    await setListingQuestions(listing.id, [q.id]);

    const target = await createAttendee(listing.id, "Alice", "alice@test.com");
    const source = await createAttendee(listing.id, "Bob", "bob@test.com");
    await saveAttendeeAnswers(new Map([[source.id, [a1.id]]]));

    const targetBookings = await getBookings(target.id);
    const sourceBookings = await getBookings(source.id);

    // Pass empty questions array — question text won't be found
    const diff = await buildAttendeeMergeDiff(
      {
        sourceBookings,
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetBookings,
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          phone: "",
          special_instructions: "",
        },
      },
      [], // No questions provided
    );

    const answerItem = diff.answerItems.find((a) => a.questionId === q.id);
    expect(answerItem?.questionText).toBe(`Question #${q.id}`);
  });

  describe("validateAttendeeMergeDecision", () => {
    test("rejects stale version", () => {
      const diff: AttendeeMergeDiff = {
        answerItems: [],
        bookingItems: [],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        answers: {},
        bookings: {},
        pii: {},
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
        answerItems: [
          {
            conflict: true,
            questionId: 10,
            questionText: "Colour?",
            sourceAnswerId: 2,
            sourceAnswerText: "Blue",
            targetAnswerId: 1,
            targetAnswerText: "Red",
          },
        ],
        bookingItems: [],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        answers: {},
        bookings: {},
        pii: {},
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
        answerItems: [],
        bookingItems: [
          {
            conflictClass: "conflicting_metadata",
            listingId: 5,
            sourceBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 5,
              price_paid: 0,
              quantity: 1,
              refunded: 0,
              start_at: null,
            },
            startAt: null,
            targetBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 5,
              price_paid: 0,
              quantity: 2,
              refunded: 0,
              start_at: null,
            },
          },
        ],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        answers: {},
        bookings: {},
        pii: {},
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("Listing #5");
      }
    });

    test("rejects missing booking decision for daily listing conflict", () => {
      const diff: AttendeeMergeDiff = {
        answerItems: [],
        bookingItems: [
          {
            conflictClass: "duplicate",
            listingId: 7,
            sourceBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 7,
              price_paid: 0,
              quantity: 1,
              refunded: 0,
              start_at: "2026-06-15T10:00:00Z",
            },
            startAt: "2026-06-15T10:00:00Z",
            targetBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 7,
              price_paid: 0,
              quantity: 2,
              refunded: 0,
              start_at: "2026-06-15T10:00:00Z",
            },
          },
        ],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        answers: {},
        bookings: {},
        pii: {},
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("2026-06-15");
      }
    });

    test("rejects copying a no-quantity source line that still carries a payment", () => {
      // A quantity-0 line must have price_paid = 0; merging one that doesn't
      // would strand the charge behind the quantity-0 refund guards.
      const diff: AttendeeMergeDiff = {
        answerItems: [],
        bookingItems: [
          {
            conflictClass: "moveable",
            listingId: 5,
            sourceBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 5,
              price_paid: 1500,
              quantity: 0,
              refunded: 0,
              start_at: null,
            },
            startAt: null,
            targetBooking: null,
          },
        ],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        answers: {},
        bookings: {},
        pii: {},
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("strand a recorded payment");
      }
    });

    test("rejects replacing an active paid target line with a no-quantity source", () => {
      // take_source would delete the paid target and insert the quantity-0
      // source, stranding the target's payment behind a ghost row.
      const diff: AttendeeMergeDiff = {
        answerItems: [],
        bookingItems: [
          {
            conflictClass: "conflicting_metadata",
            listingId: 5,
            sourceBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 5,
              price_paid: 0,
              quantity: 0,
              refunded: 0,
              start_at: null,
            },
            startAt: null,
            targetBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 5,
              price_paid: 1500,
              quantity: 2,
              refunded: 0,
              start_at: null,
            },
          },
        ],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        answers: {},
        bookings: { "5:null": "take_source" },
        pii: {},
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("strand a recorded payment");
      }
    });

    test("allows moving a no-quantity source line that carries no payment", () => {
      // A clean quantity-0 sentinel (no payment, no paid target) is moveable.
      const diff: AttendeeMergeDiff = {
        answerItems: [],
        bookingItems: [
          {
            conflictClass: "moveable",
            listingId: 5,
            sourceBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 5,
              price_paid: 0,
              quantity: 0,
              refunded: 0,
              start_at: null,
            },
            startAt: null,
            targetBooking: null,
          },
        ],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        answers: {},
        bookings: {},
        pii: {},
        version: "v1",
      };
      expect(validateAttendeeMergeDecision(diff, decision).valid).toBe(true);
    });

    test("accepts valid decisions", () => {
      const diff: AttendeeMergeDiff = {
        answerItems: [
          {
            conflict: true,
            questionId: 10,
            questionText: "Colour?",
            sourceAnswerId: 2,
            sourceAnswerText: "Blue",
            targetAnswerId: 1,
            targetAnswerText: "Red",
          },
        ],
        bookingItems: [
          {
            conflictClass: "duplicate",
            listingId: 5,
            sourceBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 5,
              price_paid: 0,
              quantity: 1,
              refunded: 0,
              start_at: null,
            },
            startAt: null,
            targetBooking: {
              attachment_downloads: 0,
              checked_in: 0,
              end_at: null,
              ledger_event_group: "",
              listing_id: 5,
              price_paid: 0,
              quantity: 2,
              refunded: 0,
              start_at: null,
            },
          },
        ],
        piiFields: [],
        sourceId: 2,
        targetId: 1,
        version: "v1",
      };
      const decision: AttendeeMergeDecisionInput = {
        answers: { "10": "source" },
        bookings: { "5:null": "keep_target" },
        pii: { name: "target" },
        version: "v1",
      };
      const result = validateAttendeeMergeDecision(diff, decision);
      expect(result.valid).toBe(true);
    });
  });

  describe("applyAttendeeMerge", () => {
    test("clears check-in when copying a no-quantity source line", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "M1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "M2",
      });
      const target = await createAttendee(listing1.id, "Alice", "a@test.com");
      const source = await createAttendee(listing2.id, "Bob", "b@test.com");
      // Make source's line a checked-in quantity-0 sentinel (price 0).
      await getDb().execute({
        args: [source.id],
        sql: "UPDATE listing_attendees SET quantity = 0, checked_in = 1 WHERE attendee_id = ?",
      });

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings: await getBookings(source.id),
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "b@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings: await getBookings(target.id),
          targetId: target.id,
          targetPii: {
            address: "",
            email: "a@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [],
      );
      const result = await applyAttendeeMerge({
        decision: { answers: {}, bookings: {}, pii: {}, version: diff.version },
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "b@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "a@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
        },
      });
      expect(result.success).toBe(true);

      const moved = (await getBookings(target.id)).find(
        (b) => b.listing_id === listing2.id,
      )!;
      expect(moved.quantity).toBe(0);
      // The ghost line arrives with its check-in cleared.
      expect(moved.checked_in).toBe(0);
    });

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

      await saveAttendeeAnswers(new Map([[target.id, [answers[0]!.id]]])); // Red
      await saveAttendeeAnswers(new Map([[source.id, [answers[1]!.id]]])); // Blue

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [{ ...question, answers }],
      );

      const decision: AttendeeMergeDecisionInput = {
        answers: { [String(question.id)]: "source" },
        bookings: {},
        pii: { email: "target", name: "source" },
        version: diff.version,
      };

      const result = await applyAttendeeMerge({
        decision,
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
        },
      });

      expect(result.success).toBe(true);
      expect(result.summary.piiFieldsFromSource).toEqual(["name"]);
      expect(result.summary.answersTakenFromSource).toBe(1);
      expect(result.summary.bookingsMoved).toBe(1); // listing2 moved to target

      // Verify answers were updated
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);

      // Verify source deleted
      const sourceRows = await queryAll<{ id: number }>(
        "SELECT id FROM attendees WHERE id = ?",
        [source.id],
      );
      expect(sourceRows.length).toBe(0);

      // Verify target has both listing links
      const listingLinks = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(listingLinks.map((r) => r.listing_id).sort()).toEqual(
        [listing1.id, listing2.id].sort(),
      );
    });

    test("preserves the target's free-text answers through a merge", async () => {
      // Regression: the merge re-saves only the target's choice answers, which
      // deletes every attendee_answers row for the target. Without carrying the
      // free-text answers through, those text rows were silently wiped.
      const listing = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const textQuestion = await questionsTable.insert({
        displayType: "free_text",
        text: "Dietary needs?",
      });

      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing2.id, "Bob");

      await saveAttendeeAnswers(
        new Map([
          [
            target.id,
            {
              answerIds: [],
              textAnswers: [{ questionId: textQuestion.id, text: "Coeliac" }],
            },
          ],
        ]),
      );

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);
      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [],
      );

      const result = await applyAttendeeMerge({
        decision: { answers: {}, bookings: {}, pii: {}, version: diff.version },
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
        },
      });

      expect(result.success).toBe(true);
      const textAnswers = await getAttendeeTextAnswers(
        target.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(textQuestion.id)).toBe("Coeliac");
    });

    test("adopts a source-only free-text answer in a merge", async () => {
      // Source-only choice answers are adopted automatically; a source-only
      // text answer must be too, rather than vanishing when the source is
      // deleted.
      const listing = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const textQuestion = await questionsTable.insert({
        displayType: "free_text",
        text: "Dietary needs?",
      });

      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing2.id, "Bob");

      await saveAttendeeAnswers(
        new Map([
          [
            source.id,
            {
              answerIds: [],
              textAnswers: [{ questionId: textQuestion.id, text: "Vegan" }],
            },
          ],
        ]),
      );

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);
      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [],
      );

      const result = await applyAttendeeMerge({
        decision: { answers: {}, bookings: {}, pii: {}, version: diff.version },
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
        },
      });

      expect(result.success).toBe(true);
      const textAnswers = await getAttendeeTextAnswers(
        target.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(textQuestion.id)).toBe("Vegan");
    });

    test("clears answers when decision is clear", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Size?",
        ["S", "L"],
      );

      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing2.id, "Bob");

      await saveAttendeeAnswers(new Map([[target.id, [answers[0]!.id]]]));
      await saveAttendeeAnswers(new Map([[source.id, [answers[1]!.id]]]));

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [{ ...question, answers }],
      );

      const result = await applyAttendeeMerge({
        decision: {
          answers: { [String(question.id)]: "clear" },
          bookings: {},
          pii: {},
          version: diff.version,
        },
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
        },
      });

      expect(result.summary.answersCleared).toBe(1);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.has(question.id)).toBe(false);
    });

    test("adopts source answers when target has none", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { question, answers } = await createQuestionWithAnswers(
        listing.id,
        "Meal?",
        ["Chicken", "Fish"],
      );

      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing2.id, "Bob");

      // Only source has answer
      await saveAttendeeAnswers(new Map([[source.id, [answers[1]!.id]]]));

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [{ ...question, answers }],
      );

      const result = await applyAttendeeMerge({
        decision: {
          answers: {},
          bookings: {},
          pii: {},
          version: diff.version,
        },
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
        },
      });

      expect(result.summary.answersTakenFromSource).toBe(1);
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(question.id)?.answerId).toBe(answers[1]!.id);
    });

    test("handles duplicate booking with keep_target decision", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing.id, "Bob");

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [],
      );

      expect(diff.bookingItems[0]!.conflictClass).toBe("duplicate");

      const key = bookingKey(listing.id, null);
      const result = await applyAttendeeMerge({
        decision: {
          answers: {},
          bookings: { [key]: "keep_target" },
          pii: {},
          version: diff.version,
        },
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
        },
      });

      expect(result.summary.bookingsSkipped).toBe(1);
      expect(result.summary.bookingsMoved).toBe(0);

      // Target still has exactly 1 booking
      const links = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(links.length).toBe(1);
    });

    test("replaces target booking with take_source decision", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const target = await createAttendee(listing.id, "Alice");
      const source = await createAttendee(listing.id, "Bob");

      // Update source booking to have different quantity to create conflicting_metadata
      await queryAll(
        "UPDATE listing_attendees SET quantity = 5 WHERE attendee_id = ?",
        [source.id],
      );

      const targetBookings = await getBookings(target.id);
      const sourceBookings = await getBookings(source.id);

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings,
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings,
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [],
      );

      expect(diff.bookingItems[0]!.conflictClass).toBe("conflicting_metadata");

      const key = bookingKey(listing.id, null);
      const result = await applyAttendeeMerge({
        decision: {
          answers: {},
          bookings: { [key]: "take_source" },
          pii: {},
          version: diff.version,
        },
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
        },
      });

      expect(result.summary.bookingsReplacedTarget).toBe(1);

      // Target's booking should now have qty 5
      const links = await queryAll<{ quantity: number }>(
        `SELECT quantity
         FROM listing_attendees
         WHERE attendee_id = ?
           AND listing_id = ?`,
        [target.id, listing.id],
      );
      expect(links.length).toBe(1);
      expect(links[0]!.quantity).toBe(5);
    });

    test("returns accurate summary counts", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });

      const target = await createAttendee(listing1.id, "Alice");
      const source = await createAttendee(listing2.id, "Bob");

      const diff = await buildAttendeeMergeDiff(
        {
          sourceBookings: await getBookings(source.id),
          sourceId: source.id,
          sourcePii: {
            address: "",
            email: "bob@test.com",
            name: "Bob",
            phone: "",
            special_instructions: "",
          },
          targetBookings: await getBookings(target.id),
          targetId: target.id,
          targetPii: {
            address: "",
            email: "alice@test.com",
            name: "Alice",
            phone: "",
            special_instructions: "",
          },
        },
        [],
      );

      // Source is on listing2 only, target on listing1 — no conflicts, 1 moveable
      expect(diff.bookingItems.length).toBe(1);
      expect(diff.bookingItems[0]!.conflictClass).toBe("moveable");

      const result = await applyAttendeeMerge({
        decision: {
          answers: {},
          bookings: {},
          pii: { name: "source" },
          version: diff.version,
        },
        diff,
        privateKey: await getTestPrivateKey(),
        sourceId: source.id,
        sourcePii: {
          address: "",
          email: "bob@test.com",
          name: "Bob",
          phone: "",
          special_instructions: "",
        },
        targetId: target.id,
        targetPii: {
          address: "",
          email: "alice@test.com",
          name: "Alice",
          payment_id: target.payment_id,
          phone: "",
          special_instructions: "",
          ticket_token: target.ticket_token,
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
