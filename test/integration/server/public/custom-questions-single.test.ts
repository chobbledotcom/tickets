import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { getAllModifiers } from "#db/modifiers.ts";
import { getAttendeeAnswersBatch } from "#db/questions/attendee-answers/reads.ts";
import { sql } from "#db/sql.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { createDailyListing } from "#test/integration/server/public/daily-listing.ts";
import {
  expectFlash,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { seedQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { setupAnswerTier } from "#test-utils/modifiers.ts";

describeWithEnv(
  "server public > custom questions (single ticket)",
  { db: true, triggers: true },
  () => {
    describe("single-ticket with custom questions", () => {
      /** Create a question with answers and assign it to an listing */
      const setupQuestionForListing = async (listingId: number) => {
        const {
          answers: [answer1, answer2],
          question,
        } = await seedQuestion({
          answers: ["Small", "Large"],
          listingIds: [listingId],
          text: "T-shirt size?",
        });
        return { answer1, answer2, question };
      };

      test("saves answers when question is answered correctly", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "",
        });
        const { question, answer1 } = await setupQuestionForListing(listing.id);

        const response = await submitTicketForm(listing.slug, {
          email: "question@example.com",
          name: "Question User",
          [`question_${question.id}`]: String(answer1.id),
        });
        expectReservedRedirectWithTokens(response);

        // Verify answers were saved
        const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
        const attendees = await getAttendeesRaw(listing.id);
        const batch = await getAttendeeAnswersBatch([attendees[0]!.id], {
          texts: false,
        });
        expect(batch.get(attendees[0]!.id)).toEqual([answer1.id]);
      });

      test("records the answer as the answer at booking", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "",
        });
        const { question, answer2 } = await setupQuestionForListing(listing.id);

        await submitTicketForm(listing.slug, {
          email: "record@example.com",
          name: "Record User",
          [`question_${question.id}`]: String(answer2.id),
        });

        const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
        const [attendee] = await getAttendeesRaw(listing.id);
        expect(
          await queryAll(
            sql`SELECT question_id, answer_id FROM answers_at_booking WHERE attendee_id = ${attendee!.id}`,
          ),
        ).toEqual([{ answer_id: answer2.id, question_id: question.id }]);
      });

      test("blocks the booking when a sold-out answer tier is selected", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        // A stock-limited answer tier with no stock left, linked to "Small".
        const { answerId, questionId } = await setupAnswerTier(listing);

        const response = await submitTicketForm(listing.slug, {
          email: "vip@example.com",
          name: "VIP User",
          [`question_${questionId}`]: String(answerId),
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("no longer available"),
          false,
        );
      });

      test("a provider-less booking consumes answer-tier stock, blocking the next over it", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "",
        });
        // Payments are disabled here, so bookings are taken without charging — but
        // a stock-limited answer tier must still be consumed so it can't be
        // over-sold across bookings.
        const { answerId, modifierId, questionId } = await setupAnswerTier(
          listing,
          { stock: 1 },
        );

        const first = await submitTicketForm(listing.slug, {
          email: "first@example.com",
          name: "First",
          [`question_${questionId}`]: String(answerId),
        });
        expectReservedRedirectWithTokens(first);
        // A redirect is not an indexable page: only 2xx answers carry
        // index, follow.
        expect(first.headers.get("x-robots-tag")).toBe("noindex, nofollow");

        // The unit was consumed. With no payment provider nothing is collected up
        // front, but the booking owes the tier's £5.00 and records it on the ledger
        // (a surcharge leg, attendee→modifier), exactly as a zero-deposit
        // reservation's would be. total_revenue now projects that net balance —
        // balanceOf(modifier) = +£5.00 — read directly from the ledger.
        const afterFirst = (await getAllModifiers()).find(
          (m) => m.id === modifierId,
        );
        expect(afterFirst?.totalUses).toBe(1);
        expect(afterFirst?.totalRevenue).toBe(500);

        // The single unit is now spent, so the next booking of the tier is blocked.
        const second = await submitTicketForm(listing.slug, {
          email: "second@example.com",
          name: "Second",
          [`question_${questionId}`]: String(answerId),
        });
        expect(second.status).toBe(302);
        expectFlash(
          second,
          expect.stringContaining("no longer available"),
          false,
        );
      });

      test("returns error when required question is unanswered", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        await setupQuestionForListing(listing.id);

        const response = await submitTicketForm(listing.slug, {
          email: "question@example.com",
          name: "Question User",
          // No question answer provided
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Please answer"), false);
      });

      test("returns error when answer ID is invalid", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const { question } = await setupQuestionForListing(listing.id);

        const response = await submitTicketForm(listing.slug, {
          email: "question@example.com",
          name: "Question User",
          [`question_${question.id}`]: "99999",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Invalid answer for"),
          false,
        );
      });

      test("daily listing parses date after question validation", async () => {
        const today = todayInTz("UTC");
        const validDate = addDays(testDate(today), 1);
        const listing = await createDailyListing({
          maxAttendees: 50,
          thankYouUrl: "",
        });
        const { question, answer1 } = await setupQuestionForListing(listing.id);

        const response = await submitTicketForm(listing.slug, {
          date: validDate,
          email: "dailyq@example.com",
          name: "Daily Q User",
          [`question_${question.id}`]: String(answer1.id),
        });
        expectReservedRedirectWithTokens(response);
      });
    });
  },
);
