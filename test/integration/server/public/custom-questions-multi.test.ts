import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeeAnswersBatch } from "#db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import {
  expectAttendeeCounts,
  expectFlash,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import { submitMultiTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createNamedListingPair } from "#test-utils/db-helpers/listing-pair-named.ts";
import { createQuestionWithAnswerPair } from "#test-utils/db-helpers/question-answer-pair.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";

/** The multi-listing attendee `listingId` shares, and the set of answer ids
 * saved on it — the shared "look up what got recorded" step behind every
 * multi-listing custom-question assertion below. */
const getSharedAttendeeAnswers = async (
  listingId: number,
): Promise<number[]> => {
  const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
  const attendees = await getAttendeesRaw(listingId);
  const attendeeId = attendees[0]!.id;
  const batch = await getAttendeeAnswersBatch([attendeeId], { texts: false });
  return batch.get(attendeeId) ?? [];
};

describeWithEnv(
  "server public > custom questions (ticket)",
  { db: true, triggers: true },
  () => {
    describe("ticket with custom questions", () => {
      /** A two-answer question on each listing, so one answer choice can be
       *  selected per listing. */
      const setupQuestionForListings = async (listingIds: number[]) => {
        const { a1, a2, q } = await createQuestionWithAnswerPair(
          "Dietary needs?",
          ["None", "Vegetarian"],
        );
        for (const eid of listingIds) {
          await listingQuestions.setIds(eid, [q.id]);
        }
        return { answer1: a1, answer2: a2, question: q };
      };

      test("saves answers for all attendees in ticket reservation", async () => {
        const [listing1, listing2] = await createNamedListingPair(
          ["Multi Q1", "Multi Q2"],
          { maxAttendees: 50, maxQuantity: 5 },
        );
        const { question, answer1 } = await setupQuestionForListings([
          listing1.id,
          listing2.id,
        ]);

        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "multiq@example.com",
          name: "Multi Q User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${question.id}`]: String(answer1.id),
        });
        expectReservedRedirectWithTokens(response);

        // With multi-listing attendees, both listings share one attendee.
        // The shared question's answer is saved once on the attendee.
        expect(await getSharedAttendeeAnswers(listing1.id)).toEqual([
          answer1.id,
        ]);
      });

      test("saves listing-specific answers only for each attendee", async () => {
        const [listing1, listing2] = await createNamedListingPair(
          ["Multi Evt A", "Multi Evt B"],
          { maxAttendees: 50, maxQuantity: 5 },
        );
        // Question 1 assigned to listing1 only
        const q1 = await createQuestionWithAnswer([listing1.id]);
        // Question 2 assigned to listing2 only
        const q2 = await createQuestionWithAnswer([listing2.id]);

        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "perlisting@example.com",
          name: "Per Listing User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${q1.questionId}`]: String(q1.answerId),
          [`question_${q2.questionId}`]: String(q2.answerId),
        });
        expectReservedRedirectWithTokens(response);

        // With multi-listing attendees, one attendee is linked to both listings.
        // Both listings' answers are stored on the same attendee.
        const answers = await getSharedAttendeeAnswers(listing1.id);
        assertArrayIncludes(answers, [q1.answerId]);
        assertArrayIncludes(answers, [q2.answerId]);
      });

      test("skips non-selected listings in listing answer map", async () => {
        const [listing1, listing2] = await createNamedListingPair(
          ["Multi Q Shared 1", "Multi Q Shared 2"],
          { maxAttendees: 50, maxQuantity: 5 },
        );
        // Question assigned to BOTH listings
        const q1 = await createQuestionWithAnswer([listing1.id, listing2.id]);

        const slug = `${listing1.slug}+${listing2.slug}`;
        // Only select listing1, skip listing2
        const response = await submitMultiTicketForm(slug, {
          email: "shared@example.com",
          name: "Shared Q User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "0",
          [`question_${q1.questionId}`]: String(q1.answerId),
        });
        expectReservedRedirectWithTokens(response);

        // Verify answer saved only for listing1's attendee
        await expectAttendeeCounts([
          { count: 1, listingId: listing1.id },
          { count: 0, listingId: listing2.id },
        ]);
        expect(await getSharedAttendeeAnswers(listing1.id)).toEqual([
          q1.answerId,
        ]);
      });

      test("validates question answers for selected listings only", async () => {
        const [listing1, listing2] = await createNamedListingPair(
          ["Multi Q Filter 1", "Multi Q Filter 2"],
          { maxAttendees: 50 },
        );
        // Only assign question to listing1
        await createQuestionWithAnswer([listing1.id]);

        // Select only listing2 (no question assigned) - should succeed without answer
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "filter@example.com",
          name: "Filter User",
          [`quantity_${listing1.id}`]: "0",
          [`quantity_${listing2.id}`]: "1",
        });
        expectReservedRedirectWithTokens(response);
      });

      test("returns error when ticket question is unanswered", async () => {
        const [listing1, listing2] = await createNamedListingPair(
          ["Multi Q Error 1", "Multi Q Error 2"],
          { maxAttendees: 50 },
        );
        await setupQuestionForListings([listing1.id]);

        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "error@example.com",
          name: "Error User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "0",
          // No question answer provided
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Please answer"), false);
      });
    });
  },
);
