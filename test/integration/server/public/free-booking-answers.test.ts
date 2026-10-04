import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getDb, queryAll } from "#db/client.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { expectReservedRedirectWithTokens } from "#test-utils/assertions.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectNoAttendeesForListings } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "server public > free booking answer atomicity",
  { db: true, triggers: true },
  () => {
    const setupChoiceQuestion = async (listingId: number) => {
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "T-shirt size?",
      });
      const answer = await answersTable.insert({
        questionId: question.id,
        sortOrder: 0,
        text: "Small",
      });
      await listingQuestions.setIds(listingId, [question.id]);
      return { answer, question };
    };

    /** Abort the answers write for one chosen answer, the way a real write
     * failure lands: mid-statement, inside whatever boundary carries it. */
    const rejectAnswerInsert = async (answerId: number): Promise<void> => {
      await getDb().execute(
        `CREATE TRIGGER test_reject_free_answers
           BEFORE INSERT ON attendee_answers
           WHEN NEW.answer_id = ${answerId}
           BEGIN
             SELECT RAISE(ABORT, 'answers write failed');
           END`,
      );
    };

    test("rolls the whole free booking back when the answers write fails", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "",
      });
      const { answer, question } = await setupChoiceQuestion(listing.id);
      await rejectAnswerInsert(answer.id);

      // A loud database failure: the answers write aborts, the whole
      // reservation rolls back with it, and the error surfaces.
      await expect(
        submitTicketForm(listing.slug, {
          email: "atomic@example.com",
          name: "Atomic User",
          [`question_${question.id}`]: String(answer.id),
        }),
      ).rejects.toThrow("answers write failed");
      await expectNoAttendeesForListings([listing.id]);
      expect(
        await queryAll(
          "SELECT id FROM listing_attendees WHERE listing_id = ?",
          [listing.id],
        ),
      ).toEqual([]);
    });

    test("saves choice answers in the same boundary as the booking", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "",
      });
      const { answer, question } = await setupChoiceQuestion(listing.id);

      const response = await submitTicketForm(listing.slug, {
        email: "choice@example.com",
        name: "Choice User",
        [`question_${question.id}`]: String(answer.id),
      });
      expectReservedRedirectWithTokens(response);

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toHaveLength(1);
      expect(
        await queryAll(
          "SELECT answer_id FROM attendee_answers WHERE attendee_id = ?",
          [attendees[0]!.id],
        ),
      ).toEqual([{ answer_id: answer.id }]);
      expect(
        await queryAll(
          "SELECT answer_id FROM answers_at_booking WHERE attendee_id = ?",
          [attendees[0]!.id],
        ),
      ).toEqual([{ answer_id: answer.id }]);
    });

    test("saves free-text answers in the same boundary as the booking", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "",
      });
      const question = await questionsTable.insert({
        displayType: "free_text",
        text: "Anything we should know?",
      });
      await listingQuestions.setIds(listing.id, [question.id]);

      const response = await submitTicketForm(listing.slug, {
        email: "text@example.com",
        name: "Text User",
        [`question_${question.id}`]: "Arrives by bike",
      });
      expectReservedRedirectWithTokens(response);

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toHaveLength(1);
      expect(
        await queryAll(
          "SELECT string_id FROM attendee_answers WHERE attendee_id = ?",
          [attendees[0]!.id],
        ),
      ).toEqual([{ string_id: expect.any(Number) }]);
      expect(
        await queryAll(
          "SELECT free_text_index FROM answers_at_booking WHERE attendee_id = ?",
          [attendees[0]!.id],
        ),
      ).toEqual([{ free_text_index: expect.any(String) }]);
    });
  },
);
