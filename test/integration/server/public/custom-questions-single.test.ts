// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import {
  getAllModifiers,
  modifiersTable,
  setModifierAnswers,
} from "#shared/db/modifiers.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import { todayInTz } from "#shared/timezone.ts";
import { createDailyListing } from "#test/lib/server-public/daily-listing.ts";
import {
  expectFlash,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > custom questions (single ticket)",
  { db: true, triggers: true },
  () => {
    describe("single-ticket with custom questions", () => {
      /** Create a question with answers and assign it to an listing */
      const setupQuestionForListing = async (listingId: number) => {
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "T-shirt size?",
        });
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
        await listingQuestions.setIds(listingId, [q.id]);
        return { answer1: a1, answer2: a2, question: q };
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
        const { getAttendeesRaw } = await import(
          "#shared/db/attendees/queries.ts"
        );
        const attendees = await getAttendeesRaw(listing.id);
        const batch = await getAttendeeAnswersBatch([attendees[0]!.id], {
          texts: false,
        });
        expect(batch.get(attendees[0]!.id)).toEqual([answer1.id]);
      });

      test("blocks the booking when a sold-out answer tier is selected", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const { question, answer1 } = await setupQuestionForListing(listing.id);
        // A stock-limited answer tier with no stock left, linked to "Small".
        const tier = await modifiersTable.insert({
          calcKind: "fixed",
          calcValue: 5,
          direction: "charge",
          name: "VIP upgrade",
          stock: 0,
          trigger: "answer",
        });
        await setModifierAnswers(tier.id, [answer1.id]);

        const response = await submitTicketForm(listing.slug, {
          email: "vip@example.com",
          name: "VIP User",
          [`question_${question.id}`]: String(answer1.id),
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
        const { question, answer1 } = await setupQuestionForListing(listing.id);
        // Payments are disabled here, so bookings are taken without charging — but
        // a stock-limited answer tier must still be consumed so it can't be
        // over-sold across bookings.
        const tier = await modifiersTable.insert({
          calcKind: "fixed",
          calcValue: 5,
          direction: "charge",
          name: "VIP upgrade",
          stock: 1,
          trigger: "answer",
        });
        await setModifierAnswers(tier.id, [answer1.id]);

        const first = await submitTicketForm(listing.slug, {
          email: "first@example.com",
          name: "First",
          [`question_${question.id}`]: String(answer1.id),
        });
        expectReservedRedirectWithTokens(first);

        // The unit was consumed. With no payment provider nothing is collected up
        // front, but the booking owes the tier's £5.00 and records it on the ledger
        // (a surcharge leg, attendee→modifier), exactly as a zero-deposit
        // reservation's would be. total_revenue now projects that net balance —
        // balanceOf(modifier) = +£5.00 — read directly from the ledger.
        const afterFirst = (await getAllModifiers()).find(
          (m) => m.id === tier.id,
        );
        expect(afterFirst?.total_uses).toBe(1);
        expect(afterFirst?.total_revenue).toBe(500);

        // The single unit is now spent, so the next booking of the tier is blocked.
        const second = await submitTicketForm(listing.slug, {
          email: "second@example.com",
          name: "Second",
          [`question_${question.id}`]: String(answer1.id),
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
        const validDate = addDays(today, 1);
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
